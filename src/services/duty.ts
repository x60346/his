// 醫師值班表：有權限（duty.schedule）的人排各科每天的值班醫師（只能排那一科的醫師）；大家都看得到現在誰值班。
// 規則在 duty-rules
import type { DutyShift, ProgressNote } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failField, mutate, permissionsOf, query, requirePermission, requireUser, sessionRole } from './http'
import { find, nameOf } from './views'
import { DUTY_DEPTS, dutyDateOf as dutyDateOfNow, dutyHoursText, isOffHours, onCallFor } from './duty-rules'
import { careRoleOf } from './care-team'
import { shiftCallStats, shiftDateOf } from './doctor-call-work'

export interface DutyRoster {
  from: string
  canEdit: boolean
  depts: { id: string; name: string; doctors: { id: string; name: string }[] }[]
  days: { date: string; hoursText: string; cells: { deptId: string; userId?: string; name?: string }[] }[]
  /** 現在（下班時間）各科的值班醫師；上班時間是空的 */
  now: { offHours: boolean; onCall: { deptName: string; name: string }[] }
  /** 這一班（白天看昨晚那一班）各科值班醫師被護理站呼叫幾次：有排值班的科 */
  shiftCalls: { date: string; hoursText: string; rows: ({ deptName: string; name: string } & ReturnType<typeof shiftCallStats>)[] }
}

const deptDoctors = (deptId: string) =>
  db.users.filter((u) => u.active && u.doctorId && find.doctor(u.doctorId)?.deptId === deptId).map((u) => ({ id: u.id, name: u.name }))

export function dutyRoster(from: string = today(), days = 7): Promise<DutyRoster> {
  return query(() => {
    const u = requireUser('doctor', 'nurse', 'admin', 'clerk', 'lab', 'pharmacist', 'radtech')
    const t = now()
    return {
      from,
      canEdit: permissionsOf({ ...u, role: sessionRole()! }).includes('duty.schedule'),
      depts: DUTY_DEPTS.map((id) => ({ id, name: nameOf.dept(id), doctors: deptDoctors(id) })),
      days: Array.from({ length: days }, (_, i) => addDays(from, i)).map((date) => ({
        date, hoursText: dutyHoursText(date),
        cells: DUTY_DEPTS.map((deptId) => ((s) => ({ deptId, ...(s ? { userId: s.userId, name: nameOf.user(s.userId) } : {}) }))(db.dutyShifts.find((x) => x.date === date && x.deptId === deptId))),
      })),
      shiftCalls: ((date) => ({
        date, hoursText: dutyHoursText(date),
        rows: DUTY_DEPTS.flatMap((d) => ((s) => (s ? [{ deptName: nameOf.dept(d), name: nameOf.user(s.userId), ...shiftCallStats(date, d) }] : []))(db.dutyShifts.find((x) => x.date === date && x.deptId === d))),
      }))(shiftDateOf(t)),
      now: { offHours: isOffHours(t), onCall: DUTY_DEPTS.flatMap((d) => ((s) => (s ? [{ deptName: nameOf.dept(d), name: nameOf.user(s.userId) }] : []))(onCallFor(db.dutyShifts, d, t))) },
    }
  })
}

/** 排一格（userId 空＝清掉）：只能排那一科的醫師；不能改過去的日子 */
export function setDuty(input: { date: string; deptId: string; userId?: string }): Promise<{ ok: true }> {
  return mutate(() => {
    const u = requirePermission('duty.schedule')
    if (!DUTY_DEPTS.includes(input.deptId)) failField('deptId', '這一科不用排值班')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')) failField('date', '請選日期')
    if (input.date < today()) fail('不能改過去的值班', 'CONFLICT')
    const cur = db.dutyShifts.find((x) => x.date === input.date && x.deptId === input.deptId)
    const label = `${input.date} ${nameOf.dept(input.deptId)}`
    if (!input.userId) {
      if (cur) { db.dutyShifts = db.dutyShifts.filter((x) => x !== cur); audit('醫師值班', `${label}：清掉 ${nameOf.user(cur.userId)}`) }
      return { ok: true as const }
    }
    if (!deptDoctors(input.deptId).some((d) => d.id === input.userId)) failField('userId', `請選${nameOf.dept(input.deptId)}的醫師`)
    if (cur) Object.assign(cur, { userId: input.userId, by: u.id, at: now() })
    else db.dutyShifts.push({ id: newId('DT'), date: input.date, deptId: input.deptId, userId: input.userId!, by: u.id, at: now() } as DutyShift)
    audit('醫師值班', `${label}：${nameOf.user(input.userId!)}`)
    return { ok: true as const }
  })
}

// ---------- 值班紀錄：值班醫師夜間處理的事，交給隔天的主治 ----------

