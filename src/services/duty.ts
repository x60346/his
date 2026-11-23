// 醫師值班表：有權限（duty.schedule）的人排各科每天的值班醫師（只能排那一科的醫師）；大家都看得到現在誰值班。
// 規則在 duty-rules
import type { DutyShift } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failField, mutate, permissionsOf, query, requirePermission, requireUser, sessionRole } from './http'
import { find, nameOf } from './views'
import { DUTY_DEPTS, dutyHoursText, isOffHours, onCallFor } from './duty-rules'

export interface DutyRoster {
  from: string
  canEdit: boolean
  depts: { id: string; name: string; doctors: { id: string; name: string }[] }[]
  days: { date: string; hoursText: string; cells: { deptId: string; userId?: string; name?: string }[] }[]
  /** 現在（下班時間）各科的值班醫師；上班時間是空的 */
  now: { offHours: boolean; onCall: { deptName: string; name: string }[] }
}

const deptDoctors = (deptId: string) =>
  db.users.filter((u) => u.active && u.doctorId && find.doctor(u.doctorId)?.deptId === deptId).map((u) => ({ id: u.id, name: u.name }))

export function dutyRoster(from: string = today(), days = 7): Promise<DutyRoster> {
  return query(() => {
    const u = requireUser('doctor', 'nurse', 'admin', 'clerk', 'lab')
    const t = now()
    return {
      from,
      canEdit: permissionsOf({ ...u, role: sessionRole()! }).includes('duty.schedule'),
      depts: DUTY_DEPTS.map((id) => ({ id, name: nameOf.dept(id), doctors: deptDoctors(id) })),
      days: Array.from({ length: days }, (_, i) => addDays(from, i)).map((date) => ({
        date, hoursText: dutyHoursText(date),
        cells: DUTY_DEPTS.map((deptId) => ((s) => ({ deptId, ...(s ? { userId: s.userId, name: nameOf.user(s.userId) } : {}) }))(db.dutyShifts.find((x) => x.date === date && x.deptId === deptId))),
      })),
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
