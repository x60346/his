// 住院結帳（櫃台）：醫師簽准出院後，依住院期間算出帳單（病房費、護理費、診察費、藥費、檢驗處置、差額床費、部分負擔），
// 收款、開收據；結清（或依現有規則記欠款）才能辦出院（admission.discharge 檢查）。
// 收據和門診同一份 charges（記 admissionId），欠款、收回、作廢、日結都沿用。帳單計算在 ipd-bill（內部）＋ billing（純函式）
// 住院中可以先期中繳款（admission.interim，收的那天算日結），出院結帳時扣抵（charge.prepaidApplied），多繳的退還
import type { Admission, Charge, IpdCopaySettings, IpdInterimPayment, IpdInterimRefund, IpdInterimSettings, PayMethod } from '@/types'
import { db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requirePermission, requireUser } from './http'
import { checkCash, IPD_COPAY_DEFAULT, outstandingOf } from './billing'
import { nextReceiptNo } from './money'
import { activeIpdChargeOf, dischargeRxPending, interimAvailable, interimHeld, interimSettings, interimSuggestion, ipdBillOf, refundInterim, type IpdBill } from './ipd-bill'
import { admissionView, find, nameOf, type AdmissionView } from './views'
import type { PayInput } from './charge'

export interface IpdBillingItem {
  admissionId: string
  admitNo: string
  patientName: string
  chartNo: string
  bedNo: string
  deptName: string
  doctorName: string
  admittedAt: string
  days: number
  /** 醫師已簽准出院：可以結帳 */
  dischargeReady: boolean
  /** 已結帳（有效的住院收據） */
  receiptNo?: string
  patientTotal?: number
  status: 'admitted' | 'discharged'
  /** 期中已繳（還在醫院手上的） */
  interimPaid: number
  /** 建議期中繳款的原因（住很久、累計很多） */
  suggestInterim?: string
}

/** 住院結帳清單：住院中（准出院的在前，可結帳；其他可看試算）與今天出院的（看收據） */
export function listIpdBilling(): Promise<IpdBillingItem[]> {
  return query(() => {
    requireUser('clerk', 'admin')
    const t = today()
    return db.admissions
      .filter((a) => (!a.obs || a.obs.outcome === 'admit') && (a.status === 'admitted' || (a.status === 'discharged' && a.dischargedAt?.startsWith(t))))
      .map((a) => {
        const v = admissionView(a)
        const c = activeIpdChargeOf(a.id)
        const suggest = a.status === 'admitted' && !c ? interimSuggestion(a, ipdBillOf(a)) : undefined
        return {
          admissionId: a.id, admitNo: a.admitNo, patientName: v.patientName, chartNo: v.chartNo, bedNo: v.bed?.bedNo ?? '', deptName: v.deptName, doctorName: v.doctorName,
          admittedAt: a.admittedAt ?? '', days: v.days, dischargeReady: v.dischargeReady, status: a.status as 'admitted' | 'discharged',
          ...(c ? { receiptNo: c.receiptNo, patientTotal: c.patientTotal } : {}),
          interimPaid: interimHeld(a), ...(suggest ? { suggestInterim: suggest } : {}),
        }
      })
      .sort((x, y) => Number(y.dischargeReady) - Number(x.dischargeReady) || Number(!!x.receiptNo) - Number(!!y.receiptNo) || x.bedNo.localeCompare(y.bedNo))
  })
}

export interface IpdBillView {
  admission: AdmissionView
  /** 還沒結帳：到今天為止的試算 */
  bill?: IpdBill
  /** 已結帳：收據 */
  charge?: Charge & { cashierName: string; outstanding: number; canVoid?: string }
  /** 為什麼還不能結帳（醫師還沒簽准出院） */
  blocked?: string
  copay: IpdCopaySettings
  interim: IpdInterimView
}

export interface IpdInterimView {
  payments: (IpdInterimPayment & { cashierName: string; canVoid?: string })[]
  refunds: (IpdInterimRefund & { cashierName: string })[]
  /** 還在醫院手上的（繳了 − 退了） */
  held: number
  /** 還沒結帳時：到今天為止還要繳多少（試算 − 已繳；負數＝多繳，出院結帳時退還） */
  due?: number
  /** 現在最多還能期中繳多少（已結帳、准出院後就不收期中繳款：直接出院結帳） */
  max: number
  /** 為什麼現在不能期中繳款 */
  blocked?: string
  suggest?: string
  settings: IpdInterimSettings
}

