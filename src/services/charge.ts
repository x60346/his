// 批價：試算、結帳、作廢、日結報表。
// 結帳成功 → 掛號狀態 charged；有開藥則自動產生藥局調劑單（領藥號）。
import type { Charge, ChargeLine, DiscountRequest, DiscountRule, PayMethod, Repayment } from '@/types'
import { permDef, permits } from './permission-rules'
import { db, nextCounter, newId } from '@/mock/db'
import { diffDays, now, today } from '@/utils/date'
import { applyDiscount, calcChargeLines, checkCash, checkRepay, discountAmountOf, outstandingOf, summarize } from './billing'
import { audit, fail, failField, fieldErrors, must, mutate, query, requireUser, ServiceError, requirePermission } from './http'
import { billingLookup, find, nameOf, visitView, type VisitView } from './views'
import { nextReceiptNo, nextRefundNo, pendingRefundOf, prepayAvailable, refundParts, refundPrepay, type PendingRefund } from './money'
import { certFeeLines, certsOfEncounter } from './certificate-fee'
import { consumeWitness, grantWitness, WITNESS_MIN, witnessFor } from './witness-core'
import { buildDailyReport, REPORT_MAX_DAYS, type DailyReport } from './daily-report'

export interface ChargeListItem extends VisitView {
  charge?: Charge
  /** 待批價者的應收（與結帳試算同一個計算 buildPreview）：清單上就看得到要收多少，不必一個個點進去 */
  estimate?: number
  /** 部分退藥後待退費的金額（0＝只有申報點數要改） */
  pendingRefund?: number
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
      .map((x) => {
        const pr = x.charge && pendingRefundOf(x.charge)
        return pr ? { ...x, pendingRefund: pr.amount } : x
      })
      .sort((a, b) => Number(!!a.charge) - Number(!!b.charge) || a.seqNo - b.seqNo),
  )
}

export interface ChargePreview {
  visit: VisitView
  lines: ChargeLine[]
  nhiPoints: number
  patientTotal: number
  /** 套用的優免（沒有就不給） */
  discount?: { code: string; name: string; amount: number }
  /** 掛號預收款：扣抵多少、本次應收（應收 − 扣抵）、多收要退還病人的差額 */
  prepaid?: { receiptNo: string; applied: number; due: number; excess: number }
}

/** 優免類別（啟用中的才能用；停用的舊收據照樣顯示當時存下的名稱） */
function usableDiscount(code: string): DiscountRule {
  const d = db.discounts.find((x) => x.code === code)
  if (!d) failField('discount', '找不到這個優免類別')
  if (!d!.active) failField('discount', `「${d!.name}」已停用，不能再使用`)
  return d!
}

function buildPreview(visitId: string, discountCode?: string): ChargePreview {
  const v = must(find.visit(visitId), '掛號紀錄')
  const e = must(find.encounterOfVisit(visitId), '病歷')
  // 診斷證明書費跟著這次看診收（自費項目，優免打折也適用）
  const base = [...calcChargeLines(v, e, billingLookup(v.identityCode)), ...certFeeLines(certsOfEncounter(e.id))]
  const rule = discountCode ? usableDiscount(discountCode) : undefined
  const lines = rule ? applyDiscount(base, rule) : base
  const sum = summarize(lines)
  const pre = prepayAvailable(v)
  const applied = Math.min(pre, sum.patientTotal)
  return {
    visit: visitView(v), lines, ...sum,
    ...(rule ? { discount: { code: rule.code, name: rule.name, amount: discountAmountOf(lines) } } : {}),
    ...(pre > 0 ? { prepaid: { receiptNo: v.prepay!.receiptNo, applied, due: sum.patientTotal - applied, excess: pre - applied } } : {}),
  }
}

/** 試算：畫面上先顯示明細，確認後才結帳。選了優免就連優免一起算（金額只在服務層算） */
export function previewCharge(visitId: string, discountCode?: string): Promise<ChargePreview> {
  return query(() => {
    const v = must(find.visit(visitId), '掛號紀錄')
    if (v.status !== 'consulted') fail('此病人尚未完成看診或已批價')
    return buildPreview(visitId, discountCode || undefined)
  })
}

/** 優免類別（批價頁選單、管理頁） */
export function listDiscounts(q: { includeInactive?: boolean } = {}): Promise<DiscountRule[]> {
  return query(() => db.discounts.filter((d) => q.includeInactive || d.active))
}


