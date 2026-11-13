// 收付款的服務層內部工具（不在 services/index.ts 對外）：收據、退款單的編號，掛號預收款還剩多少。
// 批價（charge）、掛號（booking）、停診（schedule）共用——每一筆收錢、退錢都有自己的單號、算在發生那天的日結。
import type { Charge, PayMethod, Visit, VisitPrepay } from '@/types'
import { db, nextCounter } from '@/mock/db'
import { now } from '@/utils/date'
import { fail, failField } from './http'

/** 收據號：依「開立那天」流水編號（結帳、收回欠款、預收共用同一個序號） */
export const nextReceiptNo = (date: string) => `R${date.replace(/-/g, '')}${String(nextCounter(`receipt:${date}`)).padStart(4, '0')}`
/** 退款單號：RF＋退款日＋流水號（和收據分開編，日結一眼分得出收與退） */
export const nextRefundNo = (date: string) => `RF${date.replace(/-/g, '')}${String(nextCounter(`refund:${date}`)).padStart(4, '0')}`

/** 這次就醫目前有效的收據（沒作廢、沒退費） */
export const activeChargeOf = (visitId: string): Charge | undefined => db.charges.find((c) => c.visitId === visitId && !c.voided)

/** 預收款還在醫院手上的（收了 − 已退還） */
export const prepayHeld = (v: Pick<Visit, 'prepay'>): number => (v.prepay ? v.prepay.amount - v.prepay.refunds.reduce((n, r) => n + r.amount, 0) : 0)

/** 預收款還沒用掉的：在手上的 − 目前有效收據扣抵掉的（收據作廢或退費後，預收款回到這次就醫，重新批價時再扣抵） */
export const prepayAvailable = (v: Pick<Visit, 'id' | 'prepay'>): number => prepayHeld(v) - (activeChargeOf(v.id)?.prepaidApplied ?? 0)

/** 預收金額檢查：正整數、不超過 99,999 */
export function checkPrepay(amount: unknown): string | null {
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) return '預收金額需為正整數'
  if (amount > 99999) return '預收金額太大，請確認'
  return null
}

/** 掛號預收：開一張預收收據（算在今天） */
export function takePrepay(v: Visit, input: { amount: number; payMethod: PayMethod }, cashierId: string): VisitPrepay {
  const problem = checkPrepay(input.amount)
  if (problem) failField('prepay', problem)
  if (!['cash', 'card', 'mobile'].includes(input.payMethod)) failField('prepay', '付款方式不正確')
  if (v.prepay) fail('這筆掛號已經預收過了', 'CONFLICT')
  const t = now()
  v.prepay = { amount: input.amount, payMethod: input.payMethod, receiptNo: nextReceiptNo(t.slice(0, 10)), at: t, cashierId, refunds: [] }
  return v.prepay
}

/** 退還預收款（退掛、停診、預收多於應收）：依原付款方式，開退款單算在今天 */
export function refundPrepay(v: Visit, amount: number, reason: string, cashierId: string) {
  if (amount <= 0) return undefined
  const t = now()
  const r = { receiptNo: nextRefundNo(t.slice(0, 10)), amount, reason, cashierId, at: t }
  v.prepay!.refunds.push(r)
  return r
}
