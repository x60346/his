// 批價：試算、結帳、作廢、日結報表。
// 結帳成功 → 掛號狀態 charged；有開藥則自動產生藥局調劑單（領藥號）。
import type { Charge, ChargeLine, PayMethod } from '@/types'
import { db, nextCounter, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { calcChargeLines, checkCash, summarize } from './billing'
import { audit, fail, failField, must, mutate, query, requireUser } from './http'
import { billingLookup, find, nameOf, visitView, type VisitView } from './views'

export interface ChargeListItem extends VisitView {
  charge?: Charge
}

const pickupNoOf = (visitId: string) => db.dispenses.find((d) => d.visitId === visitId)?.pickupNo

/** 批價清單：當日看完診（待批價）與已批價的病人 */
export function listChargeQueue(date: string): Promise<ChargeListItem[]> {
  return query(() =>
    db.visits
      .filter((v) => v.date === date && ['consulted', 'charged', 'dispensed'].includes(v.status))
      .map((v) => ({ ...visitView(v), charge: db.charges.find((c) => c.visitId === v.id && !c.voided) }))
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

export function pay(visitId: string, input: { payMethod: PayMethod; received: number }): Promise<Charge> {
  return mutate(() => {
    const cashier = requireUser('clerk')
    const v = must(find.visit(visitId), '掛號紀錄')
    if (v.status !== 'consulted') fail('此病人尚未完成看診或已批價', 'CONFLICT')
    const e = must(find.encounterOfVisit(visitId), '病歷')
    const pv = buildPreview(visitId)
    // 刷卡、行動支付金額必定等於應收
    const received = input.payMethod === 'cash' ? input.received : pv.patientTotal
    if (input.payMethod === 'cash') {
      const problem = checkCash(pv.patientTotal, received)
      if (problem) failField('received', problem)
    }

    const ymd = v.date.replace(/-/g, '')
    const charge: Charge = {
      id: newId('C'), visitId, patientId: v.patientId, lines: pv.lines, nhiPoints: pv.nhiPoints, patientTotal: pv.patientTotal,
      payMethod: input.payMethod, received, change: received - pv.patientTotal,
      receiptNo: `R${ymd}${String(nextCounter(`receipt:${v.date}`)).padStart(4, '0')}`,
      cashierId: cashier.id, paidAt: now(), voided: false,
    }
    db.charges.push(charge)
    v.status = 'charged'

    if (e.medications.length) {
      db.dispenses.push({
        id: newId('DP'), visitId, encounterId: e.id, patientId: v.patientId,
        pickupNo: nextCounter(`pickup:${v.date}`), status: 'pending', createdAt: now(),
      })
    }
    audit('批價結帳', `${charge.receiptNo} ${find.patient(v.patientId)?.name} ${pv.patientTotal} 元`)
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
    c.voided = true
    db.dispenses = db.dispenses.filter((d) => d.visitId !== c.visitId)
    const v = must(find.visit(c.visitId), '掛號紀錄')
    v.status = 'consulted'
    audit('作廢收據', `${c.receiptNo}：${reason}`)
    return c
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
    }
  })
}

export interface DailyReport {
  date: string
  count: number
  voidedCount: number
  patientTotal: number
  nhiPoints: number
  byPayMethod: Record<PayMethod, number>
  byDept: { deptName: string; count: number; patientTotal: number; nhiPoints: number }[]
  charges: (Charge & { patientName: string; chartNo: string; deptName: string })[]
}

export function dailyReport(date: string): Promise<DailyReport> {
  return query(() => {
    const all = db.charges.filter((c) => c.paidAt.startsWith(date))
    const valid = all.filter((c) => !c.voided)
    const byPayMethod: Record<PayMethod, number> = { cash: 0, card: 0, mobile: 0 }
    const dept = new Map<string, DailyReport['byDept'][number]>()
    for (const c of valid) {
      byPayMethod[c.payMethod] += c.patientTotal
      const deptName = nameOf.dept(find.visit(c.visitId)?.deptId)
      const row = dept.get(deptName) ?? { deptName, count: 0, patientTotal: 0, nhiPoints: 0 }
      row.count++
      row.patientTotal += c.patientTotal
      row.nhiPoints += c.nhiPoints
      dept.set(deptName, row)
    }
    return {
      date,
      count: valid.length,
      voidedCount: all.length - valid.length,
      patientTotal: valid.reduce((s, c) => s + c.patientTotal, 0),
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