function interimViewOf(a: Admission, bill?: IpdBill): IpdInterimView {
  const t = today()
  const settled = activeIpdChargeOf(a.id)
  const held = interimHeld(a)
  const blocked = a.status !== 'admitted' ? '病人已出院' : settled ? '已出院結帳：期中繳款已扣抵' : a.dischargeSummary?.signedAt ? '醫師已簽准出院：請直接出院結帳（期中繳款會扣抵）' : undefined
  const due = bill ? bill.patientTotal - interimAvailable(a) : undefined
  const suggest = bill ? interimSuggestion(a, bill) : undefined
  return {
    payments: (a.interim ?? []).map((p) => {
      const canVoid = p.voided ? '已作廢' : a.status !== 'admitted' ? '病人已出院' : p.at.slice(0, 10) !== t ? '不是今天收的，不能作廢（多繳的出院結帳時退還）' : settled ? '已出院結帳扣抵：要先作廢出院結帳收據' : undefined
      return { ...p, cashierName: nameOf.user(p.cashierId), ...(canVoid ? { canVoid } : {}) }
    }),
    refunds: (a.interimRefunds ?? []).map((r) => ({ ...r, cashierName: nameOf.user(r.cashierId) })),
    held,
    ...(due !== undefined ? { due } : {}),
    max: blocked || due === undefined ? 0 : Math.max(0, due),
    ...(blocked ? { blocked } : due !== undefined && due <= 0 ? { blocked: '目前的費用已經繳清' } : {}),
    ...(suggest ? { suggest } : {}),
    settings: interimSettings(),
  }
}

/** 一位住院病人的帳單：已結帳回收據，沒結帳回試算 */
export function getIpdBill(admissionId: string): Promise<IpdBillView> {
  return query(() => {
    requireUser('clerk', 'admin')
    const a = must(find.admission(admissionId), '住院紀錄')
    const c = activeIpdChargeOf(a.id)
    const view = { admission: admissionView(a), copay: db.billingSettings.ipdCopay ?? IPD_COPAY_DEFAULT } as IpdBillView
    if (c) {
      const canVoid = a.status === 'discharged' ? '病人已出院，住院收據不能作廢' : c.paidAt.slice(0, 10) !== today() ? '不是今天收的，不能作廢' : c.repayments?.length ? '欠款已收回過，不能作廢' : undefined
      view.charge = { ...c, cashierName: nameOf.user(c.cashierId), outstanding: outstandingOf(c), ...(canVoid ? { canVoid } : {}) }
    } else if (a.status === 'admitted') {
      view.bill = ipdBillOf(a)
      if (!a.dischargeSummary?.signedAt) view.blocked = '醫師還沒簽准出院：可以先看試算，簽准後才能結帳'
      else if (dischargeRxPending(a)) view.blocked = '出院帶藥還沒調劑：住院藥局調好（扣帳）後帳單才完整，才能結帳'
    }
    view.interim = interimViewOf(a, view.bill)
    return view
  })
}

