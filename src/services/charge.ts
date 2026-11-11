// 批價：試算、結帳、作廢、日結報表。
// 結帳成功 → 掛號狀態 charged；有開藥則自動產生藥局調劑單（領藥號）。
import type { Charge, ChargeLine, PayMethod, Repayment } from '@/types'
import { db, nextCounter, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { calcChargeLines, checkCash, checkRepay, outstandingOf, summarize } from './billing'
import { audit, fail, failField, must, mutate, query, requireUser } from './http'
import { billingLookup, find, nameOf, visitView, type VisitView } from './views'

export interface ChargeListItem extends VisitView {
  charge?: Charge
  /** 待批價者的應收（與結帳試算同一個計算 buildPreview）：清單上就看得到要收多少，不必一個個點進去 */
  estimate?: number
}

const pickupNoOf = (visitId: string) => db.dispenses.find((d) => d.visitId === visitId)?.pickupNo

/** 批價清單：當日看完診（待批價）與已批價的病人 */
export function listChargeQueue(date: string): Promise<ChargeListItem[]> {
  return query(() =>
    db.visits
      .filter((v) => v.date === date && ['consulted', 'charged', 'dispensed'].includes(v.status))
      .map((v) => ({
        ...visitView(v),
        charge: db.charges.find((c) => c.visitId === v.id && !c.voided),
        estimate: v.status === 'consulted' ? buildPreview(v.id).patientTotal : undefined,
      }))
      .sort((a, b) => Number(!!a.charge) - Number(!!b.charge) || a.seqNo - b.seqNo),
  )
}

export interface ChargePreview {
  visit: VisitView
  lines: ChargeLine[]
  nhiPoints: number
  patientTotal: number
}

function buildPreview(visitId: string): ChargePreview {
  const v = must(find.visit(visitId), '掛號紀錄')
  const e = must(find.encounterOfVisit(visitId), '病歷')
  const lines = calcChargeLines(v, e, billingLookup(v.identityCode))
  return { visit: visitView(v), lines, ...summarize(lines) }
}

/** 試算：畫面上先顯示明細，確認後才結帳 */
export function previewCharge(visitId: string): Promise<ChargePreview> {
  return query(() => {
    const v = must(find.visit(visitId), '掛號紀錄')
    if (v.status !== 'consulted') fail('此病人尚未完成看診或已批價')
    return buildPreview(visitId)
  })
}

/** 收據號：依「開立那天」流水編號（結帳、收回欠款共用同一個序號） */
const nextReceiptNo = (date: string) => `R${date.replace(/-/g, '')}${String(nextCounter(`receipt:${date}`)).padStart(4, '0')}`

export interface PayInput {
  payMethod: PayMethod
  received: number
  /** 實收不足時，差額記為欠款（只限現金；刷卡、行動支付一定是足額扣款） */
  owe?: { reason: string }
}

export function pay(visitId: string, input: PayInput): Promise<Charge> {
  return mutate(() => {
    const cashier = requireUser('clerk')
    const v = must(find.visit(visitId), '掛號紀錄')
    if (v.status !== 'consulted') fail('此病人尚未完成看診或已批價', 'CONFLICT')
    const e = must(find.encounterOfVisit(visitId), '病歷')
    const pv = buildPreview(visitId)
    // 刷卡、行動支付金額必定等於應收
    const received = input.payMethod === 'cash' ? input.received : pv.patientTotal
    const owe = !!input.owe
    if (owe && input.payMethod !== 'cash') fail('刷卡、行動支付以應收金額扣款，不能記欠款')
    if (owe && !input.owe!.reason.trim()) failField('oweReason', '請輸入欠款原因')
    if (input.payMethod === 'cash') {
      const problem = checkCash(pv.patientTotal, received, owe)
      if (problem) failField('received', problem)
    }

    const owed = owe ? pv.patientTotal - received : 0
    const charge: Charge = {
      id: newId('C'), visitId, patientId: v.patientId, lines: pv.lines, nhiPoints: pv.nhiPoints, patientTotal: pv.patientTotal,
      payMethod: input.payMethod, received, change: owe ? 0 : received - pv.patientTotal,
      receiptNo: nextReceiptNo(v.date),
      cashierId: cashier.id, paidAt: now(), voided: false,
      ...(owe ? { owed, oweReason: input.owe!.reason.trim(), repayments: [] } : {}),
    }
    db.charges.push(charge)
    v.status = 'charged'

    if (e.medications.length) {
      db.dispenses.push({
        id: newId('DP'), visitId, encounterId: e.id, patientId: v.patientId,
        pickupNo: nextCounter(`pickup:${v.date}`), status: 'pending', createdAt: now(),
      })
    }
    audit('批價結帳', `${charge.receiptNo} ${find.patient(v.patientId)?.name} ${pv.patientTotal} 元${owed ? `（欠 ${owed} 元：${charge.oweReason}）` : ''}`)
    return charge
  })
}

/** 作廢：已發藥的不可作廢（需先退藥）；作廢後掛號回到待批價，醫師可修改病歷 */
export function voidCharge(chargeId: string, reason: string): Promise<Charge> {
  return mutate(() => {
    requireUser('clerk')
    if (!reason.trim()) fail('請輸入作廢原因')
    const c = must(db.charges.find((x) => x.id === chargeId), '收費紀錄')
    if (c.voided) fail('此收據已作廢')
    const dp = db.dispenses.find((d) => d.visitId === c.visitId)
    // 訊息不能指向不存在的功能：本系統沒有退藥，要明說，使用者才不會到處找「退藥」按鈕
    if (dp?.status === 'dispensed') fail('藥品已發出，收據無法作廢。實務上需先辦理退藥，本展示系統未提供退藥功能。', 'CONFLICT')
    // 已收回過欠款：作廢後那筆收回的錢就沒有對應的帳。要先退還，本系統未提供退款
    if (c.repayments?.length) fail('這張收據的欠款已收回過，無法作廢。實務上需先辦理退款，本展示系統未提供退款功能。', 'CONFLICT')
    c.voided = true
    db.dispenses = db.dispenses.filter((d) => d.visitId !== c.visitId)
    const v = must(find.visit(c.visitId), '掛號紀錄')
    v.status = 'consulted'
    audit('作廢收據', `${c.receiptNo}：${reason}`)
    return c
  })
}

export interface DebtItem {
  chargeId: string
  receiptNo: string
  /** 就醫日期 */
  date: string
  deptName: string
  patientTotal: number
  owed: number
  outstanding: number
  oweReason?: string
  repayments: Repayment[]
}

/** 病人尚未還清的欠款（舊的在前）：批價頁選到這個病人時列出，可逐筆收回 */
export function listDebts(patientId: string): Promise<DebtItem[]> {
  return query(() => debtsOf(patientId))
}

function debtsOf(patientId: string): DebtItem[] {
  return db.charges
    .filter((c) => c.patientId === patientId && outstandingOf(c) > 0)
    .map((c) => {
      const v = find.visit(c.visitId)
      return {
        chargeId: c.id, receiptNo: c.receiptNo, date: v?.date ?? c.paidAt.slice(0, 10), deptName: nameOf.dept(v?.deptId),
        patientTotal: c.patientTotal, owed: c.owed ?? 0, outstanding: outstandingOf(c), oweReason: c.oweReason, repayments: c.repayments ?? [],
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** 收回欠款（可分次、可只收一部分）。收據號依「收回那天」編，日結也算在那天 */
export function repayDebt(chargeId: string, input: { payMethod: PayMethod; amount: number }): Promise<Repayment> {
  return mutate(() => {
    const cashier = requireUser('clerk')
    const c = must(db.charges.find((x) => x.id === chargeId), '收費紀錄')
    if (c.voided) fail('此收據已作廢', 'CONFLICT')
    const problem = checkRepay(outstandingOf(c), input.amount)
    if (problem) failField('amount', problem)
    const t = today()
    const r: Repayment = { id: newId('RP'), amount: input.amount, payMethod: input.payMethod, receiptNo: nextReceiptNo(t), cashierId: cashier.id, at: now() }
    ;(c.repayments ??= []).push(r)
    audit('收回欠款', `${r.receiptNo} ${find.patient(c.patientId)?.name} ${r.amount} 元（原收據 ${c.receiptNo}，尚欠 ${outstandingOf(c)} 元）`)
    return r
  })
}

export interface ReceiptView extends Charge {
  visit: VisitView
  cashierName: string
  /** 有開藥時的領藥號 */
  pickupNo?: number
}

export function getReceipt(chargeId: string): Promise<ReceiptView> {
  return query(() => {
    const c = must(db.charges.find((x) => x.id === chargeId), '收費紀錄')
    return {
      ...c,
      visit: visitView(must(find.visit(c.visitId), '掛號紀錄')),
      cashierName: nameOf.user(c.cashierId),
      pickupNo: c.voided ? undefined : pickupNoOf(c.visitId),
    }
  })
}

export interface ChargeDetail {
  visit: VisitView
  /** 待批價時：試算結果 */
  preview?: ChargePreview
  /** 已批價時：收據 */
  receipt?: ReceiptView
  /** 這個病人尚未還清的欠款（含本次以外的就醫） */
  debts: DebtItem[]
}

/**
 * 批價畫面右側所需的全部資料，一次取得。
 * 如果頁面先看清單上的狀態、再決定呼叫試算或收據，清單一旦過期（例如剛結帳完、清單還沒刷新），
 * 就會用錯誤的狀態發出請求。在同一個時間點讀狀態並組好資料，就沒有這種不同步。
 */
export function getChargeDetail(visitId: string): Promise<ChargeDetail> {
  return query(() => {
    const v = must(find.visit(visitId), '掛號紀錄')
    const charge = db.charges.find((c) => c.visitId === visitId && !c.voided)
    return {
      visit: visitView(v),
      preview: v.status === 'consulted' ? buildPreview(visitId) : undefined,
      receipt: charge
        ? { ...charge, visit: visitView(v), cashierName: nameOf.user(charge.cashierId), pickupNo: pickupNoOf(visitId) }
        : undefined,
      debts: debtsOf(v.patientId),
    }
  })
}

export interface DailyReport {
  date: string
  count: number
  voidedCount: number
  /** 應收合計：當日有效收據的金額（含記欠款的部分）。依科別、依費用類別都以這個為準 */
  patientTotal: number
  nhiPoints: number
  /** 當日結帳時新記下的欠款 */
  newDebt: number
  /** 當日收回的欠款（不論原本是哪一天欠的） */
  repaid: number
  /** 實收 = 應收 − 新欠款 + 收回欠款：錢箱、刷卡機加起來應該是這個數 */
  collected: number
  /** 依付款方式：實際收到的錢（加總 = 實收） */
  byPayMethod: Record<PayMethod, number>
  /** 當日收回欠款明細 */
  repayments: { receiptNo: string; at: string; patientName: string; chartNo: string; amount: number; payMethod: PayMethod; originalReceiptNo: string; cashierName: string }[]
  byDept: { deptName: string; count: number; patientTotal: number; nhiPoints: number }[]
  charges: (Charge & { patientName: string; chartNo: string; deptName: string })[]
  /** 作廢收據的金額合計（以前只有張數） */
  voidedTotal: number
  /** 依收費人員：交班時各自對自己的錢箱，所以是實際收到的錢；加總 = 實收 */
  byCashier: { cashierName: string; count: number; repayCount: number; collected: number }[]
  /** 依費用類別（取自收據當時存下的明細，不用現在的設定重算）；加總 = 收入合計 */
  byFeeType: { reg: number; basicCopay: number; drugCopay: number; selfPay: number }
  /** 當天看完診、還沒批價的病人（下班前漏收就會出現在這裡）；預估與批價試算同一個計算 */
  unpaid: { visitId: string; patientName: string; chartNo: string; deptName: string; doctorName: string; estimate: number }[]
}

export function dailyReport(date: string): Promise<DailyReport> {
  return query(() => {
    const all = db.charges.filter((c) => c.paidAt.startsWith(date))
    const valid = all.filter((c) => !c.voided)
    const byPayMethod: Record<PayMethod, number> = { cash: 0, card: 0, mobile: 0 }
    const dept = new Map<string, DailyReport['byDept'][number]>()
    for (const c of valid) {
      byPayMethod[c.payMethod] += c.patientTotal - (c.owed ?? 0)
      const deptName = nameOf.dept(find.visit(c.visitId)?.deptId)
      const row = dept.get(deptName) ?? { deptName, count: 0, patientTotal: 0, nhiPoints: 0 }
      row.count++
      row.patientTotal += c.patientTotal
      row.nhiPoints += c.nhiPoints
      dept.set(deptName, row)
    }
    const cashier = new Map<string, DailyReport['byCashier'][number]>()
    const cashierRow = (id: string) => {
      const name = nameOf.user(id)
      const row = cashier.get(name) ?? { cashierName: name, count: 0, repayCount: 0, collected: 0 }
      cashier.set(name, row)
      return row
    }
    const byFeeType = { reg: 0, basicCopay: 0, drugCopay: 0, selfPay: 0 }
    for (const c of valid) {
      const row = cashierRow(c.cashierId)
      row.count++
      row.collected += c.patientTotal - (c.owed ?? 0)
      const sum = (kind: string) => c.lines.filter((l) => l.patientPay && l.kind === kind).reduce((s, l) => s + l.amount, 0)
      const reg = sum('reg')
      const basic = sum('copay-basic')
      const drug = sum('copay-drug')
      byFeeType.reg += reg
      byFeeType.basicCopay += basic
      byFeeType.drugCopay += drug
      // 自費（含自費身分的診察費）用「收據總額 − 其他三類」：收據總額四捨五入過，這樣四類加總一定等於收入合計
      byFeeType.selfPay += c.patientTotal - reg - basic - drug
    }
    // 收回欠款：算在收回那天（原收據可能是更早的日子）。作廢的收據不會有收回紀錄（有收回就不能作廢）
    const repayments: DailyReport['repayments'] = []
    for (const c of db.charges) {
      for (const rp of c.repayments ?? []) {
        if (!rp.at.startsWith(date)) continue
        byPayMethod[rp.payMethod] += rp.amount
        const row = cashierRow(rp.cashierId)
        row.repayCount++
        row.collected += rp.amount
        const p = find.patient(c.patientId)
        repayments.push({ receiptNo: rp.receiptNo, at: rp.at, patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', amount: rp.amount, payMethod: rp.payMethod, originalReceiptNo: c.receiptNo, cashierName: nameOf.user(rp.cashierId) })
      }
    }
    repayments.sort((a, b) => a.receiptNo.localeCompare(b.receiptNo))
    const patientTotal = valid.reduce((s, c) => s + c.patientTotal, 0)
    const newDebt = valid.reduce((s, c) => s + (c.owed ?? 0), 0)
    const repaid = repayments.reduce((s, x) => s + x.amount, 0)
    const unpaid = db.visits
      .filter((v) => v.date === date && v.status === 'consulted')
      .map((v) => {
        const vv = visitView(v)
        return { visitId: v.id, patientName: vv.patientName, chartNo: vv.chartNo, deptName: vv.deptName, doctorName: vv.doctorName, estimate: buildPreview(v.id).patientTotal }
      })
    return {
      date,
      count: valid.length,
      voidedCount: all.length - valid.length,
      voidedTotal: all.filter((c) => c.voided).reduce((s, c) => s + c.patientTotal, 0),
      byCashier: [...cashier.values()].sort((a, b) => b.collected - a.collected),
      byFeeType,
      unpaid,
      patientTotal,
      newDebt,
      repaid,
      collected: patientTotal - newDebt + repaid,
      repayments,
      nhiPoints: valid.reduce((s, c) => s + c.nhiPoints, 0),
      byPayMethod,
      byDept: [...dept.values()].sort((a, b) => b.patientTotal - a.patientTotal),
      charges: all
        .map((c) => {
          const p = find.patient(c.patientId)
          return { ...c, patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', deptName: nameOf.dept(find.visit(c.visitId)?.deptId) }
        })
        .sort((a, b) => a.receiptNo.localeCompare(b.receiptNo)),
    }
  })
}
