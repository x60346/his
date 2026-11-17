// 護理排班與責任分床：
//   - 班表：每個病房每天三班排哪些護理師（權限「護理排班」，預設管理員、指定給護理長），一次看一個月、可以複製上個月（照 4 週前同一個星期幾）；
//     護病比超過上限標紅、不擋；上限在這裡由管理員調整
//   - 分床：這一班把病人分給上班的護理師（這班上班的人或有排班權限的人都可以分）
import type { NurseAssignment, StaffingSettings } from '@/types'
import { db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, failFields, mutate, permissionsOf, query, requirePermission, requireUser } from './http'
import { find, nameOf } from './views'
import { checkRatio, copySourceOf, monthDates, SHIFTS, type ShiftName } from './staffing-rules'
import { onDuty, ratioOf, shiftNow, staffingOf, wardAdmissions, type ShiftRef } from './staffing-work'

const allWards = () => [...new Set(db.beds.map((b) => b.ward))]
const checkWard = (ward: string) => {
  if (!allWards().includes(ward)) fail(`找不到病房「${ward}」`)
}
const activeNurses = () => db.users.filter((u) => u.active && u.roles.includes('nurse'))
const canSchedule = () => {
  const u = requireUser()
  return permissionsOf(u).includes('nursing.schedule')
}

export interface ScheduleCell {
  shift: ShiftName
  nurses: { id: string; name: string }[]
  /** 今天和以後的班才估護病比（用目前住院人數） */
  ratio?: { text: string; over: boolean }
}

export interface MonthSchedule {
  ward: string
  month: string
  days: { date: string; cells: ScheduleCell[] }[]
  nurses: { id: string; name: string; username: string }[]
  ratio: StaffingSettings['ratio']
  canEdit: boolean
  canEditRatio: boolean
  /** 現在這一班（畫面標出來） */
  current: ShiftRef
}

export function getSchedule(ward: string, month: string): Promise<MonthSchedule> {
  return query(() => {
    const u = requireUser('nurse', 'admin')
    checkWard(ward)
    if (!/^\d{4}-\d{2}$/.test(month)) failField('month', '月份格式 YYYY-MM')
    const t = now()
    return {
      ward, month,
      days: monthDates(month).map((date) => ({
        date,
        cells: SHIFTS.map((shift) => {
          const ns = onDuty(ward, { date, shift })
          return { shift, nurses: ns.map((id) => ({ id, name: nameOf.user(id) })), ...(date >= today() ? { ratio: (({ text, over }) => ({ text, over }))(staffingOf(ward, { date, shift })) } : {}) }
        }),
      })),
      nurses: activeNurses().map((x) => ({ id: x.id, name: x.name, username: x.username })),
      ratio: ratioOf(), canEdit: canSchedule(), canEditRatio: u.role === 'admin', current: shiftNow(t),
    }
  })
}

/** 排某一班的護理師（整班取代）：今天以後的才能改；同一天同一人只能上一個病房的一班 */
export function setShiftNurses(ward: string, date: string, shift: ShiftName, nurseIds: string[]): Promise<ScheduleCell> {
  return mutate(() => {
    const u = requirePermission('nursing.schedule')
    checkWard(ward)
    if (!SHIFTS.includes(shift)) failField('shift', '請選班別')
    if (date < today()) fail('過去的班不能改', 'CONFLICT')
    const ids = [...new Set(nurseIds)]
    for (const id of ids) {
      const n = db.users.find((x) => x.id === id)
      if (!n || !n.active || !n.roles.includes('nurse')) failField('nurseIds', '只能排在職的護理師')
      const clash = db.nurseShifts.find((x) => x.nurseId === id && x.date === date && !(x.ward === ward && x.shift === shift))
      if (clash) failField('nurseIds', `${n!.name} 這天已經排了 ${clash.ward} ${clash.shift}`)
    }
    db.nurseShifts = db.nurseShifts.filter((x) => !(x.ward === ward && x.date === date && x.shift === shift))
    for (const id of ids) db.nurseShifts.push({ id: newId('NSH'), ward, date, shift, nurseId: id })
    audit('護理排班', `${ward} ${date} ${shift}：${ids.map((id) => nameOf.user(id)).join('、') || '（不排）'}（${u.name}）`)
    const r = staffingOf(ward, { date, shift })
    return { shift, nurses: ids.map((id) => ({ id, name: nameOf.user(id) })), ratio: { text: r.text, over: r.over } }
  })
}

