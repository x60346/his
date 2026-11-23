// 出院準備的內部工具（index 不匯出、不會被包成 API）：系統自動判斷的條件、這次住院的出院準備、篩選與追蹤待辦。規則在 discharge-plan-rules
import type { Admission, DischargePlan } from '@/types'
import { db } from '@/mock/db'
import { addDays, ageOf } from '@/utils/date'
import { find } from './views'
import { followUpDue, planScreenDue } from './discharge-plan-rules'

export const planOf = (admissionId: string): DischargePlan | undefined => db.dischargePlans.find((p) => p.admissionId === admissionId)

/** 要篩選的住院：住院中、不是留觀中 */
export const plannable = (a: Admission) => a.status === 'admitted' && !!a.admittedAt && !(a.obs && !a.obs.endAt)

/** 系統能從資料判斷的條件：65 歲以上、身上有鼻胃管／導尿管／胃造口、出院 30 天內又住院 */
export function autoCriteria(a: Admission, t: string): string[] {
  const out: string[] = []
  const p = find.patient(a.patientId)
  if (p && ageOf(p.birthDate, t.slice(0, 10)) >= 65) out.push('age65')
  if (db.lines.some((l) => l.admissionId === a.id && !l.removedAt && ['ngt', 'foley', 'peg'].includes(l.kind))) out.push('lines')
  const start = a.admittedAt ?? a.reservedAt
  if (db.admissions.some((x) => x.id !== a.id && x.patientId === a.patientId && x.status === 'discharged' && !x.obs && x.dischargedAt && x.dischargedAt <= start && x.dischargedAt.slice(0, 10) >= addDays(start.slice(0, 10), -30))) out.push('readmit')
  return out
}

export const planScreenStateOf = (a: Admission, t: string) => planScreenDue(a.obs?.outcome === 'admit' && a.obs.endAt ? a.obs.endAt : a.admittedAt!, !!planOf(a.id), t)

/** 出院後要追蹤的（收案、已出院、還沒追蹤） */
export function followUpsDue(t: string) {
  return db.dischargePlans
    .filter((p) => p.enrolled && !p.followUp)
    .map((p) => ({ p, a: find.admission(p.admissionId)! }))
    // 死亡、轉院的不用打電話追蹤
    .filter(({ a }) => a?.status === 'discharged' && !!a.dischargedAt && a.dischargeType !== '死亡' && a.dischargeType !== '轉院')
    .map(({ p, a }) => ({ plan: p, admission: a, due: followUpDue(a.dischargedAt!, false, t) }))
}

export const planCounts = (t: string) => ({
  screenDue: db.admissions.filter(plannable).filter((a) => ['due', 'overdue'].includes(planScreenStateOf(a, t).status)).length,
  followUp: followUpsDue(t).length,
})
