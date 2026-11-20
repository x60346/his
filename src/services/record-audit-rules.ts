// 住院病歷完整性（純函式）：出院後病歷要在 14 天內完成——出院病摘簽署、手術紀錄、死亡證明書（自然死）、會診回覆。
// 缺什麼、哪天才算完成、逾期與否、每月準時完成率。服務層（record-audit.ts）、首頁、畫面、測試共用
import { addDays } from '@/utils/date'

/** 出院後幾天內病歷要完成 */
export const RECORD_DUE_DAYS = 14

export interface RecordInput {
  day: boolean
  dischargedAt: string
  summary?: { signedAt?: string }
  surgeries: { no: string; recordAt?: string }[]
  death?: { manner: string; certAt?: string }
  consults: { dept: string; answeredAt?: string; cancelled?: boolean }[]
}

/** 還缺什麼（空＝完整） */
export function recordGaps(x: RecordInput): string[] {
  const out: string[] = []
  if (!x.day && !x.summary?.signedAt) out.push(x.summary ? '出院病摘未簽署' : '出院病摘未寫')
  const sg = x.surgeries.filter((s) => !s.recordAt)
  if (sg.length) out.push(`手術紀錄未完成：${sg.map((s) => s.no).join('、')}`)
  // 自然死要開死亡證明書；非自然死由檢察官相驗開相驗屍體證明書，醫院不開
  if (x.death && x.death.manner === 'natural' && !x.death.certAt) out.push('死亡證明書未開立')
  const cs = x.consults.filter((c) => !c.cancelled && !c.answeredAt)
  if (cs.length) out.push(`會診未回覆：${cs.map((c) => c.dept).join('、')}`)
  return out
}

/** 完成時間：完整的話＝最後補齊的那一項（出院那時就齊了＝出院時間）；不完整＝undefined */
export function recordCompletedAt(x: RecordInput): string | undefined {
  if (recordGaps(x).length) return undefined
  const ts = [x.dischargedAt, x.summary?.signedAt, ...x.surgeries.map((s) => s.recordAt), x.death?.manner === 'natural' ? x.death.certAt : undefined, ...x.consults.filter((c) => !c.cancelled).map((c) => c.answeredAt)].filter((t): t is string => !!t)
  return ts.sort().at(-1)
}

/** 期限（出院日 + 14 天）、逾期（今天過了期限還不完整）、準時（完成在期限內） */
export const recordDue = (dischargedAt: string) => addDays(dischargedAt.slice(0, 10), RECORD_DUE_DAYS)
export const recordOverdue = (x: RecordInput, today: string) => !!recordGaps(x).length && today > recordDue(x.dischargedAt)
export const recordOnTime = (x: RecordInput) => ((c) => !!c && c.slice(0, 10) <= recordDue(x.dischargedAt))(recordCompletedAt(x))

/** 準時完成率（%，一位小數）：出院的、已經到期的（或已完成的）裡面，期限內完成幾成 */
export function recordOnTimeRate(xs: RecordInput[], today: string): number | null {
  const due = xs.filter((x) => recordCompletedAt(x) || today > recordDue(x.dischargedAt))
  return due.length ? Math.round((due.filter(recordOnTime).length / due.length) * 1000) / 10 : null
}

// ── 住院中每日病程紀錄：入院隔天到昨天，每天至少一筆一般病程紀錄（今天還沒過完不算）；只看最近 7 天 ──

export const PROGRESS_LOOKBACK_DAYS = 7
/** 缺病程紀錄的日期（舊到新） */
export function progressGapDates(admittedAt: string, noteDates: string[], today: string): string[] {
  const has = new Set(noteDates.map((d) => d.slice(0, 10)))
  const from = [addDays(admittedAt.slice(0, 10), 1), addDays(today, -PROGRESS_LOOKBACK_DAYS)].sort().at(-1)!
  const out: string[] = []
  for (let d = from; d < today; d = addDays(d, 1)) if (!has.has(d)) out.push(d)
  return out
}
