// 門診抽血叫號（純函式，畫面、服務層、種子、測試共用）：報到拿號 → 櫃台「叫下一位」→ 病人來了開始採檢（印條碼）；
// 叫了沒來可以重叫（最多 3 次）或過號；過號的病人回來，插在目前叫號的下兩位之後（不用從頭排）。叫到號才能採檢
import type { LabCheckin } from '@/types'
import { parseDate } from '@/utils/date'

const minutesBetween = (a: string, b: string) => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 60000)

/** 同一號最多叫幾次 */
export const QUEUE_MAX_CALLS = 3
/** 過號回來：插在下幾位之後 */
export const QUEUE_RETURN_AFTER = 2
export type QueueStage = 'waiting' | 'called' | 'served' | 'skipped'
export const QUEUE_STAGE_LABEL: Record<QueueStage, string> = { waiting: '等候中', called: '叫號中', served: '已採檢', skipped: '過號' }

type C = Pick<LabCheckin, 'no' | 'at' | 'calls' | 'skippedAt' | 'returnedAt' | 'servedAt' | 'order'>
/** 目前在哪一步：開始採檢了＝served；過號還沒回來＝skipped；回來後（或從沒過號）有叫過＝called；其他＝waiting */
export function queueStage(c: C): QueueStage {
  if (c.servedAt) return 'served'
  if (c.skippedAt && !c.returnedAt) return 'skipped'
  const last = c.calls?.at(-1)
  return last && (!c.returnedAt || last > c.returnedAt) ? 'called' : 'waiting'
}
export const queueOrder = (c: C) => c.order ?? c.no
/** 等候中的（依排隊順序） */
export const waitingList = <T extends C>(cs: T[]): T[] => cs.filter((c) => queueStage(c) === 'waiting').sort((a, b) => queueOrder(a) - queueOrder(b))
/** 過號回來的排隊順序：插在目前等候的第 2 位之後（第 2、3 位中間）；等候不到 2 位就排最後 */
export function returnOrder(waiting: C[], all: C[]): number {
  const w = [...waiting].sort((a, b) => queueOrder(a) - queueOrder(b))
  if (w.length <= QUEUE_RETURN_AFTER) return Math.max(0, ...all.map(queueOrder)) + 1
  return (queueOrder(w[QUEUE_RETURN_AFTER - 1]) + queueOrder(w[QUEUE_RETURN_AFTER])) / 2
}
/** 等了幾分鐘才被叫到（報到或回來到第一次叫號；過號回來的從回來起算） */
export function waitedMinutes(c: C): number | undefined {
  const from = c.returnedAt ?? c.at
  const first = c.calls?.find((t) => t >= from)
  return first ? minutesBetween(from, first) : undefined
}
/** 平均等候分鐘（有叫到的才算；四捨五入） */
export function avgWait(cs: C[]): number | undefined {
  const xs = cs.map(waitedMinutes).filter((x): x is number => x !== undefined)
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : undefined
}