/** 複製上個月：這個月今天以後、還沒排的班，照 4 週前同一個星期幾那天排（已經排的不動；當天已排別班的人跳過） */
export function copyPreviousMonth(ward: string, month: string): Promise<{ copied: number }> {
  return mutate(() => {
    requirePermission('nursing.schedule')
    checkWard(ward)
    let copied = 0
    for (const date of monthDates(month).filter((d) => d >= today())) {
      for (const shift of SHIFTS) {
        if (onDuty(ward, { date, shift }).length) continue
        for (const id of onDuty(ward, { date: copySourceOf(date), shift })) {
          if (db.nurseShifts.some((x) => x.nurseId === id && x.date === date)) continue
          db.nurseShifts.push({ id: newId('NSH'), ward, date, shift, nurseId: id })
          copied++
        }
      }
    }
    audit('護理排班', `${ward} ${month}：複製上個月 ${copied} 人次`)
    return { copied }
  })
}

/** 護病比上限（管理員） */
export function saveRatio(ratio: StaffingSettings['ratio']): Promise<StaffingSettings['ratio']> {
  return mutate(() => {
    requireUser('admin')
    failFields(checkRatio(ratio))
    db.staffingSettings = { ratio: { 白班: ratio.白班, 小夜: ratio.小夜, 大夜: ratio.大夜 } }
    audit('護病比上限', SHIFTS.map((s) => `${s} 1:${ratio[s]}`).join('、'))
    return db.staffingSettings.ratio
  })
}

export interface WardAssignments extends ShiftRef {
  ward: string
  nurses: { id: string; name: string; me: boolean; count: number }[]
  patients: { admissionId: string; bedNo: string; patientName: string; nurseId?: string }[]
  ratio: { text: string; over: boolean }
  canAssign: boolean
}

/** 這一班的分床（護理站） */
export function getAssignments(ward: string): Promise<WardAssignments> {
  return query(() => {
    const u = requireUser('nurse', 'admin')
    checkWard(ward)
    const v = assignmentsOf(ward, u.id)
    return { ...v, canAssign: v.nurses.some((n) => n.me) || canSchedule() }
  })
}

/** 分床（這一班）：只能分給這班在這個病房上班的護理師；沒列到的病人維持原樣；nurseId 空字串＝取消 */
export function assignPatients(ward: string, map: Record<string, string>): Promise<WardAssignments> {
  return mutate(() => {
    const u = requireUser('nurse', 'admin')
    checkWard(ward)
    const t = now()
    const s = shiftNow(t)
    const duty = onDuty(ward, s)
    if (!duty.includes(u.id) && !canSchedule()) fail('這一班在這個病房上班的護理師（或護理長）才能分床', 'FORBIDDEN')
    const ids = new Set(wardAdmissions(ward).map((a) => a.id))
    for (const [aid, nid] of Object.entries(map)) {
      if (!ids.has(aid)) fail('病人不在這個病房')
      if (nid && !duty.includes(nid)) failField('nurseId', `${nameOf.user(nid)} 這一班沒有排在 ${ward}`)
      db.nurseAssignments = db.nurseAssignments.filter((x) => !(x.admissionId === aid && x.date === s.date && x.shift === s.shift))
      if (nid) db.nurseAssignments.push({ id: newId('NAS'), ward, date: s.date, shift: s.shift, admissionId: aid, nurseId: nid, by: u.id, at: t } satisfies NurseAssignment)
    }
    audit('責任分床', `${ward} ${s.date} ${s.shift}：${Object.keys(map).length} 位病人`)
    return assignmentsOf(ward, u.id)
  })
}

function assignmentsOf(ward: string, me: string): WardAssignments {
  const s = shiftNow(now())
  const st = staffingOf(ward, s)
  const asg = db.nurseAssignments.filter((x) => x.ward === ward && x.date === s.date && x.shift === s.shift)
  const patients = wardAdmissions(ward).map((a) => ({ admissionId: a.id, bedNo: find.bed(a.bedId!)?.bedNo ?? '', patientName: nameOf.patient(a.patientId), ...(asg.find((x) => x.admissionId === a.id) ? { nurseId: asg.find((x) => x.admissionId === a.id)!.nurseId } : {}) })).sort((x, y) => x.bedNo.localeCompare(y.bedNo))
  return { ward, ...s, ratio: { text: st.text, over: st.over }, nurses: st.nurses.map((id) => ({ id, name: nameOf.user(id), me: id === me, count: patients.filter((p) => p.nurseId === id).length })), patients, canAssign: true }
}

