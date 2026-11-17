// 點滴的內部工具（index 不匯出、不會被包成 API）：執行中的點滴醫囑、正在滴的那一瓶、換瓶待辦、今日輸入量、出院收尾。規則在 infusion-rules
import type { Admission, InfusionRun, IpdOrder } from '@/types'
import { db } from '@/mock/db'
import { addDays } from '@/utils/date'
import { changeState, expectedEnd, infusedBetween } from './infusion-rules'

export const infusionOrders = (admissionId: string): IpdOrder[] => db.ipdOrders.filter((o) => o.admissionId === admissionId && o.category === 'medication' && !!o.infusion && o.status === 'active')
export const runningRun = (orderId: string): InfusionRun | undefined => db.infusions.find((r) => r.orderId === orderId && !r.endAt)
const volOf = (orderId: string) => db.ipdOrders.find((o) => o.id === orderId)?.infusion?.volumeMl ?? 500

export interface InfusionTodo {
  orderId: string
  runId?: string
  /** start 還沒接上（醫囑新開）、change 快滴完或已滴完、stop 醫囑已停但還在滴 */
  kind: 'start' | 'change' | 'stop'
  urgency: 'due' | 'overdue'
  at?: string
  text: string
}

export function infusionTodosOf(admissionId: string, t: string): InfusionTodo[] {
  const out: InfusionTodo[] = []
  for (const o of infusionOrders(admissionId)) {
    const r = runningRun(o.id)
    if (!r) {
      out.push({ orderId: o.id, kind: 'start', urgency: 'due', at: o.startAt, text: `點滴待接上：${o.content}` })
      continue
    }
    const end = expectedEnd(r, o.infusion!.volumeMl)
    const st = changeState(end, t)
    if (st !== 'ok') out.push({ orderId: o.id, runId: r.id, kind: 'change', urgency: st, at: end, text: `點滴第 ${r.bagNo} 瓶${st === 'overdue' ? '已滴完' : '快滴完'}：換瓶（${o.content}）` })
  }
  // 醫囑已停止（醫師停、修改）但還在滴：請護理師停止
  for (const r of db.infusions.filter((x) => x.admissionId === admissionId && !x.endAt)) {
    const o = db.ipdOrders.find((x) => x.id === r.orderId)
    if (o && o.status !== 'active') out.push({ orderId: o.id, runId: r.id, kind: 'stop', urgency: 'overdue', at: o.stopAt, text: `點滴醫囑已停止，請停止：${o.content}` })
  }
  return out
}

/** 今天（00:00 到現在）點滴滴入的 ml（依流速與時間；結束時修正過的用實際量） */
export function infusedToday(admissionId: string, t: string): number {
  return infusedIn(admissionId, `${t.slice(0, 10)} 00:00`, `${addDays(t.slice(0, 10), 1)} 00:00`, t)
}

/** 某段時間 [from, to) 滴入的 ml：加護病房流程表每小時的點滴輸入量 */
export function infusedIn(admissionId: string, from: string, to: string, t: string): number {
  return db.infusions.filter((r) => r.admissionId === admissionId && (!r.endAt || r.endAt >= from)).reduce((n, r) => n + infusedBetween(r, volOf(r.orderId), from, to, t), 0)
}

/** 出院、結束留觀：還在滴的停止 */
export function closeInfusions(a: Admission, by: string, t: string, reason = '出院'): void {
  for (const r of db.infusions.filter((x) => x.admissionId === a.id && !x.endAt)) Object.assign(r, { endAt: t, endBy: by, endReason: reason })
}
