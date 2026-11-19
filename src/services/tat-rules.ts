// 檢驗時效（TAT, turnaround time；純函式，畫面、服務層、種子、測試共用）：每份檢驗從「開始」到發報告的時間——
// 住院從開立（長期檢驗那一次從排定時間）、門診從批價、急診從看完診；時限急件 60 分鐘（住院臨時、急診）、一般 240 分鐘（門診、長期檢驗）。
// 分段看卡在哪：等採檢（開始→採檢）、送檢（採檢→檢驗科收件）、檢驗科內（收件→發報告）
import type { LabLimits } from '@/types'
import { parseDate } from '@/utils/date'

export type TatPriority = 'stat' | 'routine'
export const TAT_MINUTES: Record<TatPriority, number> = { stat: 60, routine: 240 }
export const TAT_PRIORITY_LABEL: Record<TatPriority, string> = { stat: '急件', routine: '一般' }
/** 用掉幾成時間算「快逾時」 */
export const TAT_WARN = 0.8
export type TatSegment = 'collect' | 'transport' | 'lab'
export const TAT_SEGMENT_LABEL: Record<TatSegment, string> = { collect: '等採檢', transport: '送檢', lab: '檢驗科內' }
/** 這個檢驗醫令某優先度的時限：主檔有設就用主檔（檢驗時限設定），沒有用預設 */
export const tatLimitOf = (lim: LabLimits | undefined, p: TatPriority) => lim?.[p] ?? TAT_MINUTES[p]
/** 主檔勾了「不計時效」（細菌培養這類要好幾天的） */
export const tatExcluded = (lim: LabLimits | undefined) => !!lim?.noTat
/** 時限設定的範圍（分鐘）：5 分鐘到 7 天 */
export const LAB_LIMIT_RANGE = { min: 5, max: 7 * 24 * 60 }
/** 檢驗時限設定的欄位：都可以空白（＝預設）；有填的要是整數、在範圍內；要寫修改原因 */
export function checkLabLimits(x: { stat?: unknown; routine?: unknown; callout?: unknown; reason?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  for (const k of ['stat', 'routine', 'callout'] as const) {
    const v = x[k]
    if (v === undefined || v === null || v === '') continue
    const n = Number(v)
    if (!Number.isInteger(n) || n < LAB_LIMIT_RANGE.min || n > LAB_LIMIT_RANGE.max) e[k] = `請填 ${LAB_LIMIT_RANGE.min}–${LAB_LIMIT_RANGE.max} 分鐘的整數（空白＝預設）`
  }
  if (!x.reason?.trim()) e.reason = '請寫修改原因（例：檢驗科品質會議決議）'
  return e
}

export interface TatTimes {
  start: string
  collectedAt?: string
  receivedAt?: string
  reportedAt?: string
  /** 這個項目另訂的時限（分鐘）；沒有就照急件、一般 */
  limit?: number
}
const limitOf = (x: Pick<TatTimes, 'limit'>, p: TatPriority) => x.limit ?? TAT_MINUTES[p]
const mins = (a: string, b: string) => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 60000)

/** 各段幾分鐘：做完的段用實際時間，正在進行的那段算到現在；還沒開始的段沒有 */
export function tatSegments(x: TatTimes, now: string): Partial<Record<TatSegment, number>> {
  const end = x.reportedAt ?? now
  const out: Partial<Record<TatSegment, number>> = {}
  out.collect = mins(x.start, x.collectedAt ?? end)
  if (x.collectedAt) out.transport = mins(x.collectedAt, x.receivedAt ?? end)
  if (x.receivedAt) out.lab = mins(x.receivedAt, end)
  return out
}
/** 目前卡在哪一段（還沒發報告的） */
export const tatCurrent = (x: TatTimes): TatSegment => (x.receivedAt ? 'lab' : x.collectedAt ? 'transport' : 'collect')

/** 時效狀態：花了幾分鐘、期限、ok／warn（用掉八成以上）／late（超過；發出了就看發出時有沒有超過） */
export function tatStatus(x: TatTimes, p: TatPriority, now: string): { elapsed: number; limit: number; due: number; state: 'ok' | 'warn' | 'late' } {
  const limit = limitOf(x, p)
  const elapsed = mins(x.start, x.reportedAt ?? now)
  const state = elapsed > limit ? 'late' : !x.reportedAt && elapsed >= limit * TAT_WARN ? 'warn' : 'ok'
  return { elapsed, limit, due: limit - elapsed, state }
}

/** 達成率：發出的報告裡，在時限內的比例（依急件、一般分開） */
export function tatRate(xs: (TatTimes & { priority: TatPriority })[]): Record<TatPriority, { total: number; ontime: number; pct: number }> {
  const one = (p: TatPriority) => {
    const ys = xs.filter((x) => x.priority === p && x.reportedAt)
    const ontime = ys.filter((x) => mins(x.start, x.reportedAt!) <= limitOf(x, p)).length
    return { total: ys.length, ontime, pct: ys.length ? Math.round((ontime / ys.length) * 100) : 100 }
  }
  return { stat: one('stat'), routine: one('routine') }
}

/** 最常卡在哪：逾時的報告各自最長的那一段，數一數（多的在前；只算三段都有時間的） */
export function tatBottleneck(xs: (TatTimes & { priority: TatPriority })[]): { segment: TatSegment; label: string; count: number }[] {
  const n: Record<TatSegment, number> = { collect: 0, transport: 0, lab: 0 }
  for (const x of xs) {
    if (!x.reportedAt || !x.collectedAt || !x.receivedAt || mins(x.start, x.reportedAt) <= limitOf(x, x.priority)) continue
    const s = tatSegments(x, x.reportedAt)
    const top = (Object.keys(n) as TatSegment[]).sort((a, b) => (s[b] ?? 0) - (s[a] ?? 0))[0]
    n[top]++
  }
  return (Object.keys(n) as TatSegment[]).map((k) => ({ segment: k, label: TAT_SEGMENT_LABEL[k], count: n[k] })).filter((x) => x.count).sort((a, b) => b.count - a.count)
}
