// 門診批價計算（純函式，seed 與服務層共用）。
// 規則為展示用的簡化版本：
//   1. 掛號費依就醫身分
//   2. 基本部分負擔：每次固定金額，經轉診（持外院轉診單）收較低的金額（免部分負擔身分、預防保健案件免收）
//   3. 藥品部分負擔：健保藥費在免收額度以下免收，超過後每一級距加收固定金額，有上限
//   金額都來自 BillingSettings（管理員可調整）；這裡只有「怎麼算」，沒有「算多少」
//      （免部分負擔身分、慢性病連續處方調劑免收）
//   4. 診察費、健保藥費、健保醫令列為健保申報點數；自費項目由病患全額自付
//   5. 自費身分：所有項目以自費價計算，不申報健保
//   6. 價格一律看「看診日」：藥價、醫令點數、掛號費、部分負擔都可以排定某天起生效（dated-rules），
//      調整前看診、調整後才批價的，收看診那天的價格
import type { BillingSettings, Charge, ChargeLine, CopayValues, DiscountRule, Drug, Encounter, Identity, IpdBillMeta, IpdCopaySettings, IpdInterimSettings, Procedure, Visit } from '@/types'
import { diffDays } from '@/utils/date'
import { drugPriceOn } from './drug-rules'
import { valueOn } from './dated-rules'
import { erEndAt, erObsBlocks } from './er-rules'

// ---------- 某天的價格（依看診日） ----------
export const COPAY_KEYS = ['basicCopay', 'basicCopayReferred', 'erCopayUrgent', 'erCopay', 'drugCopayFreeUpTo', 'drugCopayStep', 'drugCopayPerStep', 'drugCopayMax'] as const

/** 只取部分負擔參數（不帶 changes、修改人） */
export const pickCopay = (s: CopayValues): CopayValues => ({ basicCopay: s.basicCopay, basicCopayReferred: s.basicCopayReferred, erCopayUrgent: s.erCopayUrgent, erCopay: s.erCopay, drugCopayFreeUpTo: s.drugCopayFreeUpTo, drugCopayStep: s.drugCopayStep, drugCopayPerStep: s.drugCopayPerStep, drugCopayMax: s.drugCopayMax })

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
/** 急診：診察費（取代門診診察費）、觀察床費（每 6 小時） */
export const ER_CONSULT_PROC_ID = 'P044'
export const ER_OBS_PROC_ID = 'P045'

/** 急診部分負擔：依檢傷級數（1、2 級一個金額，3–5 級一個金額）；自費、免部分負擔身分不收 */
function erCopayLine(identity: Identity, level: number, s: CopayValues): ChargeLine | undefined {
  if (identity.selfPay || identity.copayExempt) return undefined
  const amount = level <= 2 ? s.erCopayUrgent : s.erCopay
  return { kind: 'copay-basic', name: `急診部分負擔（檢傷 ${level} 級）`, qty: 1, unitPrice: amount, amount, patientPay: true }
}

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
  /** 這次就醫的基本部分負擔要不要比照經轉診（服務層依住院紀錄判斷出院後回診）；沒給就只看 visit.referralIn */
  referredOf?: (v: Visit) => CopayReferred
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

/** 比照經轉診的原因：持外院轉診單（含同一療程回診）、出院後回診；true 視同「經轉診」 */
export type CopayReferred = boolean | '經轉診' | '出院後回診' | undefined

/** 基本部分負擔：自費身分、免部分負擔身分、預防保健（A3）案件不收；經轉診（referred）收經轉診的金額，名稱標出原因 */
function basicCopayLine(identity: Identity, caseType: string, s: CopayValues, referred: CopayReferred = false): ChargeLine | undefined {
  if (identity.selfPay || identity.copayExempt || caseType === 'A3') return undefined
  const amount = referred ? s.basicCopayReferred : s.basicCopay
  return { kind: 'copay-basic', name: referred ? `門診基本部分負擔（${referred === true ? '經轉診' : referred}）` : '門診基本部分負擔', qty: 1, unitPrice: amount, amount, patientPay: true }
}

/** 掛號時就確定的收費項目（掛號頁預估用，date＝看診日）；批價時這幾行與它完全相同，再加上看診內容的項目 */
export function fixedCharges(identity: Identity, caseType: string, lk: Pick<BillingLookup, 'settings' | 'procedure'>, date: string, referred: CopayReferred = false): ChargeLine[] {
  return [regLine(identity, date), consultLine(identity, lk.procedure(CONSULT_PROC_ID), date), basicCopayLine(identity, caseType, copayOn(lk.settings, date), referred)].filter((l): l is ChargeLine => !!l)
}

