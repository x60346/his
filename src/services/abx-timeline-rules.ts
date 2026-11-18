// 抗生素時間軸（純函式）：住院的每一天、每支抗生素一列——當天有給藥（實心）、有醫囑但沒給（空心）、沒有醫囑（空白）。
// 同一支藥的多筆醫囑（修改、停了又開）併成一列。感染科審視頁、管制性審核頁、住院醫囑「抗生素」分頁、測試都用這一份
import { addDays } from '@/utils/date'

/** from 到 to（含）的每一天 */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from.slice(0, 10); d <= to.slice(0, 10) && out.length < 400; d = addDays(d, 1)) out.push(d)
  return out
}

export interface TimelineOrderIn {
  drugId: string
  startAt: string
  /** 停止或完成的時間；還在用的沒有 */
  stopAt?: string
}
export interface TimelineRow {
  drugId: string
  /** 每一天：given＝那天給了幾劑；ordered＝那天有醫囑（開立日到停止日） */
  cells: { date: string; given: number; ordered: boolean }[]
  /** 給過藥的天數（DOT） */
  dot: number
  first: string
  last: string
}

/**
 * 依藥品併成列（第一天用藥早的在前）。ordered：醫囑開始日到停止日（還在用到 to）；given：給藥紀錄的實際時間。
 * 只畫 days 範圍內的；完全沒有醫囑落在範圍裡的藥不列
 */
export function timelineRows(days: string[], orders: TimelineOrderIn[], given: { drugId: string; at: string }[]): TimelineRow[] {
  if (!days.length) return []
  const last = days.at(-1)!
  const ids = [...new Set(orders.map((o) => o.drugId))]
  return ids
    .map((drugId) => {
      const os = orders.filter((o) => o.drugId === drugId)
      const g = given.filter((x) => x.drugId === drugId)
      const cells = days.map((date) => ({
        date,
        given: g.filter((x) => x.at.slice(0, 10) === date).length,
        ordered: os.some((o) => o.startAt.slice(0, 10) <= date && (o.stopAt ?? `${last} 23:59`).slice(0, 10) >= date),
      }))
      const used = cells.filter((c) => c.ordered || c.given)
      return { drugId, cells, dot: cells.filter((c) => c.given > 0).length, first: used[0]?.date ?? '', last: used.at(-1)?.date ?? '' }
    })
    .filter((r) => r.first)
    .sort((a, b) => a.first.localeCompare(b.first) || a.drugId.localeCompare(b.drugId))
}
