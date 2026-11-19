// 檢驗時效的內部計算（index 不匯出）：某一筆檢驗（E:看診:醫令／O:醫囑）的開始時間、急件或一般、採檢與收件時間。
// 檢驗頁、首頁、測試共用。規則在 tat-rules
import type { LabReport } from '@/types'
import { db } from '@/mock/db'
import { find } from './views'
import { opdSpecimenOf, specimenOfOrder } from './specimen-work'
import { pendingLabWork, type LabWorkItem } from './lab-work'
import { tatExcluded, tatLimitOf, tatStatus, type TatPriority, type TatTimes } from './tat-rules'
import { now } from '@/utils/date'

/** 這一筆檢驗的時效資料：住院（長期檢驗那一次＝一般、從排定時間；其他臨時＝急件、從開立）、門診（一般、從批價）、急診（急件、從看完診） */
export function tatTimesOf(key: string): (TatTimes & { priority: TatPriority }) | undefined {
  const [kind, a, procId] = key.split(':')
  if (kind === 'O') {
    const o = db.ipdOrders.find((x) => x.id === a)
    const lim = find.procedure(o?.procId ?? '')?.labLimits
    if (!o || tatExcluded(lim)) return undefined
    const sp = specimenOfOrder(o.id)
    const collectedAt = sp?.collectedAt ?? (o.status === 'done' ? o.stopAt : undefined)
    const p: TatPriority = o.parentOrderId ? 'routine' : 'stat'
    return { priority: p, limit: tatLimitOf(lim, p), start: o.parentOrderId ? o.startAt : o.createdAt, ...(collectedAt ? { collectedAt } : {}), ...(sp?.receivedAt ? { receivedAt: sp.receivedAt } : !sp && o.status === 'done' && collectedAt ? { receivedAt: collectedAt } : {}) }
  }
  if (kind === 'E') {
    const lim = find.procedure(procId)?.labLimits
    if (tatExcluded(lim)) return undefined
    const e = db.encounters.find((x) => x.id === a)
    const v = e && find.visit(e.visitId)
    if (!e || !v) return undefined
    const paid = db.charges.find((c) => c.visitId === v.id && !c.voided && !c.supplementOf)?.paidAt
    // 急診從醫師送出算（舊資料沒有送出時間的用看完診）
    const start = v.er ? e.procedures.find((p) => p.procId === procId)?.orderedAt ?? e.completedAt : paid
    if (!start) return undefined
    const sp = opdSpecimenOf(key)
    const p: TatPriority = v.er ? 'stat' : 'routine'
    return { priority: p, limit: tatLimitOf(lim, p), start, ...(sp?.collectedAt ? { collectedAt: sp.collectedAt } : {}), ...(sp?.receivedAt ? { receivedAt: sp.receivedAt } : {}) }
  }
  return undefined
}
export const reportKey = (r: Pick<LabReport, 'orderId' | 'encounterId' | 'procId'>) => (r.orderId ? `O:${r.orderId}` : `E:${r.encounterId}:${r.procId}`)

/** 還沒發報告、快逾時或已逾時的（首頁、檢驗頁） */
export function tatOpen(t: string = now()): (LabWorkItem & { times: TatTimes & { priority: TatPriority }; status: ReturnType<typeof tatStatus> })[] {
  return pendingLabWork()
    .map((w) => ({ w, times: tatTimesOf(w.key) }))
    .filter((x): x is { w: LabWorkItem; times: TatTimes & { priority: TatPriority } } => !!x.times && x.times.start <= t)
    .map(({ w, times }) => ({ ...w, times, status: tatStatus(times, times.priority, t) }))
    .filter((x) => x.status.state !== 'ok')
    .sort((a, b) => a.status.due - b.status.due)
}
