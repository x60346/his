// 檢驗時效（醫檢師、管理員）：還沒發的快逾時（用掉八成時間）與已逾時的（緊的在前，標出卡在哪一段）、
// 近 30 天急件與一般的達成率、逾時的最常卡在哪一段。規則在 tat-rules、計算在 tat-work
import { db } from '@/mock/db'
import { addDays, now } from '@/utils/date'
import { query, requireUser } from './http'
import { reportKey, tatOpen, tatTimesOf } from './tat-work'
import { tatBottleneck, tatCurrent, tatRate, tatSegments, TAT_PRIORITY_LABEL, TAT_SEGMENT_LABEL, type TatPriority, type TatSegment } from './tat-rules'

export interface TatOpenView {
  key: string
  patientName: string
  where: string
  procName: string
  priority: TatPriority
  priorityLabel: string
  start: string
  elapsed: number
  limit: number
  state: 'warn' | 'late'
  /** 現在卡在哪一段 */
  segment: TatSegment
  segmentLabel: string
  segments: Partial<Record<TatSegment, number>>
  /** 住院已採檢、還沒收件的條碼 */
  barcode?: string
}
export interface TatBoard {
  open: TatOpenView[]
  rate: Record<TatPriority, { total: number; ontime: number; pct: number }>
  bottleneck: { segment: TatSegment; label: string; count: number }[]
}

export function tatBoard(): Promise<TatBoard> {
  return query(() => {
    requireUser('lab', 'admin')
    const t = now()
    const since = `${addDays(t.slice(0, 10), -30)} 00:00`
    const done = db.labReports
      .filter((r) => r.reportedAt >= since)
      .map((r) => ({ r, x: tatTimesOf(reportKey(r)) }))
      .filter((y): y is { r: (typeof y)['r']; x: NonNullable<(typeof y)['x']> } => !!y.x && y.x.start <= y.r.reportedAt)
      .map(({ r, x }) => ({ ...x, reportedAt: r.reportedAt }))
    return {
      open: tatOpen(t).map((w) => ({
        key: w.key, patientName: w.patientName, where: w.where, procName: w.procName, priority: w.times.priority, priorityLabel: TAT_PRIORITY_LABEL[w.times.priority], start: w.times.start,
        elapsed: w.status.elapsed, limit: w.status.limit, state: w.status.state as 'warn' | 'late', segment: tatCurrent(w.times), segmentLabel: TAT_SEGMENT_LABEL[tatCurrent(w.times)], segments: tatSegments(w.times, t),
        ...(w.awaitingReceipt ? { barcode: w.awaitingReceipt } : {}),
      })),
      rate: tatRate(done),
      bottleneck: tatBottleneck(done),
    }
  })
}
