// 收付款的服務層內部工具（不在 services/index.ts 對外）：收據、退款單的編號，掛號預收款還剩多少。
// 批價（charge）、掛號（booking）、停診（schedule）共用——每一筆收錢、退錢都有自己的單號、算在發生那天的日結。
import type { Charge, PayMethod, Refund, Visit, VisitPrepay } from '@/types'
import { db, nextCounter } from '@/mock/db'
import { now } from '@/utils/date'
import { fail, failField, must } from './http'
import { applyDiscount, calcChargeLines, outstandingOf, summarize } from './billing'
import { keptMedications, returnedQty } from './rx-rules'
import { billingLookup, find } from './views'

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

// ---------- 退費：可退的錢、部分退藥後的差額 ----------

/**
 * 病人實際付過、還沒退的錢，依付款方式：結帳時付的（應收 − 記欠款）＋ 每次收回欠款 − 部分退費已退的。
 * 整張退費時預收扣抵的部分不在這裡退（預收款屬於這次就醫，重新批價時再扣抵）；
 * 部分退費（withPrepaid）不會重新批價，扣抵的預收視同已付、依預收時的付款方式退
 */
export function refundParts(c: Charge, withPrepaid = false): Refund['parts'] {
  const by = new Map<PayMethod, number>()
  const add = (m: PayMethod, n: number) => n && by.set(m, (by.get(m) ?? 0) + n)
  add(c.payMethod, c.patientTotal - (c.owed ?? 0) - (c.prepaidApplied ?? 0))
  if (withPrepaid && c.prepaidApplied) add(find.visit(c.visitId)?.prepay?.payMethod ?? c.payMethod, c.prepaidApplied)
  for (const r of c.repayments ?? []) add(r.payMethod, r.amount)
  for (const pr of c.partialRefunds ?? []) for (const x of pr.parts) add(x.payMethod, -x.amount)
  return [...by.entries()].filter(([, amount]) => amount > 0).map(([payMethod, amount]) => ({ payMethod, amount }))
}

export interface PendingRefund {
  /** 應付減少多少（＝抵欠款＋退還） */
  amount: number
  /** 先抵還沒收回的欠款 */
  owedOffset: number
  /** 退還病人 */
  cash: number
  /** 依原付款方式怎麼退 */
  parts: Refund['parts']
  /** 健保申報點數減少 */
  nhiPoints: number
  /** 重算後的應付（病人實際拿走的藥） */
  patientTotalAfter: number
  /** 退了哪些藥（累計） */
  items: string[]
}

/**
 * 部分退藥後的待退費：用病人實際拿走的藥（處方 − 已退）、同一個看診日價格、同一個身分與優免重算，
 * 和原收據（扣掉已經部分退過的）比。藥品部分負擔是分級的，退了藥可能剛好降一級，差額一起退；
 * 也可能部分負擔不變而退 0 元（只有申報點數減少）。全部退完的不在這裡：整張作廢或退費（醫師可重新開）
 */
export function pendingRefundOf(c: Charge): PendingRefund | undefined {
  if (c.voided) return undefined
  const d = db.dispenses.find((x) => x.visitId === c.visitId)
  if (!d?.returns?.length || d.status === 'returned') return undefined
  const v = must(find.visit(c.visitId), '掛號紀錄')
  const e = must(find.encounterOfVisit(c.visitId), '病歷')
  const base = calcChargeLines(v, { ...e, medications: keptMedications(e.medications, d) }, billingLookup(v.identityCode))
  // 優免用結帳時的類別（之後被停用也照用，不必重新核准）
  const rule = c.discount ? db.discounts.find((x) => x.code === c.discount!.code) : undefined
  const sum = summarize(rule ? applyDiscount(base, rule) : base)
  const done = c.partialRefunds ?? []
  const amount = Math.max(0, c.patientTotal - done.reduce((n, x) => n + x.amount, 0) - sum.patientTotal)
  const nhiPoints = Math.max(0, c.nhiPoints - done.reduce((n, x) => n + x.nhiPoints, 0) - sum.nhiPoints)
  if (!amount && !nhiPoints) return undefined
  const owedOffset = Math.min(outstandingOf(c), amount)
  const cash = amount - owedOffset
  // 依原付款方式：先退結帳時的方式，再退其他（收回欠款、預收）
  const avail = refundParts(c, true).sort((a, b) => Number(b.payMethod === c.payMethod) - Number(a.payMethod === c.payMethod))
  const parts: Refund['parts'] = []
  let left = cash
  for (const x of avail) {
    const n = Math.min(left, x.amount)
    if (n > 0) parts.push({ payMethod: x.payMethod, amount: n })
    left -= n
  }
  if (left > 0) parts.push({ payMethod: c.payMethod, amount: left })
  const items = e.medications
    .map((m, i) => ({ name: find.drug(m.drugId)?.name ?? m.drugId, qty: returnedQty(d, i), unit: find.drug(m.drugId)?.unit ?? '' }))
    .filter((x) => x.qty > 0)
    .map((x) => `${x.name} ${x.qty} ${x.unit}`)
  return { amount, owedOffset, cash, parts, nhiPoints, patientTotalAfter: sum.patientTotal, items }
}

