// 住院結帳（櫃台）：醫師簽准出院後，依住院期間算出帳單（病房費、護理費、診察費、藥費、檢驗處置、差額床費、部分負擔），
// 收款、開收據；結清（或依現有規則記欠款）才能辦出院（admission.discharge 檢查）。
// 收據和門診同一份 charges（記 admissionId），欠款、收回、作廢、日結都沿用。帳單計算在 ipd-bill（內部）＋ billing（純函式）
import type { Charge, IpdCopaySettings } from '@/types'
import { db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requirePermission, requireUser } from './http'
import { checkCash, IPD_COPAY_DEFAULT, outstandingOf } from './billing'
import { nextReceiptNo } from './money'
import { activeIpdChargeOf, dischargeRxPending, ipdBillOf, type IpdBill } from './ipd-bill'
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
}

/** 住院結帳清單：住院中（准出院的在前，可結帳；其他可看試算）與今天出院的（看收據） */
export function listIpdBilling(): Promise<IpdBillingItem[]> {
  return query(() => {
    requireUser('clerk', 'admin')
    const t = today()
    return db.admissions
      .filter((a) => a.status === 'admitted' || (a.status === 'discharged' && a.dischargedAt?.startsWith(t)))
      .map((a) => {
        const v = admissionView(a)
        const c = activeIpdChargeOf(a.id)
        return {
          admissionId: a.id, admitNo: a.admitNo, patientName: v.patientName, chartNo: v.chartNo, bedNo: v.bed?.bedNo ?? '', deptName: v.deptName, doctorName: v.doctorName,
          admittedAt: a.admittedAt ?? '', days: v.days, dischargeReady: v.dischargeReady, status: a.status as 'admitted' | 'discharged',
          ...(c ? { receiptNo: c.receiptNo, patientTotal: c.patientTotal } : {}),
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
}

/** 一位住院病人的帳單：已結帳回收據，沒結帳回試算 */
export function getIpdBill(admissionId: string): Promise<IpdBillView> {
  return query(() => {
    requireUser('clerk', 'admin')
    const a = must(find.admission(admissionId), '住院紀錄')
    const c = activeIpdChargeOf(a.id)
    const view: IpdBillView = { admission: admissionView(a), copay: db.billingSettings.ipdCopay ?? IPD_COPAY_DEFAULT }
    if (c) {
      const canVoid = a.status === 'discharged' ? '病人已出院，住院收據不能作廢' : c.paidAt.slice(0, 10) !== today() ? '不是今天收的，不能作廢' : c.repayments?.length ? '欠款已收回過，不能作廢' : undefined
      view.charge = { ...c, cashierName: nameOf.user(c.cashierId), outstanding: outstandingOf(c), ...(canVoid ? { canVoid } : {}) }
    } else if (a.status === 'admitted') {
      view.bill = ipdBillOf(a)
      if (!a.dischargeSummary?.signedAt) view.blocked = '醫師還沒簽准出院：可以先看試算，簽准後才能結帳'
      else if (dischargeRxPending(a)) view.blocked = '出院帶藥還沒調劑：住院藥局調好（扣帳）後帳單才完整，才能結帳'
    }
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
    const due = bill.patientTotal
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
      id: newId('C'), visitId: '', admissionId: a.id, ipd: bill.meta, patientId: a.patientId, lines: bill.lines, nhiPoints: bill.nhiPoints, patientTotal: due,
      payMethod: input.payMethod, received, change: owe ? 0 : received - due,
      receiptNo: nextReceiptNo(t.slice(0, 10)), cashierId: cashier.id, paidAt: t, voided: false,
      ...(owe ? { owed, oweReason: input.owe!.reason.trim(), repayments: [] } : {}),
    }
    db.charges.push(charge)
    audit('住院結帳', `${charge.receiptNo} ${a.admitNo} ${find.patient(a.patientId)?.name} 住院 ${bill.meta.days} 天 ${due} 元${owed ? `（欠 ${owed} 元：${charge.oweReason}）` : ''}`)
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
