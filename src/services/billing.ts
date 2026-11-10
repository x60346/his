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

export function calcChargeLines(visit: Visit, enc: Encounter, lk: BillingLookup): ChargeLine[] {
  const selfPayVisit = lk.identity.selfPay
  const lines: ChargeLine[] = []

  lines.push({ kind: 'reg', name: `掛號費（${lk.identity.name}）`, qty: 1, unitPrice: lk.identity.regFee, amount: lk.identity.regFee, patientPay: true })

  const consult = lk.procedure(CONSULT_PROC_ID)
  if (consult) {
    lines.push(
      selfPayVisit
        ? { kind: 'consult', name: consult.name, qty: 1, unitPrice: consult.selfPrice, amount: consult.selfPrice, patientPay: true }
        : { kind: 'consult', name: consult.name, qty: 1, unitPrice: consult.points, amount: consult.points, patientPay: false },
    )
  }

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

  if (!selfPayVisit && !lk.identity.copayExempt) {
    if (visit.caseType !== 'A3') {
      lines.push({ kind: 'copay-basic', name: '門診基本部分負擔', qty: 1, unitPrice: lk.settings.basicCopay, amount: lk.settings.basicCopay, patientPay: true })
    }
    const dc = visit.caseType === '08' ? 0 : drugCopay(nhiDrugTotal, lk.settings)
    if (dc > 0) {
      lines.push({ kind: 'copay-drug', name: '藥品部分負擔', qty: 1, unitPrice: dc, amount: dc, patientPay: true })
    }
  }

  return lines
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