/** 住院結帳：醫師簽准出院後才可以；帳單在這裡重新計算（不收畫面送來的金額）。現金可記欠款（同門診規則） */
export function payIpd(admissionId: string, input: Pick<PayInput, 'payMethod' | 'received' | 'owe'>): Promise<Charge> {
  return mutate(() => {
    const cashier = requirePermission('charge.pay')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('只有住院中的病人可以結帳', 'CONFLICT')
    if (!a.dischargeSummary?.signedAt) fail('醫師還沒簽准出院，不能結帳', 'CONFLICT')
    if (activeIpdChargeOf(a.id)) fail('這次住院已經結帳了', 'CONFLICT')
    if (dischargeRxPending(a)) fail('出院帶藥還沒調劑：請住院藥局先調劑，再結帳', 'CONFLICT')
    const bill = ipdBillOf(a)
    // 期中繳款扣抵：本次應收＝總帳 − 期中已繳；繳的比總帳多，差額開退款單退還
    const avail = Math.max(0, interimAvailable(a))
    const applied = Math.min(avail, bill.patientTotal)
    const due = bill.patientTotal - applied
    const received = input.payMethod === 'cash' ? input.received : due
    const owe = !!input.owe
    if (owe && input.payMethod !== 'cash') fail('刷卡、行動支付以應收金額扣款，不能記欠款')
    if (owe && !input.owe!.reason.trim()) failField('oweReason', '請輸入欠款原因')
    if (input.payMethod === 'cash') {
      const problem = checkCash(due, received, owe)
      if (problem) failField('received', problem)
    }
    const t = now()
    const owed = owe ? due - received : 0
    const charge: Charge = {
      id: newId('C'), visitId: '', admissionId: a.id, ipd: bill.meta, patientId: a.patientId, lines: bill.lines, nhiPoints: bill.nhiPoints, patientTotal: bill.patientTotal,
      payMethod: input.payMethod, received, change: owe ? 0 : received - due,
      receiptNo: nextReceiptNo(t.slice(0, 10)), cashierId: cashier.id, paidAt: t, voided: false,
      ...(owe ? { owed, oweReason: input.owe!.reason.trim(), repayments: [] } : {}),
      ...(applied ? { prepaidApplied: applied } : {}),
    }
    db.charges.push(charge)
    const excess = refundInterim(a, avail - applied, '期中繳款多於住院總費用，退還差額', cashier.id)
    audit('住院結帳', `${charge.receiptNo} ${a.admitNo} ${find.patient(a.patientId)?.name} 住院 ${bill.meta.days} 天 ${bill.patientTotal} 元${applied ? `（扣抵期中繳款 ${applied} 元，本次收 ${due} 元）` : ''}${owed ? `（欠 ${owed} 元：${charge.oweReason}）` : ''}${excess ? `；退還多繳 ${excess.amount} 元（${excess.receiptNo}）` : ''}`)
    return charge
  })
}

/** 住院部分負擔設定（管理員）：三段比率（%）與每次住院上限（元） */
export function saveIpdCopay(input: IpdCopaySettings): Promise<IpdCopaySettings> {
  return mutate(() => {
    const u = requireUser('admin')
    const e: Record<string, string> = {}
    input.rates.forEach((r, i) => {
      if (!Number.isInteger(r) || r < 0 || r > 100) e[`rate${i}`] = '0–100 的整數'
    })
    if (!Number.isInteger(input.cap) || input.cap < 0 || input.cap > 1_000_000) e.cap = '0–1,000,000 的整數（0＝不設上限）'
    failFields(e)
    const old = db.billingSettings.ipdCopay ?? IPD_COPAY_DEFAULT
    const next: IpdCopaySettings = { rates: [...input.rates] as IpdCopaySettings['rates'], cap: input.cap }
    db.billingSettings = { ...db.billingSettings, ipdCopay: next, updatedAt: now(), updatedBy: u.id }
    audit('修改收費設定', `住院部分負擔 ${old.rates.join('/')}% 上限 ${old.cap} → ${next.rates.join('/')}% 上限 ${next.cap}`)
    return next
  })
}

// ---------- 期中繳款 ----------

/**
 * 期中繳款（櫃台）：住院中、還沒簽准出院才收；最多收到「目前試算 − 已繳」（不收保證金、不多收），不能記欠款。
 * 收據算在今天的日結；出院結帳時扣抵
 */
export function payInterim(admissionId: string, input: { amount: number; payMethod: PayMethod }): Promise<IpdInterimPayment> {
  return mutate(() => {
    const cashier = requirePermission('charge.pay')
    const a = must(find.admission(admissionId), '住院紀錄')
    const v = interimViewOf(a, a.status === 'admitted' ? ipdBillOf(a) : undefined)
    if (v.blocked) fail(`不能期中繳款：${v.blocked}`, 'CONFLICT')
    if (!['cash', 'card', 'mobile'].includes(input.payMethod)) failField('payMethod', '付款方式不正確')
    if (typeof input.amount !== 'number' || !Number.isInteger(input.amount) || input.amount <= 0) failField('amount', '繳款金額需為正整數')
    if (input.amount > v.max) failField('amount', `最多 ${v.max.toLocaleString()} 元（到今天的費用 − 已繳；不預收還沒發生的費用）`)
    const t = now()
    const bill = ipdBillOf(a)
    const p: IpdInterimPayment = {
      id: newId('II'), receiptNo: nextReceiptNo(t.slice(0, 10)), amount: input.amount, payMethod: input.payMethod, at: t, cashierId: cashier.id,
      asOf: t.slice(0, 10), billTotal: bill.patientTotal, paidBefore: v.held,
    }
    ;(a.interim ??= []).push(p)
    audit('期中繳款', `${p.receiptNo} ${a.admitNo} ${find.patient(a.patientId)?.name} 繳 ${p.amount} 元（截至 ${p.asOf} 費用 ${p.billTotal} 元，之前已繳 ${p.paidBefore} 元）`)
    return p
  })
}

