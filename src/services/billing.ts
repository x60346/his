// 門診批價計算（純函式，seed 與服務層共用）。
// 規則為展示用的簡化版本：
//   1. 掛號費依就醫身分
//   2. 基本部分負擔：每次固定金額（免部分負擔身分、預防保健案件免收）
//   3. 藥品部分負擔：健保藥費在免收額度以下免收，超過後每一級距加收固定金額，有上限
//   金額都來自 BillingSettings（管理員可調整）；這裡只有「怎麼算」，沒有「算多少」
//      （免部分負擔身分、慢性病連續處方調劑免收）
//   4. 診察費、健保藥費、健保醫令列為健保申報點數；自費項目由病患全額自付
//   5. 自費身分：所有項目以自費價計算，不申報健保
//   6. 價格一律看「看診日」：藥價、醫令點數、掛號費、部分負擔都可以排定某天起生效（dated-rules），
//      調整前看診、調整後才批價的，收看診那天的價格
import type { BillingSettings, Charge, ChargeLine, CopayValues, DiscountRule, Drug, Encounter, Identity, Procedure, Visit } from '@/types'
import { drugPriceOn } from './drug-rules'
import { valueOn } from './dated-rules'

// ---------- 某天的價格（依看診日） ----------
export const COPAY_KEYS = ['basicCopay', 'drugCopayFreeUpTo', 'drugCopayStep', 'drugCopayPerStep', 'drugCopayMax'] as const

/** 只取部分負擔參數（不帶 changes、修改人） */
export const pickCopay = (s: CopayValues): CopayValues => ({ basicCopay: s.basicCopay, drugCopayFreeUpTo: s.drugCopayFreeUpTo, drugCopayStep: s.drugCopayStep, drugCopayPerStep: s.drugCopayPerStep, drugCopayMax: s.drugCopayMax })

/** 醫令某天的點數與自費價 */
export function procPriceOn(p: Pick<Procedure, 'points' | 'selfPrice' | 'priceChanges'>, date: string): { points: number; selfPrice: number } {
  return valueOn({ points: p.points, selfPrice: p.selfPrice }, p.priceChanges, date, ['points', 'selfPrice'])
}
/** 就醫身分某天的掛號費 */
export function regFeeOn(i: Pick<Identity, 'regFee' | 'feeChanges'>, date: string): number {
  return valueOn({ regFee: i.regFee }, i.feeChanges, date, ['regFee']).regFee
}
/** 某天的部分負擔參數 */
export function copayOn(s: BillingSettings, date: string): CopayValues {
  return valueOn<CopayValues>(s, s.changes, date, COPAY_KEYS)
}

export const CONSULT_PROC_ID = 'P001'

/** 藥品部分負擔（純函式）：收費設定頁的即時試算也用它，畫面與批價永遠算出同一個數字 */
export function drugCopay(nhiDrugTotal: number, s: CopayValues): number {
  if (nhiDrugTotal <= s.drugCopayFreeUpTo) return 0
  return Math.min(s.drugCopayMax, Math.ceil((nhiDrugTotal - s.drugCopayFreeUpTo) / s.drugCopayStep) * s.drugCopayPerStep)
}

export interface BillingLookup {
  identity: Identity
  settings: BillingSettings
  drug: (id: string) => Drug | undefined
  procedure: (id: string) => Procedure | undefined
}

const round = (n: number) => Math.round(n * 10) / 10

// ---------- 掛號當下就確定的項目 ----------
// 掛號費、診察費、基本部分負擔只看「身分＋案件分類」，掛號時就算得出來；藥品部分負擔、自費項目要看診後才知道。
// 掛號頁的預估（fixedCharges）與批價（calcChargeLines）呼叫同一組函式，兩邊的數字不會各算各的。

function regLine(identity: Identity, date: string): ChargeLine {
  const fee = regFeeOn(identity, date)
  return { kind: 'reg', name: `掛號費（${identity.name}）`, qty: 1, unitPrice: fee, amount: fee, patientPay: true }
}

function consultLine(identity: Identity, consult: Procedure | undefined, date: string): ChargeLine | undefined {
  if (!consult) return undefined
  const price = procPriceOn(consult, date)
  return identity.selfPay
    ? { kind: 'consult', name: consult.name, qty: 1, unitPrice: price.selfPrice, amount: price.selfPrice, patientPay: true }
    : { kind: 'consult', name: consult.name, qty: 1, unitPrice: price.points, amount: price.points, patientPay: false }
}

/** 基本部分負擔：自費身分、免部分負擔身分、預防保健（A3）案件不收 */
function basicCopayLine(identity: Identity, caseType: string, s: CopayValues): ChargeLine | undefined {
  if (identity.selfPay || identity.copayExempt || caseType === 'A3') return undefined
  return { kind: 'copay-basic', name: '門診基本部分負擔', qty: 1, unitPrice: s.basicCopay, amount: s.basicCopay, patientPay: true }
}

