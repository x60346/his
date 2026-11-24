// 住院病歷完整性（純函式）：出院後病歷要在 14 天內完成——出院病摘簽署、手術紀錄、死亡證明書（自然死）、會診回覆、
// 住院期間每天的病程紀錄（入院隔天到出院前一天，缺的主治可以補寫）。
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
  /** 這次住院有效的同意書：紙本掃描了沒 */
  consents?: { no: string; scannedAt?: string }[]
  /** 住院期間缺病程紀錄的日期、最後一次補寫的時間 */
  progress?: { gaps: string[]; lastLateAt?: string }
}

/** 病程紀錄算哪一天：補寫的算補的那天 */
export const noteDateOf = (n: { at: string; lateFor?: string }) => n.lateFor ?? n.at.slice(0, 10)

/** 整段住院缺病程紀錄的日期（入院隔天到出院前一天；入院、出院當天不要求） */
export function stayProgressGaps(admittedAt: string, dischargedAt: string, noteDates: string[]): string[] {
  const has = new Set(noteDates.map((d) => d.slice(0, 10)))
  const out: string[] = []
  for (let d = addDays(admittedAt.slice(0, 10), 1); d < dischargedAt.slice(0, 10); d = addDays(d, 1)) if (!has.has(d)) out.push(d)
  return out
}
/** 缺的日期寫成一句（最多列 5 天） */
export const progressGapText = (gaps: string[]) => `病程紀錄缺 ${gaps.length} 天：${gaps.slice(0, 5).map((d) => d.slice(5).replace('-', '/')).join('、')}${gaps.length > 5 ? '…' : ''}`

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
  if (x.progress?.gaps.length) out.push(progressGapText(x.progress.gaps))
  const un = (x.consents ?? []).filter((c) => !c.scannedAt)
  if (un.length) out.push(`同意書紙本未掃描：${un.map((c) => c.no).join('、')}`)
  return out
}

/** 完成時間：完整的話＝最後補齊的那一項（出院那時就齊了＝出院時間）；不完整＝undefined */
export function recordCompletedAt(x: RecordInput): string | undefined {
  if (recordGaps(x).length) return undefined
  const ts = [x.dischargedAt, x.summary?.signedAt, ...x.surgeries.map((s) => s.recordAt), x.death?.manner === 'natural' ? x.death.certAt : undefined, ...x.consults.filter((c) => !c.cancelled).map((c) => c.answeredAt), x.progress?.lastLateAt, ...(x.consents ?? []).map((c) => c.scannedAt)].filter((t): t is string => !!t)
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

// ── 住院中護理紀錄：每一班至少一筆（Focus DAR）；看最近 6 個已經結束的班（兩天），入院前開始的班不算 ──

export const NURSING_LOOKBACK_SHIFTS = 6
const SHIFT_HOUR: Record<string, number> = { 大夜: 0, 白班: 8, 小夜: 16 }
/** 缺護理紀錄的班（舊到新）：「11-19 小夜」 */
export function nursingGapShifts(admittedAt: string, noteTimes: string[], now: string, shifts: { date: string; shift: string }[]): string[] {
  const out: string[] = []
  for (const s of [...shifts].reverse()) {
    const start = `${s.date} ${String(SHIFT_HOUR[s.shift]).padStart(2, '0')}:00`
    const end = addMinutes8(start)
    if (start < admittedAt.slice(0, 16) || end > now) continue
    if (!noteTimes.some((t) => t >= start && t < end)) out.push(`${s.date.slice(5).replace('-', '/')} ${s.shift}`)
  }
  return out
}
const addMinutes8 = (start: string) => {
  const d = new Date(`${start.replace(' ', 'T')}:00`)
  d.setHours(d.getHours() + 8)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