/** 寫值班紀錄（只有這一科現在的值班醫師、下班時間）：發生什麼、怎麼處理、交代主治的事；寫進病程紀錄（值班紀錄） */
export function addDutyNote(input: { admissionId: string; event: string; action: string; handover?: string }): Promise<ProgressNote> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = db.admissions.find((x) => x.id === input.admissionId)
    if (!a || a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
    const t = now()
    const s = onCallFor(db.dutyShifts, a!.deptId, t)
    if (!s || s.userId !== u.id) fail(isOffHours(t) ? `你現在不是${nameOf.dept(a!.deptId)}的值班醫師` : '上班時間請寫一般病程紀錄（值班紀錄是下班時間值班醫師寫的）', 'FORBIDDEN')
    if (!input.event?.trim()) failField('event', '請寫發生什麼事（例：02:10 發燒 38.9°C、血壓 88/50）')
    if (!input.action?.trim()) failField('action', '請寫怎麼處理（例：抽血培養、給 NS 500 mL、改抗生素）')
    const n: ProgressNote = {
      id: newId('PN'), admissionId: a!.id, at: t, doctorId: u.doctorId ?? a!.doctorId, kind: 'duty',
      items: [{ label: '事件', text: input.event.trim() }, { label: '處理', text: input.action.trim() }, ...(input.handover?.trim() ? [{ label: '交代主治', text: input.handover.trim() }] : [])],
      subjective: '', objective: '', assessment: '', plan: '',
    }
    db.progressNotes.push(n)
    audit('值班紀錄', `${a!.admitNo} ${nameOf.patient(a!.patientId)}：${input.event.trim().slice(0, 40)}`)
    return n
  })
}

/** 這次住院還沒看過的值班紀錄（主治、同科醫師看） */
export function unreadDutyNotes(admissionId: string): Promise<(ProgressNote & { doctorName: string })[]> {
  return query(() => {
    requireUser('doctor', 'nurse')
    return db.progressNotes.filter((n) => n.admissionId === admissionId && n.kind === 'duty' && !n.dutyAck).sort((x, y) => x.at.localeCompare(y.at)).map((n) => ({ ...n, doctorName: nameOf.doctor(n.doctorId) }))
  })
}

/** 看過值班紀錄（主治或同科醫師；一次這位病人全部） */
export function ackDutyNotes(admissionId: string): Promise<{ count: number }> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = db.admissions.find((x) => x.id === admissionId)
    if (!a) fail('找不到住院紀錄', 'NOT_FOUND')
    if (careRoleOf(u.doctorId, a!)?.kind !== 'team') fail('主治或同科醫師才能確認值班紀錄', 'FORBIDDEN')
    const list = db.progressNotes.filter((n) => n.admissionId === a!.id && n.kind === 'duty' && !n.dutyAck)
    if (!list.length) fail('沒有要確認的值班紀錄', 'CONFLICT')
    for (const n of list) n.dutyAck = { at: now(), by: u.id }
    audit('值班紀錄已看', `${a!.admitNo} ${nameOf.patient(a!.patientId)}：${list.length} 筆`)
    return { count: list.length }
  })
}

/** 我今晚（這一班）值哪幾科、那幾科住院中幾位（首頁） */
export function myDutyTonight(): Promise<{ date: string; depts: { deptId: string; name: string; inpatients: number }[] } | undefined> {
  return query(() => {
    const u = requireUser('doctor')
    const t = now()
    // 白天看今晚的班；下班時間看這一班
    const date = isOffHours(t) ? dutyDateOfNow(t) : t.slice(0, 10)
    const mine = db.dutyShifts.filter((s) => s.userId === u.id && s.date === date)
    if (!mine.length) return undefined
    return { date, depts: mine.map((s) => ({ deptId: s.deptId, name: nameOf.dept(s.deptId), inpatients: db.admissions.filter((a) => a.status === 'admitted' && a.deptId === s.deptId && !a.obs).length })) }
  })
}

/** 住院醫囑頁：這位病人還沒看過的值班紀錄、我能不能寫（現在是這一科的值班醫師）、能不能按已看（主治或同科） */
export function dutyNotesState(admissionId: string): Promise<{ unread: (ProgressNote & { doctorName: string })[]; canWrite: boolean; canAck: boolean }> {
  return query(() => {
    const u = requireUser('doctor', 'nurse')
    const a = db.admissions.find((x) => x.id === admissionId)
    if (!a) return { unread: [], canWrite: false, canAck: false }
    const s = a.status === 'admitted' ? onCallFor(db.dutyShifts, a.deptId, now()) : undefined
    return {
      unread: db.progressNotes.filter((n) => n.admissionId === a.id && n.kind === 'duty' && !n.dutyAck).sort((x, y) => x.at.localeCompare(y.at)).map((n) => ({ ...n, doctorName: nameOf.doctor(n.doctorId) })),
      canWrite: !!s && s.userId === u.id,
      canAck: sessionRole() === 'doctor' && careRoleOf(u.doctorId, a)?.kind === 'team',
    }
  })
}

/** 現在誰值班（護理站、櫃台找人）：下班時間列各科值班醫師；上班時間 offHours false（找主治） */
export function onCallNow(): Promise<{ offHours: boolean; list: { deptId: string; deptName: string; name: string }[] }> {
  return query(() => {
    requireUser('doctor', 'nurse', 'admin', 'clerk', 'lab', 'radtech', 'pharmacist')
    const t = now()
    return { offHours: isOffHours(t), list: DUTY_DEPTS.flatMap((d) => ((s) => (s ? [{ deptId: d, deptName: nameOf.dept(d), name: nameOf.user(s.userId) }] : []))(onCallFor(db.dutyShifts, d, t))) }
  })
}
