// 管灌的內部工具（index 不匯出、不會被包成 API）：目前的管灌醫囑、今天各時段的狀態、反抽過多。
// 護理站清單、本班待辦、管灌分頁、送餐清單共用；規則在 nutrition-rules
import type { IpdOrder, TubeFeedPlan, TubeFeedRecord } from '@/types'
import { db } from '@/mock/db'
import { addDays, addMinutes } from '@/utils/date'
import { feedSlots, slotState, TUBE_RESIDUAL_HOLD } from './nutrition-rules'
import { shiftRange } from './nursing-rules'

/** 現在有效的管灌醫囑（長期飲食醫囑、種類管灌） */
export function activeTubeOrder(admissionId: string, t: string): (IpdOrder & { diet: { tube: TubeFeedPlan } }) | undefined {
  const o = db.ipdOrders
    .filter((x) => x.admissionId === admissionId && x.category === 'diet' && x.type === 'long' && x.startAt <= t && (!x.stopAt || x.stopAt > t))
    .sort((p, q) => p.startAt.localeCompare(q.startAt))
    .at(-1)
  return o?.diet?.kind === 'tube' && o.diet.tube ? (o as IpdOrder & { diet: { tube: TubeFeedPlan } }) : undefined
}

export interface FeedSlot {
  slot: string
  ml: number
  state: 'done' | 'upcoming' | 'due' | 'overdue'
  record?: TubeFeedRecord
}

/** 今天的時段（連續灌食含昨天最後一班、分次灌食含上一班還沒記的）：開醫囑之前的不算；記過的帶紀錄 */
export function tubeSlotsOf(admissionId: string, t: string): { order?: IpdOrder & { diet: { tube: TubeFeedPlan } }; slots: FeedSlot[] } {
  const order = activeTubeOrder(admissionId, t)
  if (!order) return { slots: [] }
  const plan = order.diet.tube
  const date = t.slice(0, 10)
  const recs = db.tubeFeeds.filter((r) => r.orderId === order.id)
  // 昨天的：連續灌食的最後一班；分次灌食上一班還沒記的（過了午夜仍是逾時，不能一到 00:00 就消失；和交班一樣看到上一班）
  const yesterday = feedSlots(plan, addDays(date, -1))
  const prevShiftStart = addMinutes(shiftRange(t).start, -8 * 60)
  const raw = [...(plan.mode === 'continuous' ? yesterday.slice(-1) : yesterday.filter((s) => s.slot >= prevShiftStart && !recs.some((r) => r.slot === s.slot))), ...feedSlots(plan, date)]
  // 開醫囑之後的時段才算（分次：預定時間在開立之後；連續：這一班還沒結束）
  const startAt = order.startAt
  const slots = raw
    .filter((s) => (plan.mode === 'bolus' ? s.slot >= startAt : addMinutes(s.slot, 8 * 60) > startAt))
    .map((s) => {
      const record = recs.find((r) => r.slot === s.slot)
      return { ...s, state: slotState(plan, s.slot, !!record, t), ...(record ? { record } : {}) }
    })
  return { order, slots }
}

/** 最近一次反抽超過門檻（提醒暫停並通知醫師） */
export const highResidual = (admissionId: string): TubeFeedRecord | undefined => {
  const last = db.tubeFeeds.filter((r) => r.admissionId === admissionId).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
  return last && (last.residualMl ?? 0) > TUBE_RESIDUAL_HOLD ? last : undefined
}
