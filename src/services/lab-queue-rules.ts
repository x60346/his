// 門診抽血叫號（純函式，畫面、服務層、種子、測試共用）：報到拿號 → 櫃台「叫下一位」→ 病人來了開始採檢（印條碼）；
// 叫了沒來可以重叫（最多 3 次）或過號；過號的病人回來，插在目前叫號的下兩位之後（不用從頭排）。叫到號才能採檢
import type { LabCheckin, LabWindowSession } from '@/types'
import { parseDate } from '@/utils/date'

const minutesBetween = (a: string, b: string) => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 60000)

/** 同一號最多叫幾次 */
export const QUEUE_MAX_CALLS = 3
/** 過號回來：插在下幾位之後 */
export const QUEUE_RETURN_AFTER = 2
export type QueueStage = 'waiting' | 'called' | 'served' | 'skipped'
export const QUEUE_STAGE_LABEL: Record<QueueStage, string> = { waiting: '等候中', called: '叫號中', served: '已採檢', skipped: '過號' }

type C = Pick<LabCheckin, 'no' | 'at' | 'calls' | 'skippedAt' | 'returnedAt' | 'servedAt' | 'order' | 'callsAtReturn' | 'priority'>
/** 這一輪（過號回來後）叫了幾次：時間只到分鐘，回來和再叫可能同一分鐘，所以用回來時的叫號次數切 */
export const callsSinceReturn = (c: Pick<C, 'calls' | 'returnedAt' | 'callsAtReturn'>) => (c.calls?.length ?? 0) - (c.returnedAt ? c.callsAtReturn ?? 0 : 0)
/** 目前在哪一步：開始採檢了＝served；過號還沒回來＝skipped；回來後（或從沒過號）有叫過＝called；其他＝waiting */
export function queueStage(c: C): QueueStage {
  if (c.servedAt) return 'served'
  if (c.skippedAt && !c.returnedAt) return 'skipped'
  return callsSinceReturn(c) > 0 ? 'called' : 'waiting'
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
  const first = c.returnedAt ? c.calls?.[c.callsAtReturn ?? 0] : c.calls?.[0]
  return first ? minutesBetween(from, first) : undefined
}
/** 平均等候分鐘（有叫到的才算；四捨五入） */
export function avgWait(cs: C[]): number | undefined {
  const xs = cs.map(waitedMinutes).filter((x): x is number => x !== undefined)
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : undefined
}

// ── 優先叫號：75 歲以上（自動）、身心障礙、行動不便。優先排在一般前面，但連續叫兩位優先後要叫一位一般（一般的不會一直等） ──

export type QueuePriority = NonNullable<LabCheckin['priority']>
export const QUEUE_PRIORITY_LABEL: Record<QueuePriority, string> = { elderly: '75 歲以上', disabled: '身心障礙', mobility: '行動不便' }
export const QUEUE_PRIORITY_AGE = 75
/** 連續叫幾位優先後，要叫一位一般 */
export const QUEUE_PRIORITY_STREAK = 2
/** 報到時的優先：75 歲以上自動；其他看櫃台勾的（身心障礙、行動不便） */
export const priorityOf = (age: number, chosen?: string): QueuePriority | undefined =>
  age >= QUEUE_PRIORITY_AGE ? 'elderly' : chosen === 'disabled' || chosen === 'mobility' ? chosen : undefined

/** 下一位要叫誰：有優先、而且連續叫優先還不到兩位（或沒有一般在等）→ 優先的第一位；否則一般的第一位。streak＝目前連續叫了幾位優先 */
export function pickNext<T extends C>(waiting: T[], streak: number): T | undefined {
  const w = [...waiting].sort((a, b) => queueOrder(a) - queueOrder(b))
  const pri = w.filter((c) => c.priority)
  const norm = w.filter((c) => !c.priority)
  return pri.length && (streak < QUEUE_PRIORITY_STREAK || !norm.length) ? pri[0] : norm[0]
}
/** 接下來的叫號順序（看板、候診螢幕）：照 pickNext 一位一位排 */
export function callOrder<T extends C>(waiting: T[], streak: number): T[] {
  const left = [...waiting]
  const out: T[] = []
  let s = streak
  while (left.length) {
    const n = pickNext(left, s)!
    out.push(n)
    left.splice(left.indexOf(n), 1)
    s = n.priority ? s + 1 : 0
  }
  return out
}
/** 候診螢幕的姓名遮罩：王小明 → 王○明、陳一 → 陳○、歐陽小明 → 歐○○明 */
export const maskName = (name: string) => (name.length <= 1 ? name : name.length === 2 ? `${name[0]}○` : `${name[0]}${'○'.repeat(name.length - 2)}${name.at(-1)}`)

