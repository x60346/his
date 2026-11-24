// 出院帶藥（住院藥局）：醫師簽准出院時一起開的「帶回家的藥」——藥師調劑（核對、從住院藥局扣帳、印藥袋），
// 扣帳後才列入住院帳單（ipd-bill 依異動單號「出院帶藥 住院號」）；住院結帳要等調劑完（ipd-charge）。
// 調好後醫師要改：藥局先「退回」（藥回到原批號、寫原因），醫師才能取消准予出院（ipd.cancelDischargeOrder 擋）
import type { Admission } from '@/types'
import { db } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, must, mutate, query, requireUser } from './http'
import { doseUnitOf } from './billing'
import { postStock } from './stock-ledger'
import { udHeld } from './ud-work'
import { usableQty } from './stock-rules'
import { checkAllergies, type AllergyWarning } from './allergy'
import { effectiveTiming, timingText } from './drug-rules'
import { admissionView, find, nameOf, stockLoc } from './views'

export interface DischargeRxItem {
  drugId: string
  drugName: string
  drugNameZh: string
  spec: string
  unit: string
  doseUnit: string
  dose: number
  freq: string
  freqLabel: string
  route: string
  days: number
  qty: number
  timingText: string
  indication: string
  warning: string
  highAlert: boolean
  /** 住院藥局可用量（還沒調劑時看夠不夠） */
  stock: number
  shortage: boolean
}

/** 出院帶藥一張（形狀和門診調劑單相近：藥袋元件共用） */
export interface DischargeRxView {
  admissionId: string
  admitNo: string
  patientId: string
  patientName: string
  chartNo: string
  gender: 'M' | 'F'
  age: number
  bedNo: string
  deptName: string
  doctorName: string
  chronicRx: boolean
  items: DischargeRxItem[]
  allergyWarnings: AllergyWarning[]
  status: 'pending' | 'dispensed'
  /** 已調劑：藥師、時間（藥袋印調劑藥師與日期） */
  pharmacistName: string
  dispenseDate: string
  dispensedAt?: string
  /** 病人已出院（今天出院的仍列出，可重印藥袋；不能退回） */
  discharged: boolean
}

function rxView(a: Admission): DischargeRxView {
  const v = admissionView(a)
  const p = find.patient(a.patientId)
  const ds = a.dischargeSummary!
  const loc = stockLoc.ipd()
  const items = (ds.meds ?? []).map((m) => {
    const d = find.drug(m.drugId)
    // 已調劑待核對的藥盒要用的不算（藥已經裝進藥盒）
    const stock = Math.max(0, usableQty(stockLoc.lots(m.drugId, loc), today()) - udHeld(m.drugId))
    return {
      drugId: m.drugId, drugName: d?.name ?? m.drugId, drugNameZh: d?.nameZh ?? '', spec: d?.spec ?? '', unit: d?.unit ?? '', doseUnit: d ? doseUnitOf(d) : '',
      dose: m.dose, freq: m.freq, freqLabel: find.freq(m.freq)?.label ?? m.freq, route: m.route, days: m.days, qty: m.qty,
      timingText: timingText(effectiveTiming(d?.timing, m.timing), m.freq, m.route), indication: d?.indication ?? '', warning: d?.warning ?? '', highAlert: !!d?.highAlert,
      stock, shortage: !a.dischargeRx && stock < m.qty,
    }
  })
  return {
    admissionId: a.id, admitNo: a.admitNo, patientId: a.patientId, patientName: v.patientName, chartNo: v.chartNo, gender: v.gender, age: v.age,
    bedNo: v.bed?.bedNo ?? '', deptName: v.deptName, doctorName: nameOf.doctor(ds.doctorId),
    chronicRx: !!ds.chronicRx, items,
    allergyWarnings: checkAllergies(p?.allergies ?? [], (ds.meds ?? []).map((m) => find.drug(m.drugId)!).filter(Boolean)),
    status: a.dischargeRx ? 'dispensed' : 'pending',
    pharmacistName: a.dischargeRx ? nameOf.user(a.dischargeRx.dispensedBy) : '',
    dispenseDate: (a.dischargeRx?.dispensedAt ?? now()).slice(0, 10),
    ...(a.dischargeRx ? { dispensedAt: a.dischargeRx.dispensedAt } : {}),
    discharged: a.status === 'discharged',
  }
}

