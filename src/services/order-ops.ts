// 住院醫囑的共用動作（服務層內部，不在 services/index.ts 對外）。
// 醫師按「停止」、轉科時新主治勾選停止，都走同一條：之後還沒給的排程刪除（已調劑的會自動列入待退藥）、
// 有疑問的醫囑疑問就此結案。
import type { IpdOrder, OrderQuery } from '@/types'
import { db } from '@/mock/db'
import { openQuery } from './nursing-rules'

/** 停止一筆醫囑；回傳被一併結案的疑問（沒有就 undefined） */
export function stopOrderRecord(o: IpdOrder, userId: string, t: string): OrderQuery | undefined {
  o.status = 'stopped'
  o.stopAt = t
  db.mar = db.mar.filter((m) => !(m.orderId === o.id && m.status === 'pending'))
  const q = openQuery(o)
  if (q) Object.assign(q, { replyBy: userId, replyAt: t, reply: '已停止此醫囑', resolution: 'stopped' })
  return q
}