/** 掛號時就確定的收費項目（掛號頁預估用，date＝看診日）；批價時這幾行與它完全相同，再加上看診內容的項目 */
export function fixedCharges(identity: Identity, caseType: string, lk: Pick<BillingLookup, 'settings' | 'procedure'>, date: string): ChargeLine[] {
  return [regLine(identity, date), consultLine(identity, lk.procedure(CONSULT_PROC_ID), date), basicCopayLine(identity, caseType, copayOn(lk.settings, date))].filter((l): l is ChargeLine => !!l)
}

export function calcChargeLines(visit: Visit, enc: Encounter, lk: BillingLookup): ChargeLine[] {
  const selfPayVisit = lk.identity.selfPay
  const lines: ChargeLine[] = []

  // 慢箋領藥（refillOf）不看診：沒有掛號費、診察費、基本部分負擔，只有藥（藥品部分負擔 08 案件本來就免）
  const refill = !!visit.refillOf
  const date = visit.date
  const copay = copayOn(lk.settings, date)
  if (!refill) {
    lines.push(regLine(lk.identity, date))
    const consult = consultLine(lk.identity, lk.procedure(CONSULT_PROC_ID), date)
    if (consult) lines.push(consult)
  }

  let nhiDrugTotal = 0
  for (const m of enc.medications) {
    const d = lk.drug(m.drugId)
    if (!d) continue
    // 依看診日的價格（調價日前看診、調價後才批價，仍收看診那天的價格）
    const price = drugPriceOn(d, date)
    if (selfPayVisit || m.selfPay) {
      lines.push({ kind: 'self', name: `${d.name}（自費）`, qty: m.qty, unitPrice: price.selfPrice, amount: round(price.selfPrice * m.qty), patientPay: true })
    } else {
      const amount = round(price.nhiPrice * m.qty)
      nhiDrugTotal += amount
      lines.push({ kind: 'drug', name: d.name, qty: m.qty, unitPrice: price.nhiPrice, amount, patientPay: false })
    }
  }

  for (const p of enc.procedures) {
    const proc = lk.procedure(p.procId)
    if (!proc) continue
    const price = procPriceOn(proc, date)
    // 健保點數為 0 的項目（證明書等）一律自費
    if (selfPayVisit || p.selfPay || price.points === 0) {
      lines.push({ kind: 'self', name: `${proc.name}（自費）`, qty: p.qty, unitPrice: price.selfPrice, amount: price.selfPrice * p.qty, patientPay: true })
    } else {
      lines.push({ kind: 'procedure', name: proc.name, qty: p.qty, unitPrice: price.points, amount: price.points * p.qty, patientPay: false })
    }
  }

  const basic = refill ? undefined : basicCopayLine(lk.identity, visit.caseType, copay)
  if (basic) lines.push(basic)
  if (!selfPayVisit && !lk.identity.copayExempt) {
    const dc = visit.caseType === '08' ? 0 : drugCopay(nhiDrugTotal, copay)
    if (dc > 0) {
      lines.push({ kind: 'copay-drug', name: '藥品部分負擔', qty: 1, unitPrice: dc, amount: dc, patientPay: true })
    }
  }

  return lines
}

/** 找零達到這個金額就視為輸入錯誤（門診部分負擔不可能需要找零上萬元，多半是多打了 0） */
export const MAX_CASH_CHANGE = 10000

/**
 * 現金收款檢查（純函式，頁面即時提示與服務層共用）：有問題回傳訊息，沒問題回傳 null。
 * owe：櫃台勾了「差額記為欠款」——實收可以少於應收（0 元也行），但不能足額（足額就不必記欠款）
 */
export function checkCash(total: number, received: number | undefined, owe = false): string | null {
  if (received === undefined || received === null || Number.isNaN(received)) return '請輸入實收金額'
  if (!Number.isInteger(received)) return '實收金額需為整數'
  if (received < 0) return '實收金額不能是負數'
  if (owe) return received >= total ? '實收已足額，不需記欠款' : null
  if (received < total) return `實收金額不足，應收 ${total} 元`
  if (received - total >= MAX_CASH_CHANGE) return `找零 ${(received - total).toLocaleString()} 元，金額異常，請確認實收金額`
  return null
}

/** 這張收據還欠多少：結帳時的欠款 − 已收回（作廢的收據不算欠） */
export function outstandingOf(c: Pick<Charge, 'owed' | 'repayments' | 'voided'>): number {
  if (c.voided) return 0
  return (c.owed ?? 0) - (c.repayments ?? []).reduce((s, r) => s + r.amount, 0)
}

/** 收回欠款金額檢查：整數、大於 0、不超過尚欠（多收的錢沒有地方放） */
export function checkRepay(outstanding: number, amount: number | undefined): string | null {
  if (amount === undefined || amount === null || Number.isNaN(amount)) return '請輸入收回金額'
  if (!Number.isInteger(amount) || amount <= 0) return '收回金額需為大於 0 的整數'
  if (amount > outstanding) return `超過尚欠金額 ${outstanding} 元`
  return null
}

// ---------- 優免 ----------
/** 「8 折」「8.5 折」 */
export const rateText = (rate: number) => `${rate / 10} 折`

