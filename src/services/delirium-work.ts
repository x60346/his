// 譫妄與約束的內部工具（index 不匯出、不會被包成 API）：誰要每班評、這班評了沒、約束待辦、首頁計數、出院收尾。規則在 delirium-rules
import type { Admission, DeliriumAssessment, Restraint } from '@/types'
import { db } from '@/mock/db'
import { addMinutes, ageOf } from '@/utils/date'
import { shiftRange } from './nursing-rules'
import { deliriumTarget, restraintState, type RestraintState } from './delirium-rules'
import { find } from './views'
import { careRoleOf } from './care-team'
import { inIcu } from './icu-work'
import { lastRass } from './vent-work'
import { CAM_ICU_RASS_MIN } from './vent-rules'

export const latestDelirium = (admissionId: string): DeliriumAssessment | undefined =>
  db.deliriumAssessments.filter((x) => x.admissionId === admissionId).reduce<DeliriumAssessment | undefined>((b, x) => (!b || x.at >= b.at ? x : b), undefined)

export function deliriumStateOf(a: Admission, t: string) {
  const p = find.patient(a.patientId)
  const lastOp = db.surgeries.filter((s) => s.admissionId === a.id && s.status === 'done' && s.endAt).map((s) => s.endAt!).sort().at(-1)
  // 加護病房：每個病人每班都評（CAM-ICU）；但最近 4 小時的 RASS ≤ −4（叫不醒）先不評——無法評估注意力
  const icu = inIcu(a)
  const r = icu ? lastRass(a.id, addMinutes(t, -4 * 60)) : undefined
  const tooDeep = !!r && r.rass! < CAM_ICU_RASS_MIN
  const target = icu ? (tooDeep ? undefined : '加護病房（CAM-ICU）') : p ? deliriumTarget(ageOf(p.birthDate, t.slice(0, 10)), lastOp, t) : undefined
  const latest = latestDelirium(a.id)
  return { target, latest, thisShift: !!latest && latest.at >= shiftRange(t).start, positive: !!latest?.positive, ...(tooDeep ? { rassSkip: `RASS ${r!.rass}（≤ −4）：這一班先不評 CAM` } : {}) }
}

export const activeRestraints = (admissionId: string): Restraint[] => db.restraints.filter((r) => r.admissionId === admissionId && !r.endedAt)

export interface RestraintTodo {
  restraintId: string
  /** check 查核（護理師）、order 醫囑待補或到期（醫師，護理站也看得到） */
  kind: 'check' | 'order'
  urgency: 'due' | 'overdue'
  at: string
  text: string
}

export function restraintTodosOf(admissionId: string, t: string): RestraintTodo[] {
  const out: RestraintTodo[] = []
  for (const r of activeRestraints(admissionId)) {
    const s: RestraintState = restraintState(r, t)
    if (s.check !== 'ok') out.push({ restraintId: r.id, kind: 'check', urgency: s.check, at: s.checkDueAt, text: `約束查核（${r.sites.join('、')}，每 2 小時）` })
    if (s.order === 'pending') out.push({ restraintId: r.id, kind: 'order', urgency: 'due', at: r.startedAt, text: '緊急約束：請醫師 1 小時內補醫囑' })
    if (s.order === 'missing') out.push({ restraintId: r.id, kind: 'order', urgency: 'overdue', at: r.startedAt, text: '緊急約束超過 1 小時沒有醫囑' })
    if (s.order === 'expired') out.push({ restraintId: r.id, kind: 'order', urgency: 'overdue', at: s.orderUntil!, text: '約束醫囑已到期：請醫師續開或解除' })
  }
  return out
}

/** 出院、結束留觀：約束一起解除 */
export function closeRestraints(a: Admission, by: string, t: string, reason = '出院'): void {
  for (const r of activeRestraints(a.id)) Object.assign(r, { endedAt: t, endedBy: by, endReason: reason })
}

/** 醫師首頁：本科住院病人譫妄陽性待確認、約束醫囑待補或到期 */
export function deliriumDoctorCounts(doctorId: string, t: string) {
  const mine = db.admissions.filter((a) => a.status === 'admitted' && (careRoleOf(doctorId, a)?.kind ?? 'consult') !== 'consult')
  return {
    positive: mine.filter((a) => { const l = latestDelirium(a.id); return !!l?.positive && !l.ackAt }).length,
    restraintOrder: mine.reduce((n, a) => n + restraintTodosOf(a.id, t).filter((x) => x.kind === 'order').length, 0),
  }
}