// ---------- 優免主管核准 ----------
// 主管當場核准（和超商叫店長來刷卡一樣）：另一位有「可核准優免」權限的人輸入自己的帳號密碼；一次性、綁定這次掛號＋類別＋櫃台
export const DISCOUNT_APPROVAL_MIN = WITNESS_MIN

export type DiscountApprovalResult = { ok: true; token: string; approverName: string } | { ok: false; field: 'username' | 'password'; message: string }

/**
 * 主管核准優免（共用的第二人確認 witness-core，用途 discount）。帳密錯誤、沒有權限、核准自己結帳的都**回傳**失敗（不丟錯），
 * 這樣失敗的嘗試也留在稽核裡（mutate 丟錯會回滾整筆，連稽核一起不見）
 */
export function approveDiscount(input: { visitId: string; code: string; username: string; password: string }): Promise<DiscountApprovalResult> {
  return mutate((): DiscountApprovalResult => {
    const cashier = requireUser('clerk')
    const v = must(find.visit(input.visitId), '掛號紀錄')
    if (v.status !== 'consulted') fail('此病人尚未完成看診或已批價', 'CONFLICT')
    const rule = usableDiscount(input.code)
    if (!rule.needsApproval) fail(`「${rule.name}」不需要主管核准`)
    const r = grantWitness({
      purpose: 'discount', refId: `${v.id}|${rule.code}`, actor: cashier, username: input.username, password: input.password,
      who: '主管', selfMessage: '不能核准自己結帳的優免，請另一位主管核准', auditAction: '優免核准', verb: '核准',
      what: `${nameOf.patient(v.patientId)} ${rule.name}（櫃台 ${cashier.name}）`,
      // 帳號任一角色在法規範圍內、且被指定了這項權限
      qualifies: (u) => (u.roles.some((ro) => permits(permDef('charge.approveDiscount'), db.permissionSettings as never, ro, u.grants ?? [])) ? null : `${u.name} 沒有核准優免的權限`),
    })
    return r.ok ? { ok: true, token: r.token, approverName: r.witnessName } : r
  })
}

/** 結帳時檢查核准：同一次掛號、同一類別、同一位櫃台、還沒過期 */
function approvalFor(token: string | undefined, visitId: string, code: string, cashierId: string) {
  const g = witnessFor(token, 'discount', `${visitId}|${code}`, cashierId)
  if (!g || g === 'expired') return g
  return { approverId: g.witnessId, approverName: g.witnessName }
}

// ---------- 優免送簽：櫃台送簽，主管在自己的首頁核准或退回（不必到櫃台）----------

/** 結帳時檢查送簽單：已核准、同一次掛號、同一類別、同一位櫃台、當天核准的。不符回傳原因 */
function requestApprovalFor(id: string, visitId: string, code: string, cashierId: string): { request: DiscountRequest; approval: { approverId: string; approverName: string } } | string {
  const r = db.discountRequests.find((x) => x.id === id)
  if (!r || r.visitId !== visitId || r.code !== code || r.cashierId !== cashierId) return '送簽單和這次結帳不符（病人、優免類別或櫃台不同），請重新送簽'
  if (r.status === 'pending') return '送簽中，主管還沒核准'
  if (r.status === 'rejected') return `主管已退回：${r.rejectReason}`
  if (r.status !== 'approved') return '這張送簽單已經用過或撤回了，請重新送簽'
  if (r.decidedAt!.slice(0, 10) !== today()) return '送簽的核准只限當天，請重新送簽'
  return { request: r, approval: { approverId: r.decidedBy!, approverName: nameOf.user(r.decidedBy) } }
}

export interface DiscountRequestView extends DiscountRequest {
  ruleName: string
  patientName: string
  chartNo: string
  cashierName: string
  decidedByName?: string
}

const discountRequestView = (r: DiscountRequest): DiscountRequestView => {
  const v = find.visit(r.visitId)
  const p = v ? find.patient(v.patientId) : undefined
  return {
    ...r,
    ruleName: db.discounts.find((d) => d.code === r.code)?.name ?? r.code,
    patientName: p?.name ?? '', chartNo: p?.chartNo ?? '',
    cashierName: nameOf.user(r.cashierId),
    ...(r.decidedBy ? { decidedByName: nameOf.user(r.decidedBy) } : {}),
  }
}

/** 這次掛號最近一張送簽單（撤回的不算）：批價頁顯示狀態 */
const latestRequestOf = (visitId: string) => db.discountRequests.filter((x) => x.visitId === visitId && x.status !== 'cancelled').sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0]

