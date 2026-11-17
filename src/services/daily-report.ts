// 日結報表的計算（內部模組，index 不匯出、不會被包成 API）：收費報表（charge.dailyReport）與經營月報（management）共用同一份數字。
// 權限與期間檢查在呼叫端；未收款的預估由呼叫端傳入（批價試算在 charge.ts）
import type { Charge, PayMethod } from '@/types'
import { db } from '@/mock/db'
import { addDays, diffDays } from '@/utils/date'
import { find, nameOf, visitView } from './views'

export interface DailyReport {
  /** 報表期間（單日時 date = to） */
  date: string
  to: string
  /** 依日期小計（區間報表用；單日只有一列）：加總 = 各合計 */
  byDay: { date: string; count: number; patientTotal: number; newDebt: number; repaid: number; prepaidIn: number; prepaidApplied: number; refunded: number; collected: number }[]
  /** 依月份小計（期間超過 REPORT_MONTHLY_AFTER 天才有，畫面改看這個；date 是 YYYY-MM）。匯出照樣用每日小計 */
  byMonth?: DailyReport['byDay']
  count: number
  voidedCount: number
  /** 應收合計：當日有效收據的金額（含記欠款的部分）。依科別、依費用類別都以這個為準 */
  patientTotal: number
  nhiPoints: number
  /** 當日結帳時新記下的欠款 */
  newDebt: number
  /** 當日收回的欠款（不論原本是哪一天欠的） */
  repaid: number
  /** 當日退款（不論原收據是哪一天的） */
  refunded: number
  /** 實收 = 應收 − 新欠款 − 預收扣抵 + 收回欠款 + 預收 − 退款：錢箱、刷卡機加起來應該是這個數 */
  collected: number
  /** 當日預收：掛號預收＋住院期中繳款（收進來的錢；批價、出院結帳時扣抵的另外減掉，才不會算兩次） */
  prepaidIn: number
  /** 當日有效收據扣抵掉的預收款（錢不是今天收的：可能是之前掛號時收的） */
  prepaidApplied: number
  /** visitDate：掛號預收是就醫日，期中繳款是入院日（admitNo 是住院號） */
  prepays: { receiptNo: string; at: string; kind: '掛號預收' | '期中繳款'; patientName: string; chartNo: string; amount: number; payMethod: PayMethod; cashierName: string; visitDate: string; admitNo?: string }[]
  /** 當日退款明細（退費、退還預收款） */
  refunds: { receiptNo: string; at: string; kind: '退費' | '退預收' | '部分退費' | '退期中繳款'; patientName: string; chartNo: string; amount: number; payMethods: string; originalReceiptNo: string; originalDate: string; reason: string; cashierName: string }[]
  /** 依付款方式：實際收到的錢（加總 = 實收） */
  byPayMethod: Record<PayMethod, number>
  /** 當日收回欠款明細 */
  repayments: { receiptNo: string; at: string; patientName: string; chartNo: string; amount: number; payMethod: PayMethod; originalReceiptNo: string; cashierName: string }[]
  byDept: { deptName: string; count: number; patientTotal: number; nhiPoints: number }[]
  charges: (Charge & { patientName: string; chartNo: string; deptName: string; cashierName: string })[]
  /** 作廢收據的金額合計（以前只有張數） */
  voidedTotal: number
  /** 依收費人員：交班時各自對自己的錢箱，所以是實際收到的錢；加總 = 實收 */
  byCashier: { cashierName: string; count: number; repayCount: number; prepayCount: number; refundCount: number; collected: number }[]
  /** 依費用類別（取自收據當時存下的明細，不用現在的設定重算）；加總 = 收入合計 */
  byFeeType: { reg: number; basicCopay: number; drugCopay: number; ipdCopay: number; selfPay: number; discount: number }
  /** 優免：依類別的筆數與減免金額（正數）；合計 = discountTotal */
  discounts: { name: string; count: number; amount: number }[]
  discountTotal: number
  /** 當天看完診、還沒批價的病人（下班前漏收就會出現在這裡）；預估與批價試算同一個計算 */
  unpaid: { visitId: string; date: string; patientName: string; chartNo: string; deptName: string; doctorName: string; estimate: number }[]
}

/** 區間報表最多幾天（年報表為上限） */
export const REPORT_MAX_DAYS = 366
/** 期間超過幾天，畫面的小計改成依月份（不然一年有三百多列） */
export const REPORT_MONTHLY_AFTER = 62

/**
 * 日結報表；給 to 就是區間報表（含頭尾兩天）。所有合計都依同一個「是否在期間內」判斷：
 * 收據看結帳日、收回欠款看收回日、未收款看就醫日。
 */