// ── 多窗口：固定 3 個窗口，共用一條隊伍；醫檢師開窗（一人同時一個窗口、一個窗口同時一人），叫號帶窗口號 ──

export const LAB_WINDOWS = [1, 2, 3]
type W = Pick<LabWindowSession, 'date' | 'window' | 'userId' | 'closedAt'>
/** 這個人今天開著的窗口 */
export const windowOfUser = <T extends W>(ws: T[], userId: string, date: string): T | undefined => ws.find((w) => w.date === date && w.userId === userId && !w.closedAt)
/** 這個窗口今天現在誰開著 */
export const windowHolder = <T extends W>(ws: T[], window: number, date: string): T | undefined => ws.find((w) => w.date === date && w.window === window && !w.closedAt)
/** 叫號沒開窗時自動開：最小的空窗口 */
export const firstFreeWindow = (ws: W[], date: string): number | undefined => LAB_WINDOWS.find((n) => !windowHolder(ws, n, date))

// ── 分流：只交檢體（待採的全是病人自行收集的容器：尿液、痰液）的病人走 3 號「檢體窗口」，不跟抽血的排同一條 ──
// 檢體窗口開著：抽血窗口只叫抽血的，檢體窗口先叫交檢體的、沒有才幫忙叫抽血的；檢體窗口沒開：全部照原本一條隊伍。
// 優先（75 歲以上等）的連續計數只算抽血的

export type QueueLane = 'blood' | 'drop'
export const QUEUE_LANE_LABEL: Record<QueueLane, string> = { blood: '抽血', drop: '交檢體' }
/** 檢體窗口 */
export const LAB_DROP_WINDOW = 3
export const LAB_WINDOW_LABEL: Record<number, string> = { [LAB_DROP_WINDOW]: '檢體窗口' }
/** 報到時分流：待採檢的容器全是自行收集的＝交檢體 */
export const laneOf = (tubes: string[], selfCollect: string[]): QueueLane => (tubes.length && tubes.every((t) => selfCollect.includes(t)) ? 'drop' : 'blood')
const laneOfC = (c: { lane?: QueueLane }): QueueLane => c.lane ?? 'blood'

/** 這個窗口下一位：見上方分流規則 */
export function pickNextFor<T extends C & { lane?: QueueLane }>(window: number, waiting: T[], streak: number, dropOpen: boolean): T | undefined {
  if (!dropOpen) return pickNext(waiting, streak)
  const w = [...waiting].sort((a, b) => queueOrder(a) - queueOrder(b))
  const blood = w.filter((c) => laneOfC(c) === 'blood')
  if (window === LAB_DROP_WINDOW) return w.find((c) => laneOfC(c) === 'drop') ?? pickNext(blood, streak)
  // 抽血的都叫完了：抽血窗口也幫忙叫交檢體的
  return pickNext(blood, streak) ?? w.find((c) => laneOfC(c) === 'drop')
}
/** 看板的叫號順序：檢體窗口開著時分兩條（抽血照優先規則、交檢體照號碼）；沒開就一條 */
export function laneOrders<T extends C & { lane?: QueueLane }>(waiting: T[], streak: number, dropOpen: boolean): { blood: T[]; drop: T[] } {
  if (!dropOpen) return { blood: callOrder(waiting, streak), drop: [] }
  return { blood: callOrder(waiting.filter((c) => laneOfC(c) === 'blood'), streak), drop: [...waiting].filter((c) => laneOfC(c) === 'drop').sort((a, b) => queueOrder(a) - queueOrder(b)) }
}