/** 送簽：需主管核准的優免。同一次掛號同時只有一張待核准的（重送會撤回舊的） */
export function requestDiscountApproval(input: { visitId: string; code: string; reason?: string }): Promise<DiscountRequestView> {
  return mutate(() => {
    const cashier = requirePermission('charge.pay')
    const v = must(find.visit(input.visitId), '掛號紀錄')
    if (v.status !== 'consulted') fail('此病人尚未完成看診或已批價', 'CONFLICT')
    const rule = usableDiscount(input.code)
    if (!rule.needsApproval) fail(`「${rule.name}」不需要主管核准`)
    const reason = input.reason?.trim()
    if (rule.needsReason && !reason) failField('discountReason', `「${rule.name}」需註明原因`)
    const t = now()
    for (const x of db.discountRequests.filter((x) => x.visitId === v.id && x.status === 'pending')) Object.assign(x, { status: 'cancelled', decidedAt: t })
    const r: DiscountRequest = {
      id: newId('DRQ'), visitId: v.id, code: rule.code, ...(reason ? { reason } : {}), amount: buildPreview(v.id, rule.code).discount?.amount ?? 0,
      cashierId: cashier.id, requestedAt: t, status: 'pending',
    }
    db.discountRequests.push(r)
    audit('優免送簽', `${nameOf.patient(v.patientId)} ${rule.name} −${r.amount} 元${reason ? `（${reason}）` : ''}`)
    return discountRequestView(r)
  })
}

/** 撤回還沒核准的送簽（送簽的櫃台） */
export function cancelDiscountRequest(id: string): Promise<DiscountRequestView> {
  return mutate(() => {
    const cashier = requirePermission('charge.pay')
    const r = must(db.discountRequests.find((x) => x.id === id), '送簽單')
    if (r.cashierId !== cashier.id) fail('只有送簽的櫃台可以撤回', 'FORBIDDEN')
    if (r.status !== 'pending') fail('這張送簽單已經處理了', 'CONFLICT')
    Object.assign(r, { status: 'cancelled', decidedAt: now() })
    audit('撤回優免送簽', `${nameOf.patient(find.visit(r.visitId)?.patientId)} ${r.code}`)
    return discountRequestView(r)
  })
}

/** 待我核准的送簽（有「可核准優免」的人；首頁卡片）：今天送的、待核准的，舊的在前 */
export function listDiscountRequests(): Promise<DiscountRequestView[]> {
  return query(() => {
    requirePermission('charge.approveDiscount')
    return db.discountRequests.filter((x) => x.status === 'pending' && x.requestedAt.slice(0, 10) === today()).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)).map(discountRequestView)
  })
}

/** 主管核准或退回（退回要寫原因）。不能核准自己送簽的；病人已經批價了就不必再核 */
export function decideDiscountRequest(id: string, input: { approve: boolean; reason?: string }): Promise<DiscountRequestView> {
  return mutate(() => {
    const u = requirePermission('charge.approveDiscount')
    const r = must(db.discountRequests.find((x) => x.id === id), '送簽單')
    if (r.status !== 'pending') fail(r.status === 'cancelled' ? '櫃台已撤回這張送簽' : '這張送簽單已經處理了', 'CONFLICT')
    if (r.cashierId === u.id) fail('不能核准自己送簽的優免，請另一位主管核准', 'FORBIDDEN')
    if (find.visit(r.visitId)?.status !== 'consulted') fail('病人已經批價或不在待批價，這張送簽不必處理了', 'CONFLICT')
    const why = input.reason?.trim()
    if (!input.approve && !why) failField('reason', '退回請寫原因（例：不符合專案資格）')
    Object.assign(r, { status: input.approve ? 'approved' : 'rejected', decidedBy: u.id, decidedAt: now(), ...(input.approve ? {} : { rejectReason: why }) })
    const what = `${nameOf.patient(find.visit(r.visitId)?.patientId)} ${db.discounts.find((d) => d.code === r.code)?.name} −${r.amount} 元（櫃台 ${nameOf.user(r.cashierId)}）`
    audit(input.approve ? '優免核准' : '優免退回', `${u.name} ${input.approve ? '核准' : '退回'} ${what}${why ? `：${why}` : ''}（送簽）`)
    return discountRequestView(r)
  })
}

export interface PayInput {
  payMethod: PayMethod
  received: number
  /** 實收不足時，差額記為欠款（只限現金；刷卡、行動支付一定是足額扣款） */
  owe?: { reason: string }
  /** 優免：類別與原因（需註明原因的類別必填）；需主管核准的帶 approveDiscount 給的核准（approval），或已核准的送簽單（requestId） */
  discount?: { code: string; reason?: string; approval?: string; requestId?: string }
}

