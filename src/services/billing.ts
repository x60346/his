// 門診批價計算（純函式，seed 與服務層共用）。
// 規則為展示用的簡化版本：
//   1. 掛號費依就醫身分
//   2. 基本部分負擔：每次固定金額（免部分負擔身分、預防保健案件免收）
//   3. 藥品部分負擔：健保藥費在免收額度以下免收，超過後每一級距加收固定金額，有上限
//   金額都來自 BillingSettings（管理員可調整）；這裡只有「怎麼算」，沒有「算多少」
//      （免部分負擔身分、慢性病連續處方調劑免收）
//   4. 診察費、健保藥費、健保醫令列為健保申報點數；自費項目由病患全額自付
//   5. 自費身分：所有項目以自費價計算，不申報健保
import type { BillingSettings, ChargeLine, Drug, Encounter, Identity, Procedure, Visit } from '@/types'

export const CONSULT_PROC_ID = 'P001'

/** 藥品部分負擔（純函式）：收費設定頁的即時試算也用它，畫面與批價永遠算出同一個數字 */
export function drugCopay(nhiDrugTotal: number, s: BillingSettings): number {
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

function regLine(identity: Identity): ChargeLine {
  return { kind: 'reg', name: `掛號費（${identity.name}）`, qty: 1, unitPrice: identity.regFee, amount: identity.regFee, patientPay: true }
}

function consultLine(identity: Identity, consult: Procedure | undefined): ChargeLine | undefined {
  if (!consult) return undefined
  return identity.selfPay
    ? { kind: 'consult', name: consult.name, qty: 1, unitPrice: consult.selfPrice, amount: consult.selfPrice, patientPay: true }
    : { kind: 'consult', name: consult.name, qty: 1, unitPrice: consult.points, amount: consult.points, patientPay: false }
}

/** 基本部分負擔：自費身分、免部分負擔身分、預防保健（A3）案件不收 */
function basicCopayLine(identity: Identity, caseType: string, s: BillingSettings): ChargeLine | undefined {
  if (identity.selfPay || identity.copayExempt || caseType === 'A3') return undefined
  return { kind: 'copay-basic', name: '門診基本部分負擔', qty: 1, unitPrice: s.basicCopay, amount: s.basicCopay, patientPay: true }
}

/** 掛號時就確定的收費項目（掛號頁預估用）；批價時這幾行與它完全相同，再加上看診內容的項目 */
export function fixedCharges(identity: Identity, caseType: string, lk: Pick<BillingLookup, 'settings' | 'procedure'>): ChargeLine[] {
  return [regLine(identity), consultLine(identity, lk.procedure(CONSULT_PROC_ID)), basicCopayLine(identity, caseType, lk.settings)].filter((l): l is ChargeLine => !!l)
}

export function calcChargeLines(visit: Visit, enc: Encounter, lk: BillingLookup): ChargeLine[] {
  const selfPayVisit = lk.identity.selfPay
  const lines: ChargeLine[] = []

  lines.push(regLine(lk.identity))
  const consult = consultLine(lk.identity, lk.procedure(CONSULT_PROC_ID))
  if (consult) lines.push(consult)

  let nhiDrugTotal = 0
  for (const m of enc.medications) {
    const d = lk.drug(m.drugId)
    if (!d) continue
    if (selfPayVisit || m.selfPay) {
      lines.push({ kind: 'self', name: `${d.name}（自費）`, qty: m.qty, unitPrice: d.selfPrice, amount: round(d.selfPrice * m.qty), patientPay: true })
    } else {
      const amount = round(d.nhiPrice * m.qty)
      nhiDrugTotal += amount
      lines.push({ kind: 'drug', name: d.name, qty: m.qty, unitPrice: d.nhiPrice, amount, patientPay: false })
    }
  }

  for (const p of enc.procedures) {
    const proc = lk.procedure(p.procId)
    if (!proc) continue
    // 健保點數為 0 的項目（證明書等）一律自費
    if (selfPayVisit || p.selfPay || proc.points === 0) {
      lines.push({ kind: 'self', name: `${proc.name}（自費）`, qty: p.qty, unitPrice: proc.selfPrice, amount: proc.selfPrice * p.qty, patientPay: true })
    } else {
      lines.push({ kind: 'procedure', name: proc.name, qty: p.qty, unitPrice: proc.points, amount: proc.points * p.qty, patientPay: false })
    }
  }

  const basic = basicCopayLine(lk.identity, visit.caseType, lk.settings)
  if (basic) lines.push(basic)
  if (!selfPayVisit && !lk.identity.copayExempt) {
    const dc = visit.caseType === '08' ? 0 : drugCopay(nhiDrugTotal, lk.settings)
    if (dc > 0) {
      lines.push({ kind: 'copay-drug', name: '藥品部分負擔', qty: 1, unitPrice: dc, amount: dc, patientPay: true })
    }
  }

  return lines
}

/** 找零達到這個金額就視為輸入錯誤（門診部分負擔不可能需要找零上萬元，多半是多打了 0） */
export const MAX_CASH_CHANGE = 10000

/** 現金收款檢查（純函式，頁面即時提示與服務層共用）：有問題回傳訊息，沒問題回傳 null */
export function checkCash(total: number, received: number | undefined): string | null {
  if (received === undefined || received === null || Number.isNaN(received)) return '請輸入實收金額'
  if (!Number.isInteger(received)) return '實收金額需為整數'
  if (received < total) return `實收金額不足，應收 ${total} 元`
  if (received - total >= MAX_CASH_CHANGE) return `找零 ${(received - total).toLocaleString()} 元，金額異常，請確認實收金額`
  return null
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