/** 收據的科別：門診看掛號；住院看住院科別（標「住院」，日結依科別分得出門診、住院） */
const chargeDeptName = (c: Charge) => c.copyRequestId ? '病歷影本' : (c.admissionId ? `${nameOf.dept(find.admission(c.admissionId)?.deptId)}（住院）` : nameOf.dept(find.visit(c.visitId)?.deptId))

/** 期間（含頭尾兩天）的日結：estimate＝看完診還沒批價的預估應收（批價試算） */
export function buildDailyReport(date: string, to: string, estimate: (visitId: string) => number): DailyReport {
  const inRange = (at: string) => at.slice(0, 10) >= date && at.slice(0, 10) <= to
  const all = db.charges.filter((c) => inRange(c.paidAt))
  // 有效＝沒作廢的，加上「已退費」的：退費的收據照算在原本那天（退款另算在退款那天），那天的帳不會事後改變
  const valid = all.filter((c) => !c.voided || c.refund)
  // 申報點數：部分退藥減少的點數扣掉（健保只申報病人實際拿走的藥）
  const nhiOf = (c: Charge) => c.nhiPoints - (c.partialRefunds ?? []).reduce((n, x) => n + x.nhiPoints, 0)
  const byPayMethod: Record<PayMethod, number> = { cash: 0, card: 0, mobile: 0 }
  const dept = new Map<string, DailyReport['byDept'][number]>()
  for (const c of valid) {
    byPayMethod[c.payMethod] += c.patientTotal - (c.owed ?? 0) - (c.prepaidApplied ?? 0)
    const deptName = chargeDeptName(c)
    const row = dept.get(deptName) ?? { deptName, count: 0, patientTotal: 0, nhiPoints: 0 }
    row.count++
    row.patientTotal += c.patientTotal
    row.nhiPoints += nhiOf(c)
    dept.set(deptName, row)
  }
  const cashier = new Map<string, DailyReport['byCashier'][number]>()
  const cashierRow = (id: string) => {
    const name = nameOf.user(id)
    const row = cashier.get(name) ?? { cashierName: name, count: 0, repayCount: 0, prepayCount: 0, refundCount: 0, collected: 0 }
    cashier.set(name, row)
    return row
  }
  const byFeeType = { reg: 0, basicCopay: 0, drugCopay: 0, ipdCopay: 0, selfPay: 0, discount: 0 }
  const disc = new Map<string, { name: string; count: number; amount: number }>()
  for (const c of valid) {
    const row = cashierRow(c.cashierId)
    row.count++
    row.collected += c.patientTotal - (c.owed ?? 0) - (c.prepaidApplied ?? 0)
    const sum = (kind: string) => c.lines.filter((l) => l.patientPay && l.kind === kind).reduce((s, l) => s + l.amount, 0)
    const reg = sum('reg')
    const basic = sum('copay-basic')
    const drug = sum('copay-drug')
    const ipd = sum('copay-ipd')
    byFeeType.ipdCopay += ipd
    byFeeType.reg += reg
    byFeeType.basicCopay += basic
    byFeeType.drugCopay += drug
    // 優免是負數列（明細裡記下的，不用現在的類別設定重算）
    const off = sum('discount')
    byFeeType.discount += off
    if (c.discount) {
      const d = disc.get(c.discount.name) ?? { name: c.discount.name, count: 0, amount: 0 }
      d.count++
      d.amount += c.discount.amount
      disc.set(d.name, d)
    }
    // 自費（含自費身分的診察費）用「收據總額 − 其他類」：收據總額四捨五入過，這樣各類加總一定等於收入合計
    byFeeType.selfPay += c.patientTotal - reg - basic - drug - ipd - off
  }
  // 收回欠款：算在收回那天（原收據可能是更早的日子）。作廢的收據不會有收回紀錄（有收回就不能作廢）
  const repayments: DailyReport['repayments'] = []
  for (const c of db.charges) {
    for (const rp of c.repayments ?? []) {
      if (!inRange(rp.at)) continue
      byPayMethod[rp.payMethod] += rp.amount
      const row = cashierRow(rp.cashierId)
      row.repayCount++
      row.collected += rp.amount
      const p = find.patient(c.patientId)
      repayments.push({ receiptNo: rp.receiptNo, at: rp.at, patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', amount: rp.amount, payMethod: rp.payMethod, originalReceiptNo: c.receiptNo, cashierName: nameOf.user(rp.cashierId) })
    }
  }
  repayments.sort((a, b) => a.receiptNo.localeCompare(b.receiptNo))
  // 退款：算在退款那天（負數），依原付款方式從各自的錢箱、刷卡機扣
  const PM: Record<PayMethod, string> = { cash: '現金', card: '刷卡', mobile: '行動支付' }
  const refunds: DailyReport['refunds'] = []
  for (const c of db.charges) {
    const rf = c.refund
    if (!rf || !inRange(rf.at)) continue
    for (const p of rf.parts) byPayMethod[p.payMethod] -= p.amount
    const row = cashierRow(rf.cashierId)
    row.refundCount++
    row.collected -= rf.amount
    const p = find.patient(c.patientId)
    refunds.push({ receiptNo: rf.receiptNo, at: rf.at, kind: '退費', patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', amount: rf.amount, payMethods: rf.parts.map((x) => `${PM[x.payMethod]} ${x.amount}`).join('、'), originalReceiptNo: c.receiptNo, originalDate: c.paidAt.slice(0, 10), reason: rf.reason, cashierName: nameOf.user(rf.cashierId) })
  }
  // 部分退費：退還的錢算在退費那天；抵欠款的部分不是現金（只是少收），不算進退款
  for (const c of db.charges) {
    for (const pr of c.partialRefunds ?? []) {
      if (!inRange(pr.at) || !pr.receiptNo) continue
      const cash = pr.parts.reduce((n, x) => n + x.amount, 0)
      for (const x of pr.parts) byPayMethod[x.payMethod] -= x.amount
      const row = cashierRow(pr.cashierId)
      row.refundCount++
      row.collected -= cash
      const p = find.patient(c.patientId)
      refunds.push({ receiptNo: pr.receiptNo, at: pr.at, kind: '部分退費', patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', amount: cash, payMethods: pr.parts.map((x) => `${PM[x.payMethod]} ${x.amount}`).join('、') + (pr.owedOffset ? `（另抵欠款 ${pr.owedOffset}）` : ''), originalReceiptNo: c.receiptNo, originalDate: c.paidAt.slice(0, 10), reason: pr.reason, cashierName: nameOf.user(pr.cashierId) })
    }
  }
  // 掛號預收：算在收的那天；退還（退掛、停診、多收的差額）算在退的那天，從原付款方式扣
  const prepays: DailyReport['prepays'] = []
  for (const v of db.visits) {
    const pp = v.prepay
    if (!pp) continue
    const p = find.patient(v.patientId)
    if (inRange(pp.at)) {
      byPayMethod[pp.payMethod] += pp.amount
      const row = cashierRow(pp.cashierId)
      row.prepayCount++
      row.collected += pp.amount
      prepays.push({ receiptNo: pp.receiptNo, at: pp.at, kind: '掛號預收', patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', amount: pp.amount, payMethod: pp.payMethod, cashierName: nameOf.user(pp.cashierId), visitDate: v.date })
    }
    for (const r of pp.refunds) {
      if (!inRange(r.at)) continue
      byPayMethod[pp.payMethod] -= r.amount
      const row = cashierRow(r.cashierId)
      row.refundCount++
      row.collected -= r.amount
      refunds.push({ receiptNo: r.receiptNo, at: r.at, kind: '退預收', patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', amount: r.amount, payMethods: `${PM[pp.payMethod]} ${r.amount}`, originalReceiptNo: pp.receiptNo, originalDate: pp.at.slice(0, 10), reason: r.reason, cashierName: nameOf.user(r.cashierId) })
    }
  }
  // 住院期中繳款：同上（作廢的不算：只有當天能作廢）；出院結帳多繳的退還算在退的那天
  for (const a of db.admissions) {
    const p = find.patient(a.patientId)
    for (const ip of a.interim ?? []) {
      if (ip.voided || !inRange(ip.at)) continue
      byPayMethod[ip.payMethod] += ip.amount
      const row = cashierRow(ip.cashierId)
      row.prepayCount++
      row.collected += ip.amount
      prepays.push({ receiptNo: ip.receiptNo, at: ip.at, kind: '期中繳款', patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', amount: ip.amount, payMethod: ip.payMethod, cashierName: nameOf.user(ip.cashierId), visitDate: (a.admittedAt ?? a.reservedAt).slice(0, 10), admitNo: a.admitNo })
    }
    for (const r of a.interimRefunds ?? []) {
      if (!inRange(r.at)) continue
      for (const x of r.parts) byPayMethod[x.payMethod] -= x.amount
      const row = cashierRow(r.cashierId)
      row.refundCount++
      row.collected -= r.amount
      const src = (a.interim ?? []).filter((x) => !x.voided).map((x) => x.receiptNo)
      refunds.push({ receiptNo: r.receiptNo, at: r.at, kind: '退期中繳款', patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', amount: r.amount, payMethods: r.parts.map((x) => `${PM[x.payMethod]} ${x.amount}`).join('、'), originalReceiptNo: src.join('、'), originalDate: (a.interim ?? []).find((x) => !x.voided)?.at.slice(0, 10) ?? r.at.slice(0, 10), reason: r.reason, cashierName: nameOf.user(r.cashierId) })
    }
  }
  prepays.sort((a, b) => a.receiptNo.localeCompare(b.receiptNo))
  const prepaidIn = prepays.reduce((s, x) => s + x.amount, 0)
  const prepaidApplied = valid.reduce((s, c) => s + (c.prepaidApplied ?? 0), 0)
  refunds.sort((a, b) => a.receiptNo.localeCompare(b.receiptNo))
  const refunded = refunds.reduce((s, x) => s + x.amount, 0)
  const patientTotal = valid.reduce((s, c) => s + c.patientTotal, 0)
  const newDebt = valid.reduce((s, c) => s + (c.owed ?? 0), 0)
  const repaid = repayments.reduce((s, x) => s + x.amount, 0)
  const unpaid = db.visits
    .filter((v) => inRange(v.date) && v.status === 'consulted')
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((v) => {
      const vv = visitView(v)
      return { visitId: v.id, date: v.date, patientName: vv.patientName, chartNo: vv.chartNo, deptName: vv.deptName, doctorName: vv.doctorName, estimate: estimate(v.id) }
    })
  // 依日期小計：每一天都列（沒有收費的日子是 0），月報表一眼看出哪天沒開或漏結
  const byDay: DailyReport['byDay'] = []
  for (let d = date; d <= to; d = addDays(d, 1)) {
    const dayValid = valid.filter((c) => c.paidAt.startsWith(d))
    const total = dayValid.reduce((s, c) => s + c.patientTotal, 0)
    const debt = dayValid.reduce((s, c) => s + (c.owed ?? 0), 0)
    const back = repayments.filter((x) => x.at.startsWith(d)).reduce((s, x) => s + x.amount, 0)
    const rf = refunds.filter((x) => x.at.startsWith(d)).reduce((s, x) => s + x.amount, 0)
    const pin = prepays.filter((x) => x.at.startsWith(d)).reduce((s, x) => s + x.amount, 0)
    const pap = dayValid.reduce((s, c) => s + (c.prepaidApplied ?? 0), 0)
    byDay.push({ date: d, count: dayValid.length, patientTotal: total, newDebt: debt, repaid: back, prepaidIn: pin, prepaidApplied: pap, refunded: rf, collected: total - debt - pap + back + pin - rf })
  }
  // 依月份小計：每日小計逐月加總（和每日小計同一份數字，不另算）
  const byMonth = diffDays(date, to) + 1 > REPORT_MONTHLY_AFTER
    ? [...byDay.reduce((m, d) => {
        const k = d.date.slice(0, 7)
        const x = m.get(k) ?? { date: k, count: 0, patientTotal: 0, newDebt: 0, repaid: 0, prepaidIn: 0, prepaidApplied: 0, refunded: 0, collected: 0 }
        for (const f of ['count', 'patientTotal', 'newDebt', 'repaid', 'prepaidIn', 'prepaidApplied', 'refunded', 'collected'] as const) x[f] += d[f]
        return m.set(k, x)
      }, new Map<string, DailyReport['byDay'][number]>()).values()]
    : undefined
  return {
    date,
    to,
    byDay,
    ...(byMonth ? { byMonth } : {}),
    count: valid.length,
    voidedCount: all.length - valid.length,
    voidedTotal: all.filter((c) => c.voided && !c.refund).reduce((s, c) => s + c.patientTotal, 0),
    byCashier: [...cashier.values()].sort((a, b) => b.collected - a.collected),
    byFeeType,
    discounts: [...disc.values()].sort((a, b) => b.amount - a.amount),
    discountTotal: [...disc.values()].reduce((s, d) => s + d.amount, 0),
    unpaid,
    patientTotal,
    newDebt,
    repaid,
    refunded,
    prepaidIn,
    prepaidApplied,
    prepays,
    collected: patientTotal - newDebt - prepaidApplied + repaid + prepaidIn - refunded,
    repayments,
    refunds,
    nhiPoints: valid.reduce((s, c) => s + nhiOf(c), 0),
    byPayMethod,
    byDept: [...dept.values()].sort((a, b) => b.patientTotal - a.patientTotal),
    charges: all
      .map((c) => {
        const p = find.patient(c.patientId)
        return { ...c, patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', deptName: chargeDeptName(c), cashierName: nameOf.user(c.cashierId) }
      })
      .sort((a, b) => a.receiptNo.localeCompare(b.receiptNo)),
  }
}