export function pay(visitId: string, input: PayInput): Promise<Charge> {
  return mutate(() => {
    const cashier = requirePermission('charge.pay')
    const v = must(find.visit(visitId), '掛號紀錄')
    if (v.status !== 'consulted') fail('此病人尚未完成看診或已批價', 'CONFLICT')
    const e = must(find.encounterOfVisit(visitId), '病歷')
    const pv = buildPreview(visitId, input.discount?.code || undefined)
    const rule = input.discount?.code ? usableDiscount(input.discount.code) : undefined
    const discountReason = input.discount?.reason?.trim()
    if (rule?.needsReason && !discountReason) failField('discountReason', `「${rule.name}」需註明原因`)
    // 主管核准：當場輸入帳密（approval token）或已核准的送簽單（requestId）
    const req = rule?.needsApproval && input.discount?.requestId ? requestApprovalFor(input.discount.requestId, visitId, rule.code, cashier.id) : undefined
    if (typeof req === 'string') failField('approval', req)
    const approval = rule?.needsApproval ? (req && typeof req !== 'string' ? req.approval : approvalFor(input.discount?.approval, visitId, rule.code, cashier.id)) : undefined
    if (approval === null) failField('approval', `「${rule!.name}」需主管核准`)
    if (approval === 'expired') failField('approval', `主管核准已超過 ${DISCOUNT_APPROVAL_MIN} 分鐘，請重新核准`)
    const approved = approval || undefined // null、expired 上面已擋下
    // 預收款扣抵後，本次實際要收的
    const applied = pv.prepaid?.applied ?? 0
    const due = pv.patientTotal - applied
    // 刷卡、行動支付金額必定等於應收
    const received = input.payMethod === 'cash' ? input.received : due
    const owe = !!input.owe
    if (owe && input.payMethod !== 'cash') fail('刷卡、行動支付以應收金額扣款，不能記欠款')
    if (owe && !input.owe!.reason.trim()) failField('oweReason', '請輸入欠款原因')
    if (input.payMethod === 'cash') {
      const problem = checkCash(due, received, owe)
      if (problem) failField('received', problem)
    }

    const owed = owe ? due - received : 0
    const charge: Charge = {
      id: newId('C'), visitId, patientId: v.patientId, lines: pv.lines, nhiPoints: pv.nhiPoints, patientTotal: pv.patientTotal,
      payMethod: input.payMethod, received, change: owe ? 0 : received - due,
      ...(applied ? { prepaidApplied: applied } : {}),
      receiptNo: nextReceiptNo(v.date),
      cashierId: cashier.id, paidAt: now(), voided: false,
      ...(owe ? { owed, oweReason: input.owe!.reason.trim(), repayments: [] } : {}),
      ...(rule ? { discount: { code: rule.code, name: rule.name, ...(discountReason ? { reason: discountReason } : {}), amount: pv.discount!.amount, ...(approved ? { approvedBy: approved.approverId, approverName: approved.approverName } : {}) } } : {}),
    }
    db.charges.push(charge)
    v.status = 'charged'
    // 預收多於應收：差額當場退還（開退款單、算在今天）
    const excessRefund = pv.prepaid?.excess ? refundPrepay(v, pv.prepaid.excess, '預收多於應收，退還差額', cashier.id) : undefined

    if (e.medications.length) {
      db.dispenses.push({
        id: newId('DP'), visitId, encounterId: e.id, patientId: v.patientId,
        pickupNo: nextCounter(`pickup:${v.date}`), status: 'pending', createdAt: now(),
      })
    }
    const discNote = charge.discount ? `（優免：${charge.discount.name} −${charge.discount.amount} 元${charge.discount.reason ? `，${charge.discount.reason}` : ''}${approved ? `，${approved.approverName} 核准` : ''}）` : ''
    const preNote = applied ? `（預收扣抵 ${applied} 元${excessRefund ? `、退還差額 ${excessRefund.amount} 元 ${excessRefund.receiptNo}` : ''}）` : ''
    audit('批價結帳', `${charge.receiptNo} ${find.patient(v.patientId)?.name} ${pv.patientTotal} 元${preNote}${discNote}${owed ? `（欠 ${owed} 元：${charge.oweReason}）` : ''}`)
    // 一次性：用掉
    if (approved && req && typeof req !== 'string') Object.assign(req.request, { status: 'used', usedChargeId: charge.id })
    else if (approved) consumeWitness(input.discount!.approval)
    return charge
  })
}