/** 急診留觀期間的藥與檢驗處置（留觀住院實際扣帳、做完的）：離院、轉院時跟急診一起在批價結；依扣帳或執行那天的價格 */
export interface ObsItems {
  drugs: { drug: Drug; qty: number; date: string; /** 事前審查改自費 */ selfPay?: boolean }[]
  procedures: { proc: Procedure; qty: number; date: string; /** 事前審查改自費 */ selfPay?: boolean }[]
}

export function calcChargeLines(visit: Visit, enc: Encounter, lk: BillingLookup, obs?: ObsItems): ChargeLine[] {
  const selfPayVisit = lk.identity.selfPay
  const lines: ChargeLine[] = []

  // 慢箋領藥（refillOf）不看診：沒有掛號費、診察費、基本部分負擔，只有藥（藥品部分負擔 08 案件本來就免）
  const refill = !!visit.refillOf
  const date = visit.date
  const copay = copayOn(lk.settings, date)
  if (!refill) {
    lines.push(regLine(lk.identity, date))
    // 急診：急診診察費取代門診診察費；到院到離開急診滿 6 小時，每 6 小時收一單位觀察床費
    const consult = consultLine(lk.identity, lk.procedure(visit.er ? ER_CONSULT_PROC_ID : CONSULT_PROC_ID), date)
    if (consult) lines.push(consult)
    const obs = visit.er ? lk.procedure(ER_OBS_PROC_ID) : undefined
    const blocks = visit.er ? erObsBlocks(visit.er.arrivedAt, erEndAt(visit.er, enc.completedAt)) : 0
    if (obs && blocks) {
      const price = procPriceOn(obs, date)
      lines.push(lk.identity.selfPay ? { kind: 'self', name: `${obs.name}（自費）`, qty: blocks, unitPrice: price.selfPrice, amount: price.selfPrice * blocks, patientPay: true } : { kind: 'procedure', name: obs.name, qty: blocks, unitPrice: price.points, amount: price.points * blocks, patientPay: false })
    }
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

  // 留觀期間的藥（同藥同價合併；退回的負數抵掉），算進藥品部分負擔
  if (obs) {
    const merged: ChargeLine[] = []
    for (const x of obs.drugs) {
      if (!x.qty) continue
      const price = drugPriceOn(x.drug, x.date.slice(0, 10))
      const self = selfPayVisit
      const l: ChargeLine = self ? { kind: 'self', name: `${x.drug.name}（留觀，自費）`, qty: x.qty, unitPrice: price.selfPrice, amount: round(price.selfPrice * x.qty), patientPay: true } : { kind: 'drug', name: `${x.drug.name}（留觀）`, qty: x.qty, unitPrice: price.nhiPrice, amount: round(price.nhiPrice * x.qty), patientPay: false }
      const same = merged.find((m) => m.name === l.name && m.unitPrice === l.unitPrice)
      if (same) Object.assign(same, { qty: Math.round((same.qty + l.qty) * 100) / 100, amount: round(same.amount + l.amount) })
      else merged.push(l)
    }
    for (const l of merged.filter((m) => m.qty > 0)) {
      if (l.kind === 'drug') nhiDrugTotal += l.amount
      lines.push(l)
    }
    for (const x of obs.procedures) {
      const price = procPriceOn(x.proc, x.date.slice(0, 10))
      lines.push(selfPayVisit || price.points === 0 ? { kind: 'self', name: `${x.proc.name}（留觀，自費）`, qty: x.qty, unitPrice: price.selfPrice, amount: price.selfPrice * x.qty, patientPay: true } : { kind: 'procedure', name: `${x.proc.name}（留觀）`, qty: x.qty, unitPrice: price.points, amount: price.points * x.qty, patientPay: false })
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

  const basic = refill ? undefined : visit.er ? erCopayLine(lk.identity, visit.er.level, copay) : basicCopayLine(lk.identity, visit.caseType, copay, lk.referredOf ? lk.referredOf(visit) : visit.referralIn ? '經轉診' : false)
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
export function outstandingOf(c: Pick<Charge, 'owed' | 'repayments' | 'voided' | 'partialRefunds'>): number {
  if (c.voided) return 0
  // 部分退費會先抵欠款（見 charge.pendingRefundOf）
  return (c.owed ?? 0) - (c.repayments ?? []).reduce((s, r) => s + r.amount, 0) - (c.partialRefunds ?? []).reduce((s, r) => s + r.owedOffset, 0)
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
  const copay = lines.filter((l) => l.kind === 'copay-basic' || l.kind === 'copay-drug' || l.kind === 'copay-ipd').reduce((s, l) => s + l.amount, 0)
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

// ---------- 住院帳單（出院結帳） ----------

/**
 * 住院部分負擔預設：急性病房 30 日內 10%、31–60 日 20%、61 日起 30%；每次住院上限（展示用數值，實際依健保署每年公告）。
 * 收費設定可改（BillingSettings.ipdCopay）
 */
export const IPD_COPAY_DEFAULT: IpdCopaySettings = { rates: [10, 20, 30], cap: 57000 }
/** 住院期中繳款提醒的預設：距入院（或上次繳款）滿 30 天、或還沒繳的自付金額達 30,000 元 */
export const IPD_INTERIM_DEFAULT: IpdInterimSettings = { days: 30, amount: 30000 }

/** 住院天數：入院當天算、出院（結帳）當天不算；當天入院當天出院算 1 天 */
export const ipdDays = (from: string, to: string) => Math.max(1, diffDays(from.slice(0, 10), to.slice(0, 10)))

/**
 * 住院部分負擔：健保費用平均到每一天，依「住院第幾天」的比率分段計算（30 日內、31–60 日、61 日起），
 * 加總後超過每次住院上限就截掉。回傳各段（帳單上列出來，病人看得懂為什麼是這個數）
 */
export function ipdCopay(nhiTotal: number, days: number, s: IpdCopaySettings): { amount: number; tiers: IpdBillMeta['copay']; capped?: number } {
  const perDay = nhiTotal / Math.max(1, days)
  const bounds: [number, number][] = [[1, 30], [31, 60], [61, Number.POSITIVE_INFINITY]]
  const tiers: IpdBillMeta['copay'] = []
  bounds.forEach(([from, to], i) => {
    const end = Math.min(to, days)
    if (end < from) return
    tiers.push({ fromDay: from, toDay: end, rate: s.rates[i], amount: Math.round((perDay * (end - from + 1) * s.rates[i]) / 100) })
  })
  const raw = tiers.reduce((n, t) => n + t.amount, 0)
  const amount = s.cap > 0 ? Math.min(raw, s.cap) : raw // 上限 0＝不設上限
  return { amount, tiers, ...(raw > amount ? { capped: raw - amount } : {}) }
}

export interface IpdBillInput {
  identity: Identity
  /** 入院日、結帳日（YYYY-MM-DD 或含時間） */
  from: string
  to: string
  /** 各床位住了幾天（加總＝住院天數）；差額床費依 extraFee */
  beds: { bedNo: string; bedClass: string; days: number; extraFee: number; waivedDays?: number; icu?: boolean }[]
  /** 每日計費項目（病房費、護理費、住院診察費），依住院天數；加護病床的（icu）依住加護病房的天數，一般病床的（generalBed）扣掉那幾天 */
  daily: Procedure[]
  /** 藥：實際扣帳的量（調劑扣的減退回的，加病房常備給藥扣的），date 用來查當天的藥價 */
  drugs: { drug: Drug; qty: number; date: string; /** 事前審查改自費 */ selfPay?: boolean }[]
  /** 已執行的檢驗、處置、影像 */
  procedures: { proc: Procedure; qty: number; date: string; /** 事前審查改自費 */ selfPay?: boolean }[]
  copay: IpdCopaySettings
  /** 急診收住院：急診那次就醫的費用（已標「急診：」），健保點數一起算住院部分負擔 */
  erLines?: ChargeLine[]
}

/**
 * 住院帳單明細（純函式：結帳、試算、種子、測試共用）。
 *   - 每日計費 × 天數；藥依扣帳量、當天藥價；檢驗處置依執行日的點數（點數 0 的一律自費）
 *   - 差額床費（雙人房、單人房）＝每日差額 × 那張床住的天數，自費
 *   - 自費身分：全部用自費價、沒有部分負擔；免部分負擔的身分（重大傷病、低收入等）部分負擔 0
 *   - 部分負擔依健保費用分段計算（ipdCopay），從申報點數扣掉、由病人付
 */
export function calcIpdChargeLines(input: IpdBillInput): { lines: ChargeLine[]; meta: IpdBillMeta } {
  const self = input.identity.selfPay
  const days = ipdDays(input.from, input.to)
  const lines: ChargeLine[] = []
  const add = (l: ChargeLine) => {
    const same = lines.find((x) => x.kind === l.kind && x.name === l.name && x.unitPrice === l.unitPrice)
    if (same) {
      same.qty = Math.round((same.qty + l.qty) * 100) / 100
      same.amount = round(same.amount + l.amount)
    } else lines.push(l)
  }
  const icuDays = Math.min(days, input.beds.filter((b) => b.icu).reduce((n, b) => n + b.days, 0))
  for (const p of input.daily) {
    const price = procPriceOn(p, input.from.slice(0, 10))
    // 加護病床的只收住加護病房的天數；一般病床的病房費、護理費扣掉那幾天；住院診察費每天都收
    const qty = p.icu ? icuDays : p.generalBed ? days - icuDays : days
    if (!qty) continue
    add(self ? { kind: 'self', name: `${p.name}（自費）`, qty, unitPrice: price.selfPrice, amount: price.selfPrice * qty, patientPay: true } : { kind: 'ward', name: p.name, qty, unitPrice: price.points, amount: price.points * qty, patientPay: false })
  }
  // 退回的是負數（出院帶藥退回）：和扣帳的同藥同價合併抵銷，合併後數量是 0 的整列拿掉
  for (const x of input.drugs) {
    if (x.qty === 0) continue
    const price = drugPriceOn(x.drug, x.date.slice(0, 10))
    add(self || x.selfPay ? { kind: 'self', name: `${x.drug.name}（自費）`, qty: x.qty, unitPrice: price.selfPrice, amount: round(price.selfPrice * x.qty), patientPay: true } : { kind: 'drug', name: x.drug.name, qty: x.qty, unitPrice: price.nhiPrice, amount: round(price.nhiPrice * x.qty), patientPay: false })
  }
  for (const x of input.procedures) {
    const price = procPriceOn(x.proc, x.date.slice(0, 10))
    add(self || x.selfPay || price.points === 0 ? { kind: 'self', name: `${x.proc.name}（自費）`, qty: x.qty, unitPrice: price.selfPrice, amount: price.selfPrice * x.qty, patientPay: true } : { kind: 'procedure', name: x.proc.name, qty: x.qty, unitPrice: price.points, amount: price.points * x.qty, patientPay: false })
  }
  for (let i = lines.length - 1; i >= 0; i--) if ((lines[i].kind === 'drug' || lines[i].kind === 'self') && lines[i].qty <= 0) lines.splice(i, 1)
  lines.push(...(input.erLines ?? []))
  for (const b of input.beds) {
    // 隔離期間住單人房是病情需要：那幾天差額免收（列一行 0 元，看得出為什麼沒收）
    const waived = Math.min(b.days, b.waivedDays ?? 0)
    const charged = b.days - waived
    if (b.extraFee > 0 && charged > 0) lines.push({ kind: 'self', name: `差額床費（${b.bedClass} ${b.bedNo}）`, qty: charged, unitPrice: b.extraFee, amount: b.extraFee * charged, patientPay: true })
    if (b.extraFee > 0 && waived > 0) lines.push({ kind: 'self', name: `差額床費（${b.bedClass} ${b.bedNo}，隔離期間免收）`, qty: waived, unitPrice: 0, amount: 0, patientPay: true })
  }
  const nhiTotal = lines.filter((l) => !l.patientPay).reduce((n, l) => n + l.amount, 0)
  const cp = self || input.identity.copayExempt ? { amount: 0, tiers: [] as IpdBillMeta['copay'] } : ipdCopay(nhiTotal, days, input.copay)
  if (cp.amount > 0) lines.push({ kind: 'copay-ipd', name: '住院部分負擔', qty: 1, unitPrice: cp.amount, amount: cp.amount, patientPay: true })
  return {
    lines,
    meta: { from: input.from.slice(0, 10), to: input.to.slice(0, 10), days, beds: input.beds, copay: cp.tiers, ...('capped' in cp && cp.capped ? { capped: cp.capped } : {}) },
  }
}
