// 病歷完整性的內部工具（index 不匯出、不會被包成 API）：一次住院的完整性輸入、出院清單、首頁計數。API 在 record-audit.ts、規則在 record-audit-rules
import type { Admission } from '@/types'
import { db } from '@/mock/db'
import { recentShifts } from './nursing-rules'
import { NURSING_LOOKBACK_SHIFTS, noteDateOf, nursingGapShifts, progressGapDates, recordGaps, recordOverdue, stayProgressGaps, type RecordInput } from './record-audit-rules'
import { nameOf } from './views'

/** 出院的住院（急診留觀沒轉住院的不算） */
export const discharged = () => db.admissions.filter((a) => a.status === 'discharged' && a.dischargedAt && !(a.obs && a.obs.outcome !== 'admit'))

/** 一般病程紀錄（不含轉科摘要、會診等系統寫的） */
const soapNotes = (admissionId: string) => db.progressNotes.filter((n) => n.admissionId === admissionId && !n.kind)

/** 出院的住院：整段住院缺病程紀錄的日期（日間手術當天出院、沒有） */
export const stayGapsOf = (a: Admission) => (a.admittedAt && a.dischargedAt && !(a.day && !a.day.converted) ? stayProgressGaps(a.admittedAt, a.dischargedAt, soapNotes(a.id).map(noteDateOf)) : [])

/** 一次住院的完整性輸入 */
export function recordInputOf(a: Admission): RecordInput {
  const lastLateAt = soapNotes(a.id).filter((n) => n.lateFor).map((n) => n.at).sort().at(-1)
  return {
    progress: { gaps: stayGapsOf(a), ...(lastLateAt ? { lastLateAt } : {}) },
    day: !!a.day && !a.day.converted, dischargedAt: a.dischargedAt ?? '',
    ...(a.dischargeSummary ? { summary: { ...(a.dischargeSummary.signedAt ? { signedAt: a.dischargeSummary.signedAt } : {}) } } : {}),
    surgeries: db.surgeries.filter((s) => s.admissionId === a.id && s.status === 'done').map((s) => ({ no: s.no, ...(s.record ? { recordAt: s.record.at } : {}) })),
    ...(a.death ? { death: { manner: a.death.manner, ...(a.death.cert ? { certAt: a.death.cert.issuedAt } : {}) } } : {}),
    consents: db.consents.filter((c) => c.admissionId === a.id && !c.revoked).map((c) => ({ no: c.no, ...(c.scan ? { scannedAt: c.scan.at } : {}) })),
    consults: db.consults.filter((c) => c.admissionId === a.id).map((c) => ({ dept: nameOf.dept(c.toDeptId), ...(c.answeredAt ? { answeredAt: c.answeredAt } : {}), ...(c.status === 'cancelled' ? { cancelled: true } : {}) })),
  }
}

/** 首頁：主治的病歷待完成、逾期；病歷室全院逾期 */
export function recordCounts(t: string, doctorId?: string) {
  const xs = discharged().filter((a) => !doctorId || a.doctorId === doctorId).map((a) => recordInputOf(a))
  return { incomplete: xs.filter((x) => recordGaps(x).length).length, overdue: xs.filter((x) => recordOverdue(x, t)).length }
}

/** 住院中（不含急診留觀中、日間手術）每日病程紀錄缺的日期 */
export function progressGapsOf(a: Admission, t: string): string[] {
  if (a.status !== 'admitted' || !a.admittedAt || (a.obs && !a.obs.endAt) || (a.day && !a.day.converted)) return []
  return progressGapDates(a.admittedAt, soapNotes(a.id).map(noteDateOf), t)
}
/** 首頁（主治）：我主治、住院中、最近 7 天有缺病程紀錄的病人數 */
export const progressMissingCount = (t: string, doctorId: string) => db.admissions.filter((a) => a.doctorId === doctorId && progressGapsOf(a, t).length).length

/** 住院中最近 6 個已結束的班，哪幾班沒有護理紀錄（現在這一班不算） */
export function nursingGapsOf(a: Admission, now: string): string[] {
  if (a.status !== 'admitted' || !a.admittedAt || (a.obs && !a.obs.endAt) || (a.day && !a.day.converted)) return []
  return nursingGapShifts(a.admittedAt, db.nursingNotes.filter((n) => n.admissionId === a.id).map((n) => n.at), now, recentShifts(now, NURSING_LOOKBACK_SHIFTS + 1).slice(1))
}
/** 首頁（護理師）：最近 6 班有缺護理紀錄的住院病人數 */
export const nursingMissingCount = (now: string) => db.admissions.filter((a) => nursingGapsOf(a, now).length).length