/**
 * 這張收據怎麼取消：當天、沒收回過欠款的可以「作廢」（當天的帳直接不算）；
 * 隔天以後（那天的日結已交給會計）或收回過欠款的只能「退費」（原收據照算、退款算在退款那天）。
 * 藥已發出的兩種都不行，要先到藥局退藥
 */
export interface CancelMode {
  mode: 'void' | 'refund'
  /** 為什麼兩種都不行（藥已發出） */
  blocked?: string
  /** 退費會退多少 */
  refundAmount: number
}

// 內部函式（不 export：services 裡 export 的都會變成 API）
function cancelModeOf(c: Charge): CancelMode {
  // 病歷影本的收據：到「病患資料 → 病歷影本」作廢（申請一起作廢）；沒有退費
  if (c.copyRequestId) return { mode: c.paidAt.slice(0, 10) === today() ? 'void' : 'refund', refundAmount: 0, blocked: '病歷影本的收據請到「病患資料 → 病歷影本」作廢（當天）' }
  if (c.admissionId) {
    // 住院收據：出院前、當天可以作廢重結（帳單算錯、結帳後又有新費用）；出院後不能作廢也不能退費
    const discharged = find.admission(c.admissionId)?.status === 'discharged'
    const mode = c.paidAt.slice(0, 10) === today() && !c.repayments?.length ? 'void' : 'refund'
    return { mode, refundAmount: 0, ...(discharged ? { blocked: '病人已出院：住院收據不能作廢或退費' } : mode === 'refund' ? { blocked: '住院收據只能在結帳當天、出院前作廢重結' } : {}) }
  }
  const dispensed = db.dispenses.find((d) => d.visitId === c.visitId && d.status === 'dispensed')
  // 部分退費過的不能作廢（退款單已經開出去了）
  const mode = c.paidAt.slice(0, 10) === today() && !c.repayments?.length && !c.partialRefunds?.length ? 'void' : 'refund'
  return { mode, refundAmount: refundParts(c).reduce((n, p) => n + p.amount, 0), ...(dispensed ? { blocked: dispensed.returns?.length ? '還有藥在病人手上（已部分退藥）：要整張作廢或退費，請藥局把剩下的也退藥' : '藥品已發出：請先到藥局辦理退藥（藥局「已發藥」那張按「退藥」）' } : {}) }
}

export type { PendingRefund }

// 部分退費的差額計算（pendingRefundOf）與可退的錢（refundParts）在 money.ts：首頁待辦也要用

/** 待退費的收據（部分退藥後，可能是好幾天前看的診）：批價頁另外列出，不只看當天 */
export function listPendingRefunds(): Promise<(VisitView & { chargeId: string; receiptNo: string; pending: PendingRefund })[]> {
  return query(() => {
    requireUser()
    return db.charges
      .map((c) => ({ c, pending: pendingRefundOf(c) }))
      .filter((x): x is { c: Charge; pending: PendingRefund } => !!x.pending)
      .map(({ c, pending }) => ({ ...visitView(must(find.visit(c.visitId), '掛號紀錄')), chargeId: c.id, receiptNo: c.receiptNo, pending }))
  })
}

/**
 * 部分退費：退部分退藥的差額。收據不作廢、原本那天的帳不動；先抵這張收據還沒收回的欠款，剩下的依原付款方式退，
 * 開一張退款單算在今天。金額由服務層算（pendingRefundOf），畫面只顯示、確認
 */
export function refundReturnedDrugs(chargeId: string): Promise<Charge> {
  return mutate(() => {
    const cashier = requirePermission('charge.pay')
    const c = must(db.charges.find((x) => x.id === chargeId), '收費紀錄')
    if (c.voided) fail('此收據已作廢或已退費', 'CONFLICT')
    const pr = pendingRefundOf(c)
    if (!pr) fail('這張收據沒有待退費（藥局部分退藥、或標了未執行的檢驗處置才有）', 'CONFLICT')
    const t = now()
    const money = pr!.amount > 0
    ;(c.partialRefunds ??= []).push({
      ...(money ? { receiptNo: nextRefundNo(t.slice(0, 10)) } : {}),
      amount: pr!.amount, owedOffset: pr!.owedOffset, parts: pr!.parts, nhiPoints: pr!.nhiPoints,
      reason: `部分退費：${pr!.items.join('、')}`, cashierId: cashier.id, at: t,
    })
    // 算進這次退費的「未執行」：之後不能撤銷（錢已經退出去了）
    for (const x of find.encounterOfVisit(c.visitId)?.procedures ?? []) if (x.notDone && !x.notDone.settledAt) x.notDone.settledAt = t
    const last = c.partialRefunds.at(-1)!
    audit('部分退費', `${last.receiptNo ?? '（不需退款）'} 原收據 ${c.receiptNo}：應付減少 ${pr!.amount} 元${pr!.owedOffset ? `（抵欠款 ${pr!.owedOffset}）` : ''}，退還 ${pr!.cash} 元，申報點數 −${pr!.nhiPoints}；${last.reason}`)
    return c
  })
}

