// 病歷完整性的內部工具（index 不匯出、不會被包成 API）：一次住院的完整性輸入、出院清單、首頁計數。API 在 record-audit.ts、規則在 record-audit-rules
import type { Admission } from '@/types'
import { db } from '@/mock/db'
import { recordGaps, recordOverdue, type RecordInput } from './record-audit-rules'
import { nameOf } from './views'

/** 出院的住院（急診留觀沒轉住院的不算） */
export const discharged = () => db.admissions.filter((a) => a.status === 'discharged' && a.dischargedAt && !(a.obs && a.obs.outcome !== 'admit'))

/** 一次住院的完整性輸入 */
export function recordInputOf(a: Admission): RecordInput {
  return {
    day: !!a.day && !a.day.converted, dischargedAt: a.dischargedAt ?? '',
    ...(a.dischargeSummary ? { summary: { ...(a.dischargeSummary.signedAt ? { signedAt: a.dischargeSummary.signedAt } : {}) } } : {}),
    surgeries: db.surgeries.filter((s) => s.admissionId === a.id && s.status === 'done').map((s) => ({ no: s.no, ...(s.record ? { recordAt: s.record.at } : {}) })),
    ...(a.death ? { death: { manner: a.death.manner, ...(a.death.cert ? { certAt: a.death.cert.issuedAt } : {}) } } : {}),
    consults: db.consults.filter((c) => c.admissionId === a.id).map((c) => ({ dept: nameOf.dept(c.toDeptId), ...(c.answeredAt ? { answeredAt: c.answeredAt } : {}), ...(c.status === 'cancelled' ? { cancelled: true } : {}) })),
  }
}

/** 首頁：主治的病歷待完成、逾期；病歷室全院逾期 */
export function recordCounts(t: string, doctorId?: string) {
  const xs = discharged().filter((a) => !doctorId || a.doctorId === doctorId).map((a) => recordInputOf(a))
  return { incomplete: xs.filter((x) => recordGaps(x).length).length, overdue: xs.filter((x) => recordOverdue(x, t)).length }
}
