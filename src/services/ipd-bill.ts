// 住院帳單的資料整理（內部模組，index 不匯出、不會被包成 API）：從住院紀錄、床位紀錄、調劑與扣帳、已執行的醫囑
// 組出 calcIpdChargeLines 的輸入。結帳（ipd-charge）、出院前檢查（admission.discharge）共用，兩邊算的一定一樣。
import type { Admission, Charge, ChargeLine, IpdBillMeta, IpdInterimRefund, IpdInterimSettings, PayMethod } from '@/types'
import { db } from '@/mock/db'
import { addDays, diffDays, now, today } from '@/utils/date'
import { dietOfDay } from './nutrition-rules'
import { nextRefundNo } from './money'
import { calcChargeLines, calcIpdChargeLines, IPD_COPAY_DEFAULT, IPD_INTERIM_DEFAULT, summarize, type IpdBillInput, type ObsItems } from './billing'
import { billingLookup, find } from './views'
import { erBillMode } from './er-rules'
import { keptMedications } from './rx-rules'
import { certFeeLines, certsOfAdmission } from './certificate-fee'
import { isolatedDays } from './flag-work'
import { bloodFeeItems } from './blood-work'
import { surgeryFeeItems } from './surgery-work'

/**
 * 床位分段：每張床住了幾天（加總＝住院天數）。舊資料沒有床位紀錄，視為整段住目前的床。
 * 單人房那幾天如果在隔離中（病情需要），記 waivedDays：差額免收
 */
function bedSegments(a: Admission, from: string, to: string, days: number): IpdBillInput['beds'] {
  const hist = a.bedHistory?.length ? a.bedHistory : a.bedId ? [{ bedId: a.bedId, from: a.admittedAt ?? from }] : []
  if (!hist.length) return [{ bedNo: '—', bedClass: '健保床', days, extraFee: 0 }]
  const segs = hist.map((h, i) => {
    // 急診留觀轉住院：住院從結束留觀那天起算，留觀床那段併到起算日（觀察床費另依時數算在急診）
    const start = (i === 0 || h.from < from ? from : h.from).slice(0, 10)
    const end = (hist[i + 1]?.from ?? to).slice(0, 10)
    const bed = find.bed(h.bedId)
    return { bedNo: bed?.bedNo ?? h.bedId, bedClass: bed?.bedClass ?? '健保床', days: Math.max(0, diffDays(start, end)), extraFee: bed?.extraFee ?? 0, start, waivedDays: 0 }
  })
  // 當天入院當天出院、或同一天轉床：天數至少 1，算給最後住的那張床
  const counted = segs.reduce((n, s) => n + s.days, 0)
  if (counted < days) segs[segs.length - 1].days += days - counted
  for (const s of segs) if (s.bedClass === '單人房' && s.extraFee > 0) s.waivedDays = isolatedDays(a.patientId, s.start, s.days)
  // 同一張床（轉出又轉回）合併
  const merged: IpdBillInput['beds'] = []
  for (const s of segs) {
    const same = merged.find((m) => m.bedNo === s.bedNo)
    const { start: _s, waivedDays, ...seg } = s
    if (same) {
      same.days += s.days
      if (waivedDays) same.waivedDays = (same.waivedDays ?? 0) + waivedDays
    } else if (s.days > 0) merged.push({ ...seg, ...(waivedDays ? { waivedDays } : {}) })
  }
  return merged
}

/**
 * 藥：實際扣帳的量——UD 調劑核對送出的（有扣帳異動的才算），減掉退回點收的；
 * 加上病房常備給藥、藥局直送（異動單號帶住院號）。依扣帳那天的藥價
 */
function drugsOf(a: Admission): IpdBillInput['drugs'] {
  const out: IpdBillInput['drugs'] = []
  for (const d of db.udDispenses) {
    for (const l of d.lines) {
      if (l.admissionId !== a.id || !l.txnId) continue
      const drug = find.drug(l.drugId)
      if (!drug) continue
      const back = (l.returns ?? []).reduce((n, r) => n + r.qty, 0)
      const txn = db.stockTxns.find((t) => t.id === l.txnId)
      out.push({ drug, qty: l.qty - back, date: txn?.at ?? d.dispensedAt })
    }
  }
  // 病房常備、藥局直送、出院帶藥（單號結尾是住院號）；出院帶藥退回的扣掉
  for (const t of db.stockTxns) {
    if ((t.type !== 'dispense' && t.type !== 'return') || !t.ref?.endsWith(` ${a.admitNo}`)) continue
    const drug = find.drug(t.drugId)
    if (drug) out.push({ drug, qty: -t.qty, date: t.at })
  }
  return out
}

