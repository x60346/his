// 手術預防性抗生素（純函式）：劃刀前多久內要給（一般 60 分鐘、Vancomycin 輸注久要 120 分鐘）、
// 手術結束後 24 小時要停、指標（劃刀前給藥時機符合率、24 小時內停藥率）。手術室開始手術、每日審視、首頁待辦、指標、測試都用這一份
import { parseDate } from '@/utils/date'

/** 手術結束後多久要停預防性抗生素 */
export const PROPHYLAXIS_STOP_HOURS = 24
/** 劃刀前幾分鐘內要給：Vancomycin 輸注要 1–2 小時，放寬到 120 分鐘 */
export const preIncisionWindow = (drugId: string | undefined) => (drugId === 'M042' ? 120 : 60)

const minutesBetween = (a: string, b: string) => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 60000)

export interface PreIncision {
  ok: boolean
  /** 劃刀前最後一劑的時間與距劃刀幾分鐘 */
  givenAt?: string
  minutes?: number
  text: string
}
/** 劃刀前給藥時機：劃刀（或現在）之前最後一劑已給的藥，距劃刀在 window 分鐘內才算符合 */
export function preIncisionCheck(givenAts: string[], start: string, window: number): PreIncision {
  const last = givenAts.filter((a) => a <= start).sort().at(-1)
  if (!last) return { ok: false, text: '劃刀前沒有給藥紀錄' }
  const minutes = minutesBetween(last, start)
  if (minutes <= window) return { ok: true, givenAt: last, minutes, text: `劃刀前 ${minutes} 分鐘給藥（${window} 分鐘內）` }
  const h = Math.floor(minutes / 60)
  return { ok: false, givenAt: last, minutes, text: `最後一劑在劃刀前 ${h ? `${h} 小時 ` : ''}${minutes % 60} 分鐘（超過 ${window} 分鐘）` }
}

/** 手術結束已幾小時（滿 24 小時才回，還沒到回 undefined） */
export function prophylaxisOverdueHours(endAt: string, t: string): number | undefined {
  const h = Math.floor(minutesBetween(endAt, t) / 60)
  return h >= PROPHYLAXIS_STOP_HOURS ? h : undefined
}

export interface ProphylaxisStats {
  /** 期間內完成、有連預防性抗生素醫囑的手術 */
  surgeries: number
  timingOk: number
  timingRate: number | null
  /** 已經判斷得出（停了，或已過 24 小時）的台數與其中 24 小時內停的 */
  stopKnown: number
  stoppedIn24: number
  stopRate: number | null
}
/** stoppedIn24：true 24 小時內停、false 超過才停或過了 24 小時還在用、null 還沒滿 24 小時（不算進分母） */
export function prophylaxisStats(rows: { timingOk: boolean; stoppedIn24: boolean | null }[]): ProphylaxisStats {
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null)
  const timingOk = rows.filter((r) => r.timingOk).length
  const known = rows.filter((r) => r.stoppedIn24 !== null)
  const stopped = known.filter((r) => r.stoppedIn24).length
  return { surgeries: rows.length, timingOk, timingRate: pct(timingOk, rows.length), stopKnown: known.length, stoppedIn24: stopped, stopRate: pct(stopped, known.length) }
}