/** 出院帶藥清單：已准出院、有開出院帶藥的（待調劑在前）；加今天出院、已調劑的（重印藥袋） */
export function listDischargeRx(): Promise<DischargeRxView[]> {
  return query(() => {
    requireUser('pharmacist', 'admin')
    const t = today()
    return db.admissions
      .filter((a) => a.dischargeSummary?.meds?.length && ((a.status === 'admitted' && a.dischargeSummary.signedAt) || (a.status === 'discharged' && a.dischargeRx && a.dischargedAt?.startsWith(t))))
      .map(rxView)
      .sort((x, y) => Number(x.status === 'dispensed') - Number(y.status === 'dispensed') || x.bedNo.localeCompare(y.bedNo))
  })
}

/** 調劑出院帶藥：從住院藥局扣帳（FEFO），異動單號「出院帶藥 住院號」——住院帳單依它算藥費 */
export function dispenseDischargeRx(admissionId: string): Promise<DischargeRxView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人已出院', 'CONFLICT')
    const ds = a.dischargeSummary
    if (!ds?.signedAt) fail('醫師還沒簽准出院（出院帶藥還沒確定）', 'CONFLICT')
    if (!ds!.meds?.length) fail('這位病人沒有出院帶藥', 'CONFLICT')
    if (a.dischargeRx) fail('出院帶藥已經調劑了', 'CONFLICT')
    const loc = stockLoc.ipd()
    const short = ds!.meds!.filter((m) => usableQty(stockLoc.lots(m.drugId, loc), today()) - udHeld(m.drugId) < m.qty).map((m) => find.drug(m.drugId)?.name ?? m.drugId)
    if (short.length) fail(`住院藥局庫存不足：${short.join('、')}（請先撥補或請醫師改藥）`, 'CONFLICT')
    const t = now()
    const txnIds = ds!.meds!.map((m) => postStock({ kind: 'out', type: 'dispense', drugId: m.drugId, locationId: loc, qty: m.qty, ref: `出院帶藥 ${a.admitNo}`, patientId: a.patientId, doctorId: ds!.doctorId }, u.id, t).id)
    a.dischargeRx = { dispensedBy: u.id, dispensedAt: t, txnIds }
    audit('出院帶藥調劑', `${a.admitNo} ${find.patient(a.patientId)?.name}：${ds!.meds!.map((m) => `${find.drug(m.drugId)?.name} ${m.qty}`).join('、')}`)
    return rxView(a)
  })
}

/** 退回出院帶藥（醫師要改處方、病人不帶了）：藥回到原批號、寫原因；出院前才可以 */
export function returnDischargeRx(admissionId: string, reason: string): Promise<DischargeRxView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (!a.dischargeRx) fail('出院帶藥還沒調劑，不需要退回', 'CONFLICT')
    if (a.status !== 'admitted') fail('病人已出院，藥已帶走：請改用門診退藥流程', 'CONFLICT')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫退回原因（例：醫師要改處方）')
    const t = now()
    for (const id of a.dischargeRx!.txnIds) {
      const tx = must(db.stockTxns.find((x) => x.id === id), '扣帳異動')
      for (const l of tx.lots) {
        const lot = must(stockLoc.lots(tx.drugId, tx.locationId).find((y) => y.lotNo === l.lotNo) ?? db.drugLots.find((y) => y.drugId === tx.drugId && y.locationId === tx.locationId && y.lotNo === l.lotNo), '批號')
        postStock({ kind: 'in', type: 'return', drugId: tx.drugId, locationId: tx.locationId, qty: -l.qty, lot: { lotNo: lot.lotNo, expiry: lot.expiry }, ref: `出院帶藥退回 ${a.admitNo}`, reason: why, patientId: a.patientId }, u.id, t)
      }
    }
    delete a.dischargeRx
    audit('出院帶藥退回', `${a.admitNo} ${find.patient(a.patientId)?.name}：${why}`)
    return rxView(a)
  })
}