/** 已執行的檢驗、處置、影像（臨時醫囑做完的）；住院每日計費項目不算（另外依天數）。加上輸血：交叉試驗、發出的血品（依血庫紀錄） */
function proceduresOf(a: Admission): IpdBillInput['procedures'] {
  return [...ordersDone(a), ...bloodFeeItems(a.id), ...surgeryFeeItems(a.id)]
}

function ordersDone(a: Admission): IpdBillInput['procedures'] {
  return db.ipdOrders
    .filter((o) => o.admissionId === a.id && o.category === 'procedure' && o.status === 'done' && o.procId)
    .flatMap((o) => {
      const proc = find.procedure(o.procId!)
      return proc && !proc.dailyFee ? [{ proc, qty: 1, date: o.stopAt ?? o.startAt }] : []
    })
}

/** 急診留觀住院的藥與檢驗處置（離院、轉院時併進急診那次就醫在批價結） */
export const obsItemsOf = (a: Admission): ObsItems => ({ drugs: drugsOf(a), procedures: proceduresOf(a) })

/** 住院從哪一刻起算：急診留觀轉住院從結束留觀起算；其他從報到 */
export const wardFromOf = (a: Admission) => (a.obs?.outcome === 'admit' && a.obs.endAt ? a.obs.endAt : a.admittedAt ?? a.reservedAt)

/**
 * 急診收住院（直接或留觀後）：急診那次就醫的費用併入住院帳單，名稱標「急診：」（帳單分一段「急診」）。
 * 急診部分負擔、藥品部分負擔不收——健保點數一起算住院部分負擔；掛號費照收
 */
export function erLinesOf(a: Admission): ChargeLine[] {
  const v = a.fromVisitId ? find.visit(a.fromVisitId) : undefined
  if (!v?.er || erBillMode(v.er) !== 'ipd' || v.er.disposition?.admissionId !== a.id) return []
  const e = find.encounterOfVisit(v.id)
  if (!e) return []
  // 急診開的藥退回藥局的扣掉（門診有收據時是走部分退費；這裡沒有收據，直接少算）
  const kept = { ...e, medications: keptMedications(e.medications, db.dispenses.find((d) => d.visitId === v.id)) }
  return calcChargeLines(v, kept, billingLookup(v.identityCode))
    .filter((l) => l.kind !== 'copay-basic' && l.kind !== 'copay-drug')
    .map((l) => ({ ...l, name: `急診：${l.name}` }))
}

/**
 * 伙食費（自費、每日）：住院的每一天依當天有效的飲食醫囑（以午餐時間為準）找主檔的伙食費價格（依那天的價格，有生效日），
 * 禁食、沒有飲食醫囑的那天不收。急診留觀期間不收（從住院起算日開始）
 */
function mealItems(a: Admission, from: string, days: number): IpdBillInput['procedures'] {
  const orders = db.ipdOrders.filter((o) => o.admissionId === a.id && o.category === 'diet')
  const out: IpdBillInput['procedures'] = []
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i)
    const d = dietOfDay(orders, date)
    if (!d || d.kind === 'npo') continue
    const proc = db.procedures.find((p) => p.active && p.meal?.includes(d.kind))
    if (proc) out.push({ proc, qty: 1, date })
  }
  return out
}

export interface IpdBill {
  lines: ChargeLine[]
  meta: IpdBillMeta
  nhiPoints: number
  patientTotal: number
  identityCode: string
  identityName: string
}

/** 這次住院到 to（預設今天）為止的帳單 */
export function ipdBillOf(a: Admission, to: string = today()): IpdBill {
  const from = wardFromOf(a).slice(0, 10)
  const p = find.patient(a.patientId)
  const identity = db.identities.find((x) => x.code === p?.defaultIdentity) ?? db.identities[0]
  const days = Math.max(1, diffDays(from, to.slice(0, 10)))
  const { lines: base, meta } = calcIpdChargeLines({
    identity, from, to,
    beds: bedSegments(a, from, to, days),
    daily: db.procedures.filter((x) => x.dailyFee && x.active),
    drugs: drugsOf(a),
    procedures: [...proceduresOf(a), ...mealItems(a, from, days)],
    copay: db.billingSettings.ipdCopay ?? IPD_COPAY_DEFAULT,
    erLines: erLinesOf(a),
  })
  // 診斷證明書費（自費，不計入部分負擔）
  const lines = [...base, ...certFeeLines(certsOfAdmission(a.id))]
  return { lines, meta, ...summarize(lines), identityCode: identity.code, identityName: identity.name }
}