/** 取消後的共同處理：調劑單拿掉（已退藥的也拿掉——退藥紀錄留在庫存帳與稽核）、掛號回到待批價，醫師可修改病歷。
 * 「未執行」也清掉：重新批價時由醫師決定醫令（沒做的刪掉），不然重新批價會照收 */
function reopenVisit(c: Charge) {
  if (c.admissionId) return // 住院收據：沒有掛號、調劑單要回復，作廢後重新結帳即可
  db.dispenses = db.dispenses.filter((d) => d.visitId !== c.visitId)
  for (const x of find.encounterOfVisit(c.visitId)?.procedures ?? []) delete x.notDone
  must(find.visit(c.visitId), '掛號紀錄').status = 'consulted'
}

/** 作廢（只限當天、沒收回過欠款）：已發藥的不可作廢（需先退藥）；作廢後掛號回到待批價，醫師可修改病歷。住院收據出院前可作廢重結 */
export function voidCharge(chargeId: string, reason: string): Promise<Charge> {
  return mutate(() => {
    requirePermission('charge.pay')
    if (!reason.trim()) fail('請輸入作廢原因')
    const c = must(db.charges.find((x) => x.id === chargeId), '收費紀錄')
    if (c.voided) fail('此收據已作廢')
    const m = cancelModeOf(c)
    if (m.blocked) fail(`收據無法作廢：${m.blocked}`, 'CONFLICT')
    // 作廢會讓這張收據從那天的日結消失：只有當天（還沒交帳）可以；其餘改走退費，原本那天的帳不動
    if (c.repayments?.length) fail('這張收據的欠款已收回過，不能作廢：請改用「退費」（收回的錢一起退）', 'CONFLICT')
    if (c.partialRefunds?.length) fail('這張收據部分退費過，不能作廢：請改用「退費」（扣掉已退的）', 'CONFLICT')
    if (m.mode === 'refund') fail(`這張是 ${c.paidAt.slice(0, 10)} 收的，已算進那天的日結，不能作廢：請改用「退費」`, 'CONFLICT')
    c.voided = true
    reopenVisit(c)
    audit('作廢收據', `${c.receiptNo}：${reason}`)
    return c
  })
}


/**
 * 退費：病人付過的錢全部退（依原付款方式），原收據照算在原本那天、退款算在今天；
 * 還沒收回的欠款一併取消。掛號回到待批價（醫師可改，再重新批價）。藥已發出要先退藥
 */