/** 給人看的優免內容，例：「掛號費全免・自費 8 折」 */
export function discountSummary(d: Pick<DiscountRule, 'regMode' | 'regAmount' | 'selfPayRate'>): string {
  const reg = d.regMode === 'all' ? '掛號費全免' : d.regMode === 'amount' ? `掛號費減 ${d.regAmount} 元` : ''
  const self = d.selfPayRate < 100 ? `自費 ${rateText(d.selfPayRate)}` : ''
  return [reg, self].filter(Boolean).join('・') || '不減免'
}

/** 優免可以打折的自費項目：自費藥品與醫令、自費身分的診察費 */
const isSelfPayLine = (l: ChargeLine) => l.patientPay && (l.kind === 'self' || l.kind === 'consult')

/**
 * 套用優免：在明細後面加上負數的優免列（收據、日結看得到減了什麼）。
 *   - 掛號費：全免或減固定金額（不超過掛號費本身）
 *   - 自費項目：打折，減免金額四捨五入到元
 *   - 部分負擔（基本、藥品）一律不減：健保法禁止醫院自行減免部分負擔；健保申報點數也不受影響
 */
export function applyDiscount(lines: ChargeLine[], d: DiscountRule): ChargeLine[] {
  const out = [...lines]
  const reg = lines.filter((l) => l.patientPay && l.kind === 'reg').reduce((s, l) => s + l.amount, 0)
  const regOff = d.regMode === 'all' ? reg : d.regMode === 'amount' ? Math.min(d.regAmount, reg) : 0
  if (regOff > 0) out.push({ kind: 'discount', name: `優免：${d.name}（掛號費）`, qty: 1, unitPrice: -regOff, amount: -regOff, patientPay: true })
  const self = lines.filter(isSelfPayLine).reduce((s, l) => s + l.amount, 0)
  const selfOff = Math.min(Math.round((self * (100 - d.selfPayRate)) / 100), Math.round(self))
  if (selfOff > 0) out.push({ kind: 'discount', name: `優免：${d.name}（自費項目 ${rateText(d.selfPayRate)}）`, qty: 1, unitPrice: -selfOff, amount: -selfOff, patientPay: true })
  return out
}

/** 優免減免了多少（正數） */
export const discountAmountOf = (lines: ChargeLine[]) => -lines.filter((l) => l.kind === 'discount').reduce((s, l) => s + l.amount, 0)

/** 優免類別的欄位檢查（服務層與管理頁共用）；回傳欄位 → 訊息 */
export function checkDiscountRule(d: Partial<DiscountRule>): Record<string, string> {
  const e: Record<string, string> = {}
  if (!d.name?.trim()) e.name = '請輸入名稱'
  if (!['none', 'all', 'amount'].includes(d.regMode ?? '')) e.regMode = '請選擇掛號費減免方式'
  if (d.regMode === 'amount' && !(Number.isInteger(d.regAmount) && d.regAmount! >= 1 && d.regAmount! <= 2000)) e.regAmount = '減免金額需為 1–2000 的整數'
  if (!(Number.isInteger(d.selfPayRate) && d.selfPayRate! >= 0 && d.selfPayRate! <= 100)) e.selfPayRate = '自費付幾成需為 0–100 的整數（80 = 8 折，100 = 不打折）'
  else if (d.regMode === 'none' && d.selfPayRate === 100) e.selfPayRate = '掛號費不減、自費也不打折，這個優免沒有作用'
  return e
}

export function summarize(lines: ChargeLine[]): { nhiPoints: number; patientTotal: number } {
  const nhi = lines.filter((l) => !l.patientPay).reduce((s, l) => s + l.amount, 0)
  const pt = lines.filter((l) => l.patientPay).reduce((s, l) => s + l.amount, 0)
  // 部分負擔由病患支付，申報點數需扣除
  const copay = lines.filter((l) => l.kind === 'copay-basic' || l.kind === 'copay-drug').reduce((s, l) => s + l.amount, 0)
  return { nhiPoints: Math.max(0, Math.round(nhi - copay)), patientTotal: Math.round(pt) }
}

/** 藥品總量 = 每次劑量 × 每日次數 × 天數（無條件進位） */
export function calcQty(dose: number, timesPerDay: number, days: number): number {
  return Math.ceil(dose * timesPerDay * days)
}

/** 給藥單位（每次用多少）；沒有特別設定時與調劑單位相同 */
export function doseUnitOf(d: Pick<Drug, 'unit' | 'doseUnit'>): string {
  return d.doseUnit ?? d.unit
}

/**
 * 可自動換算的總量；給藥單位與調劑單位不同（Insulin 的 U 與 PEN）時無法換算，回傳 null，由醫師填寫。
 */
export function autoQty(d: Pick<Drug, 'unit' | 'doseUnit'>, dose: number, timesPerDay: number, days: number): number | null {
  if (doseUnitOf(d) !== d.unit) return null
  return calcQty(dose, timesPerDay, days)
}