/** 這次住院目前有效的住院收據（沒作廢、沒退費） */
export const activeIpdChargeOf = (admissionId: string): Charge | undefined => db.charges.find((c) => c.admissionId === admissionId && !c.voided)

/** 有出院帶藥但藥局還沒調劑（調好才結帳：帳單依扣帳量） */
export const dischargeRxPending = (a: Admission) => !!a.dischargeSummary?.meds?.length && !a.dischargeRx

// ---------- 期中繳款：住院中先繳一部分，出院結帳時扣抵（和門診掛號預收同一套：收的那天算收入、結帳那天扣抵） ----------

export const interimSettings = (): IpdInterimSettings => db.billingSettings.ipdInterim ?? IPD_INTERIM_DEFAULT

const livePayments = (a: Admission) => (a.interim ?? []).filter((p) => !p.voided)
/** 期中繳款還在醫院手上的：繳了（沒作廢的）− 已退還 */
export const interimHeld = (a: Admission): number =>
  livePayments(a).reduce((n, p) => n + p.amount, 0) - (a.interimRefunds ?? []).reduce((n, r) => n + r.amount, 0)
/** 還沒被出院結帳扣抵的（出院結帳收據作廢後，期中繳款回到這次住院，重新結帳時再扣抵） */
export const interimAvailable = (a: Admission): number => interimHeld(a) - (activeIpdChargeOf(a.id)?.prepaidApplied ?? 0)

/**
 * 要不要提醒櫃台收期中繳款：還沒簽准出院、還沒結帳，且「還沒繳的自付金額」大於 0，
 * 再加上「距入院或上次期中繳款滿 N 天」或「還沒繳的達 M 元」任一條件（0＝不用該條件）。回傳提醒文字
 */
export function interimSuggestion(a: Admission, bill: Pick<IpdBill, 'patientTotal'>, at: string = today()): string | undefined {
  if (a.status !== 'admitted' || a.dischargeSummary?.signedAt || activeIpdChargeOf(a.id)) return undefined
  const unpaid = bill.patientTotal - interimAvailable(a)
  if (unpaid <= 0) return undefined
  const s = interimSettings()
  const last = livePayments(a).map((p) => p.at).sort().at(-1)
  const since = (last ?? a.admittedAt ?? a.reservedAt).slice(0, 10)
  const days = diffDays(since, at.slice(0, 10)) + (last ? 0 : 1)
  const why: string[] = []
  if (s.days > 0 && days >= s.days) why.push(last ? `距上次期中繳款 ${days} 天` : `住院第 ${days} 天`)
  if (s.amount > 0 && unpaid >= s.amount) why.push(`還沒繳的自付 ${unpaid.toLocaleString()} 元`)
  return why.length ? `建議期中繳款：${why.join('、')}` : undefined
}

/** 退還期中繳款（出院結帳時多繳的差額）：依原付款方式，從最近一筆繳款的方式先退；開退款單算在今天 */
export function refundInterim(a: Admission, amount: number, reason: string, cashierId: string): IpdInterimRefund | undefined {
  if (amount <= 0) return undefined
  const left = new Map<PayMethod, number>()
  for (const p of livePayments(a)) left.set(p.payMethod, (left.get(p.payMethod) ?? 0) + p.amount)
  for (const r of a.interimRefunds ?? []) for (const x of r.parts) left.set(x.payMethod, (left.get(x.payMethod) ?? 0) - x.amount)
  const order = [...new Set(livePayments(a).sort((x, y) => y.at.localeCompare(x.at)).map((p) => p.payMethod))]
  const parts: IpdInterimRefund['parts'] = []
  let rest = amount
  for (const m of order) {
    const take = Math.min(rest, Math.max(0, left.get(m) ?? 0))
    if (take > 0) parts.push({ payMethod: m, amount: take })
    rest -= take
  }
  const t = now()
  const r: IpdInterimRefund = { receiptNo: nextRefundNo(t.slice(0, 10)), amount, parts, reason, cashierId, at: t }
  ;(a.interimRefunds ??= []).push(r)
  return r
}