export function refundCharge(chargeId: string, reason: string): Promise<Charge> {
  return mutate(() => {
    const cashier = requirePermission('charge.pay')
    const c = must(db.charges.find((x) => x.id === chargeId), '收費紀錄')
    if (c.voided) fail(c.refund ? '這張已經退費了' : '此收據已作廢', 'CONFLICT')
    const m = cancelModeOf(c)
    if (m.blocked) fail(`無法退費：${m.blocked}`, 'CONFLICT')
    if (m.mode === 'void') fail('當天、沒收回過欠款的收據請用「作廢」（當天的帳直接不算，不必開退款單）', 'CONFLICT')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫退費原因（例：醫師改處方、病人過敏回診）')
    const t = now()
    const parts = refundParts(c)
    c.refund = { receiptNo: nextRefundNo(t.slice(0, 10)), amount: parts.reduce((n, p) => n + p.amount, 0), parts, reason: why!, cashierId: cashier.id, at: t }
    const cancelledDebt = outstandingOf(c)
    c.voided = true
    reopenVisit(c)
    audit('退費', `${c.refund.receiptNo} 退 ${c.refund.amount} 元（原收據 ${c.receiptNo}，${c.paidAt.slice(0, 10)}）${cancelledDebt ? `，取消未收欠款 ${cancelledDebt} 元` : ''}：${why}`)
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
      const a = c.admissionId ? find.admission(c.admissionId) : undefined
      return {
        chargeId: c.id, receiptNo: c.receiptNo, date: v?.date ?? c.paidAt.slice(0, 10), deptName: a ? `${nameOf.dept(a.deptId)}（住院）` : nameOf.dept(v?.deptId),
        patientTotal: c.patientTotal, owed: c.owed ?? 0, outstanding: outstandingOf(c), oweReason: c.oweReason, repayments: c.repayments ?? [],
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** 收回欠款（可分次、可只收一部分）。收據號依「收回那天」編，日結也算在那天 */
export function repayDebt(chargeId: string, input: { payMethod: PayMethod; amount: number }): Promise<Repayment> {
  return mutate(() => {
    const cashier = requirePermission('charge.pay')
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

/** 收據上的檢驗、處置（批價頁標「未執行」用） */
export interface ReceiptProcedure {
  idx: number
  name: string
  selfPay: boolean
  notDone?: { reason: string; byName: string; at: string; settled: boolean }
}

function receiptProcedures(c: Charge): ReceiptProcedure[] {
  const e = find.encounterOfVisit(c.visitId)
  return (e?.procedures ?? []).map((x, idx) => ({
    idx, name: find.procedure(x.procId)?.name ?? x.procId, selfPay: x.selfPay,
    ...(x.notDone ? { notDone: { reason: x.notDone.reason, byName: nameOf.user(x.notDone.by), at: x.notDone.at, settled: !!x.notDone.settledAt } } : {}),
  }))
}

/**
 * 標「未執行」：門診開了檢驗、處置，病人沒做就離開（或證明書不需要了）。醫令照留（病歷標未執行），櫃台退差額——
 * 健保項目病人沒另外付錢，通常只更正申報點數；自費項目才退錢。整項標，寫原因、寫稽核。
 * 收據作廢或整張退費過的不行；藥已全部退完的請整張退費
 */
export function markProcedureNotDone(chargeId: string, idx: number, reason: string): Promise<ReceiptView> {
  return mutate(() => {
    const cashier = requirePermission('charge.pay')
    const c = must(db.charges.find((x) => x.id === chargeId), '收費紀錄')
    if (c.voided) fail('此收據已作廢或已退費', 'CONFLICT')
    if (c.copyRequestId) fail('病歷影本的收據沒有檢驗處置', 'CONFLICT')
    if (c.admissionId) fail('住院收據沒有「未執行」：沒做的檢驗處置本來就不會算進住院帳單', 'CONFLICT')
    const e = must(find.encounterOfVisit(c.visitId), '病歷')
    const x = e.procedures[idx]
    if (!x) fail('找不到這項檢驗或處置，請重新整理')
    if (x.notDone) fail('這一項已經標未執行了', 'CONFLICT')
    // 檢驗已經發報告：做過了，不能說沒做（要退費得先請檢驗科處理）
    if (db.labReports.some((r) => r.encounterId === e.id && r.procId === x.procId) || db.imagingReports.some((r) => r.encounterId === e.id && r.procId === x.procId)) fail(`「${find.procedure(x.procId)?.name}」已經發出報告，不能標未執行`, 'CONFLICT')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫原因（例：病人未抽血即離開、證明書不需要了）')
    x.notDone = { reason: why!, by: cashier.id, at: now() }
    audit('標記未執行', `${c.receiptNo} ${nameOf.patient(c.patientId)}：${find.procedure(x.procId)?.name}（${why}）`)
    return receiptOf(c)
  })
}

/** 撤銷「未執行」（標錯了）：還沒退費前才可以 */
export function unmarkProcedureNotDone(chargeId: string, idx: number): Promise<ReceiptView> {
  return mutate(() => {
    requirePermission('charge.pay')
    const c = must(db.charges.find((x) => x.id === chargeId), '收費紀錄')
    if (c.voided) fail('此收據已作廢或已退費', 'CONFLICT')
    const x = must(find.encounterOfVisit(c.visitId), '病歷').procedures[idx]
    if (!x?.notDone) fail('這一項沒有標未執行', 'CONFLICT')
    if (x.notDone.settledAt) fail('已經退費了，不能撤銷（錢已經退出去了）', 'CONFLICT')
    delete x.notDone
    audit('撤銷未執行', `${c.receiptNo} ${nameOf.patient(c.patientId)}：${find.procedure(x.procId)?.name}`)
    return receiptOf(c)
  })
}

export interface ReceiptView extends Charge {
  visit: VisitView
  cashierName: string
  /** 怎麼取消這張（作廢或退費、退多少、為什麼不行）：頁面依它顯示按鈕，不自己判斷日期 */
  cancel?: CancelMode
  refundCashierName?: string
  /** 部分退藥、未執行的檢驗處置的待退費 */
  pendingRefund?: PendingRefund
  /** 檢驗、處置（標未執行用） */
  procedures: ReceiptProcedure[]
  /** 有開藥時的領藥號 */
  pickupNo?: number
  /** 這次看診的病歷（批價頁列出這次開的診斷證明書） */
  encounterId?: string
}

function receiptOf(c: Charge): ReceiptView {
  const pr = pendingRefundOf(c)
  return {
    ...c,
    visit: visitView(must(find.visit(c.visitId), '掛號紀錄')),
    cashierName: nameOf.user(c.cashierId),
    pickupNo: c.voided ? undefined : pickupNoOf(c.visitId),
    ...(c.voided ? {} : { cancel: cancelModeOf(c) }),
    ...(pr ? { pendingRefund: pr } : {}),
    ...(c.refund ? { refundCashierName: nameOf.user(c.refund.cashierId) } : {}),
    procedures: receiptProcedures(c),
    encounterId: find.encounterOfVisit(c.visitId)?.id,
  }
}

export function getReceipt(chargeId: string): Promise<ReceiptView> {
  return query(() => {
    const c = must(db.charges.find((x) => x.id === chargeId), '收費紀錄')
    if (c.admissionId) fail('這是住院收據，請到「住院結帳」查看', 'CONFLICT')
    if (c.copyRequestId) fail('這是病歷影本的收據，請到「病患資料 → 病歷影本」查看', 'CONFLICT')
    return receiptOf(c)
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
  /** 這次掛號最近一張優免送簽單（撤回的不算） */
  discountRequest?: DiscountRequestView
  /** 選的優免不能用（例：剛被停用）：試算改為不含優免，並說明原因 */
  discountError?: string
  /** 這個病人上次用過的優免（類別還啟用中才給）：批價頁提示，按一下才套用 */
  lastDiscount?: { code: string; name: string; date: string }
}

/**
 * 批價畫面右側所需的全部資料，一次取得。
 * 如果頁面先看清單上的狀態、再決定呼叫試算或收據，清單一旦過期（例如剛結帳完、清單還沒刷新），
 * 就會用錯誤的狀態發出請求。在同一個時間點讀狀態並組好資料，就沒有這種不同步。
 */
/**
 * 優免也從這裡帶進來（discountCode），不另外呼叫試算：結帳後資料一起重新整理時，
 * 另一個試算請求還拿著「待批價」的舊狀態去算，就會跳出「此病人已批價」的錯誤。
 */
export function getChargeDetail(visitId: string, discountCode?: string): Promise<ChargeDetail> {
  return query(() => {
    const v = must(find.visit(visitId), '掛號紀錄')
    const charge = db.charges.find((c) => c.visitId === visitId && !c.voided)
    let preview: ChargePreview | undefined
    let discountError: string | undefined
    if (v.status === 'consulted') {
      try {
        preview = buildPreview(visitId, discountCode || undefined)
      } catch (e) {
        if (!(discountCode && e instanceof ServiceError && e.field === 'discount')) throw e
        discountError = e.message
        preview = buildPreview(visitId)
      }
    }
    return {
      visit: visitView(v),
      preview,
      ...(discountError ? { discountError } : {}),
      receipt: charge
        ? receiptOf(charge)
        : undefined,
      debts: debtsOf(v.patientId),
      ...(latestRequestOf(v.id) ? { discountRequest: discountRequestView(latestRequestOf(v.id)!) } : {}),
      ...(() => {
        const last = db.charges.filter((c) => c.patientId === v.patientId && !c.voided && c.discount && c.visitId !== v.id).sort((a, b) => b.paidAt.localeCompare(a.paidAt))[0]
        const rule = last && db.discounts.find((d) => d.code === last.discount!.code && d.active)
        return last && rule ? { lastDiscount: { code: rule.code, name: rule.name, date: last.paidAt.slice(0, 10) } } : {}
      })(),
    }
  })
}

export type { DailyReport } from './daily-report'
export { REPORT_MAX_DAYS, REPORT_MONTHLY_AFTER } from './daily-report'

export function dailyReport(date: string, to: string = date): Promise<DailyReport> {
  return query(() => {
    // 收入報表：只有櫃台（批價頁）與管理員看得到——以前只靠畫面藏，直接呼叫 API 誰都拿得到
    requireUser('clerk', 'admin')
    const v = fieldErrors()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) v.add('from', '請選擇起始日期')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) v.add('to', '請選擇結束日期')
    else if (to < date) v.add('to', '結束日期不能早於起始日期')
    else if (diffDays(date, to) + 1 > REPORT_MAX_DAYS) v.add('to', '一次最多一年（366 天），請分段查詢')
    v.done()
    return buildDailyReport(date, to, (visitId) => buildPreview(visitId).patientTotal)
  })
}