/** 作廢期中繳款（收錯）：只限當天、還沒出院結帳扣抵；之後多繳的在出院結帳時退還 */
export function voidInterim(admissionId: string, paymentId: string, reason: string): Promise<IpdInterimPayment> {
  return mutate(() => {
    const u = requirePermission('charge.pay')
    const a = must(find.admission(admissionId), '住院紀錄')
    const p = must(a.interim?.find((x) => x.id === paymentId), '期中繳款')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫作廢原因')
    const canVoid = interimViewOf(a).payments.find((x) => x.id === p.id)?.canVoid
    if (canVoid) fail(`不能作廢：${canVoid}`, 'CONFLICT')
    p.voided = { at: now(), by: u.id, reason: why! }
    audit('作廢期中繳款', `${p.receiptNo} ${a.admitNo} ${p.amount} 元：${why}`)
    return p
  })
}

/** 期中繳款提醒設定（管理員） */
export function saveIpdInterim(input: IpdInterimSettings): Promise<IpdInterimSettings> {
  return mutate(() => {
    const u = requireUser('admin')
    const e: Record<string, string> = {}
    if (!Number.isInteger(input.days) || input.days < 0 || input.days > 365) e.days = '0–365 的整數（0＝不用天數提醒）'
    if (!Number.isInteger(input.amount) || input.amount < 0 || input.amount > 10_000_000) e.amount = '0–10,000,000 的整數（0＝不用金額提醒）'
    failFields(e)
    const old = interimSettings()
    const next: IpdInterimSettings = { days: input.days, amount: input.amount }
    db.billingSettings = { ...db.billingSettings, ipdInterim: next, updatedAt: now(), updatedBy: u.id }
    audit('修改收費設定', `期中繳款提醒 ${old.days} 天／${old.amount} 元 → ${next.days} 天／${next.amount} 元`)
    return next
  })
}

export interface IpdStatement {
  admission: AdmissionView
  /** 列印時間（截至） */
  at: string
  identityName: string
  bill: Pick<IpdBill, 'lines' | 'meta' | 'nhiPoints' | 'patientTotal'>
  /** 已出院結帳：收據號（明細就是收據的內容） */
  receiptNo?: string
  payments: { receiptNo: string; at: string; amount: number; payMethod: PayMethod }[]
  refunded: number
  /** 期中已繳（還在醫院手上的） */
  interimPaid: number
  /** 還要繳（負數＝多繳，出院結帳時退還）；已結帳是 0 */
  stillDue: number
}

/**
 * 住院費用明細（截至現在）：給病人、家屬看或列印。櫃台、護理站都可以查（護理站常被家屬問「到今天多少錢」），
 * 只看不收款。已出院結帳的顯示收據內容
 */
export function getIpdStatement(admissionId: string): Promise<IpdStatement> {
  return query(() => {
    requireUser('clerk', 'nurse', 'admin')
    const a = must(find.admission(admissionId), '住院紀錄')
    const c = activeIpdChargeOf(a.id)
    const bill = c ? { lines: c.lines, meta: c.ipd!, nhiPoints: c.nhiPoints, patientTotal: c.patientTotal } : ipdBillOf(a)
    const p = find.patient(a.patientId)
    const identity = db.identities.find((x) => x.code === p?.defaultIdentity) ?? db.identities[0]
    const held = interimHeld(a)
    return {
      admission: admissionView(a), at: now(), identityName: identity.name,
      bill: { lines: bill.lines, meta: bill.meta, nhiPoints: bill.nhiPoints, patientTotal: bill.patientTotal },
      ...(c ? { receiptNo: c.receiptNo } : {}),
      payments: (a.interim ?? []).filter((x) => !x.voided).map((x) => ({ receiptNo: x.receiptNo, at: x.at, amount: x.amount, payMethod: x.payMethod })),
      refunded: (a.interimRefunds ?? []).reduce((n, r) => n + r.amount, 0),
      interimPaid: held,
      stillDue: c ? 0 : bill.patientTotal - interimAvailable(a),
    }
  })
}
