// 管制藥品收支結存簿冊（藥師）：某一種管制藥、在某一個地點（藥庫、藥局、病房常備…）、某段期間逐筆的收入、支出、結存。
// 帳就是庫存異動帳（stockTxns），簿冊只是「依法規要的樣子」整理：給藥、發藥到哪位病人、哪位醫師開的、誰經手、誰見證，
// 再加上管制藥注射劑的殘餘量銷毀（給藥紀錄 MarRecord.residual：整支已經扣了，這一列不動結存，只記錄銷毀與見證）。
// 期初＝期間前最後一筆的結存，期末＝期間內最後一筆的結存；逐筆加總一定要對得上（測試核對）。
import type { Dispense, Drug, StockLocation, StockTxn, StockTxnType } from '@/types'
import { db } from '@/mock/db'
import { addDays } from '@/utils/date'
import { fail, fieldErrors, must, query, requireUser } from './http'
import { doseUnitOf } from './billing'
import { chineseUpper, needsSpecialRx } from './controlled-rules'
import { find, nameOf, stockLoc } from './views'

const TYPE_LABEL: Record<StockTxnType, string> = {
  opening: '期初', receive: '進貨', dispense: '發藥／給藥', adjust: '調整', 'transfer-out': '撥出', 'transfer-in': '撥入', return: '退回',
}

const TYPE_KEY = Object.fromEntries(Object.entries(TYPE_LABEL).map(([k, v]) => [v, k as StockTxnType])) as Record<string, StockTxnType>

export interface ControlledLedgerRow {
  at: string
  /** in 收入、out 支出、residual 殘餘量銷毀（不動結存） */
  kind: 'in' | 'out' | 'residual'
  typeLabel: string
  /** 收入或支出的量（殘餘量銷毀是銷毀的量） */
  qty: number
  /** 這一筆之後的結存（殘餘量銷毀＝前一筆的結存） */
  balance: number
  ref?: string
  reason?: string
  patientName?: string
  chartNo?: string
  doctorName?: string
  /** 門診發藥的領藥人：本人或代領（姓名、關係）；第一～三級另有身分證號 */
  receiver?: string
  receiverIdNo?: string
  userName: string
  witnessName?: string
}

export interface ControlledLedger {
  drug: Pick<Drug, 'id' | 'name' | 'nameZh' | 'spec' | 'unit' | 'controlled'>
  locationId: string
  locationName: string
  from: string
  to: string
  opening: number
  closing: number
  totalIn: number
  totalOut: number
  residualTotal: number
  rows: ControlledLedgerRow[]
}

export interface ControlledLedgerOptions {
  drugs: { id: string; name: string; controlled: number; unit: string }[]
  /** 所有地點（含病房常備、待報廢區）：簿冊是每個地點各一本 */
  locations: { id: string; name: string; kind: string }[]
}

/** 簿冊的選項：管制藥、所有地點 */
export function controlledLedgerOptions(): Promise<ControlledLedgerOptions> {
  return query(() => {
    requireUser('pharmacist', 'admin')
    return {
      drugs: db.drugs.filter((d) => d.controlled).sort((a, b) => (a.controlled ?? 9) - (b.controlled ?? 9) || a.name.localeCompare(b.name)).map((d) => ({ id: d.id, name: d.name, controlled: d.controlled!, unit: d.unit })),
      locations: db.stockLocations.filter((l) => l.active || db.stockTxns.some((t) => t.locationId === l.id)).map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
    }
  })
}

/** 門診發藥的領藥人（調劑單上的 pickupCheck） */
function receiverOf(d: Dispense): Pick<ControlledLedgerRow, 'receiver' | 'receiverIdNo'> {
  const c = d.pickupCheck
  if (!c) return {}
  return { receiver: c.method === 'proxy' ? `代領：${c.proxyName}（${c.relation}）` : '本人', ...(c.idNo ? { receiverIdNo: c.idNo } : {}) }
}

/** 異動的病人、醫師、領藥人：新的異動直接記著；舊的（開帳時、示範資料）從門診調劑單、住院號回推 */
function whoOf(t: StockTxn): { patientId?: string; doctorId?: string; dispense?: Dispense } {
  const d = db.dispenses.find((x) => x.txnIds?.includes(t.id))
  if (t.patientId) return { patientId: t.patientId, doctorId: t.doctorId, ...(d ? { dispense: d } : {}) }
  if (d) return { patientId: d.patientId, doctorId: db.encounters.find((e) => e.id === d.encounterId)?.doctorId, dispense: d }
  const ln = db.udDispenses.flatMap((u) => u.lines).find((l) => l.txnId === t.id)
  if (ln) return { patientId: find.admission(ln.admissionId)?.patientId, doctorId: db.ipdOrders.find((o) => o.id === ln.orderId)?.doctorId }
  const admitNo = t.ref?.match(/I\d{6,}/)?.[0]
  const a = admitNo ? db.admissions.find((x) => x.admitNo === admitNo) : undefined
  return a ? { patientId: a.patientId } : {}
}

/** 某管制藥、某地點、某期間的簿冊 */
export function controlledLedger(q: { drugId: string; locationId: string; from: string; to: string }): Promise<ControlledLedger> {
  return query(() => {
    requireUser('pharmacist', 'admin')
    const v = fieldErrors()
    const drug = find.drug(q.drugId ?? '')
    if (!drug) v.add('drugId', '請選擇藥品')
    else if (!drug.controlled) v.add('drugId', `${drug.name}不是管制藥品`)
    const loc = db.stockLocations.find((l) => l.id === q.locationId)
    if (!loc) v.add('locationId', '請選擇地點')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '')) v.add('from', '請選擇起始日期')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '')) v.add('to', '請選擇結束日期')
    else if (q.to < q.from) v.add('to', '結束日期不能早於起始日期')
    v.done()
    return ledgerOf(drug!, loc!, q.from, q.to)
  })
}

/** 簿冊的計算（簿冊與申報表共用：申報表的每一格就是某本簿冊的期初、收入、支出、期末，兩邊不會各算各的） */
function ledgerOf(drug: Drug, loc: StockLocation, from: string, to: string): ControlledLedger {
  const q = { from, to }
  const all = db.stockTxns.filter((t) => t.drugId === drug.id && t.locationId === loc.id).sort((a, b) => a.at.localeCompare(b.at))
  const inRange = (at: string) => at.slice(0, 10) >= q.from && at.slice(0, 10) <= q.to
  const before = all.filter((t) => t.at.slice(0, 10) < q.from).at(-1)
  const opening = before?.balance ?? 0
  const rows: ControlledLedgerRow[] = []
  for (const t of all.filter((x) => inRange(x.at))) {
    const w = whoOf(t)
    const p = w.patientId ? find.patient(w.patientId) : undefined
    rows.push({
      at: t.at, kind: t.qty > 0 ? 'in' : 'out', typeLabel: TYPE_LABEL[t.type] ?? t.type, qty: Math.abs(t.qty), balance: t.balance,
      ...(t.ref ? { ref: t.ref } : {}), ...(t.reason ? { reason: t.reason } : {}),
      ...(p ? { patientName: p.name, chartNo: p.chartNo } : {}),
      ...(w.doctorId ? { doctorName: nameOf.doctor(w.doctorId) } : {}),
      ...(w.dispense && t.type === 'dispense' ? receiverOf(w.dispense) : {}),
      userName: nameOf.user(t.userId),
      ...(t.witnessBy ? { witnessName: nameOf.user(t.witnessBy) } : {}),
    })
  }
  // 殘餘量銷毀：給藥紀錄上的；扣帳的地點＝病房常備（stockFrom ward）或住院藥局（藥局直送、UD 調劑）
  const wardOf = (admissionId: string) => {
    const a = find.admission(admissionId)
    const bed = a?.bedId ? find.bed(a.bedId) : undefined
    return bed ? stockLoc.ward(bed.ward)?.id : undefined
  }
  for (const m of db.mar.filter((x) => x.residual && x.executedAt && inRange(x.executedAt))) {
    const o = db.ipdOrders.find((x) => x.id === m.orderId)
    if (o?.drugId !== drug.id) continue
    const where = m.stockFrom === 'ward' ? wardOf(m.admissionId) : stockLoc.ipd()
    if (where !== loc.id) continue
    const a = find.admission(m.admissionId)
    const p = a ? find.patient(a.patientId) : undefined
    rows.push({
      at: m.executedAt!, kind: 'residual', typeLabel: '殘餘量銷毀', qty: m.residual!.qty, balance: 0,
      reason: `給 ${o.dose} ${drug.unit}，殘餘 ${m.residual!.qty} ${drug.unit} 當場銷毀`,
      ...(a ? { ref: a.admitNo } : {}), ...(p ? { patientName: p.name, chartNo: p.chartNo } : {}),
      doctorName: nameOf.doctor(o.doctorId), userName: nameOf.user(m.nurseId), witnessName: nameOf.user(m.residual!.witnessBy),
    })
  }
  // PCA 剩餘量銷毀：架設時從住院藥局扣一整袋，結束時剩下的 ml 換算成袋（不動結存，只記錄銷毀與見證）
  for (const p of db.pcas.filter((x) => x.drugId === drug.id && x.end && x.end.residualMl > 0 && inRange(x.end.at))) {
    if (stockLoc.ipd() !== loc.id) continue
    const vol = drug.pca?.volumeMl ?? 100
    const a = find.admission(p.admissionId)
    const pt = a ? find.patient(a.patientId) : undefined
    rows.push({
      at: p.end!.at, kind: 'residual', typeLabel: '殘餘量銷毀', qty: Math.round((p.end!.residualMl / vol) * 100) / 100, balance: 0,
      reason: `PCA 結束（${p.end!.reason}），剩餘 ${p.end!.residualMl} ml 當場銷毀`,
      ...(a ? { ref: a.admitNo } : {}), ...(pt ? { patientName: pt.name, chartNo: pt.chartNo } : {}),
      doctorName: nameOf.doctor(find.user(p.orderedBy)?.doctorId), userName: nameOf.user(p.end!.by), witnessName: nameOf.user(p.end!.witnessBy),
    })
  }
  // 依時間排；同一刻殘餘量排在給藥那一筆後面。殘餘量那一列的結存＝前一筆
  rows.sort((a, b) => a.at.localeCompare(b.at) || Number(a.kind === 'residual') - Number(b.kind === 'residual'))
  let bal = opening
  for (const r of rows) {
    if (r.kind === 'residual') r.balance = bal
    else bal = r.balance
  }
  const closing = rows.filter((r) => r.kind !== 'residual').at(-1)?.balance ?? opening
  return {
    drug: { id: drug.id, name: drug.name, nameZh: drug.nameZh, spec: drug.spec, unit: drug.unit, controlled: drug.controlled },
    locationId: loc.id, locationName: loc.name, from: q.from, to: q.to,
    opening, closing,
    totalIn: rows.filter((r) => r.kind === 'in').reduce((n, r) => n + r.qty, 0),
    totalOut: rows.filter((r) => r.kind === 'out').reduce((n, r) => n + r.qty, 0),
    residualTotal: Math.round(rows.filter((r) => r.kind === 'residual').reduce((n, r) => n + r.qty, 0) * 100) / 100,
    rows,
  }
}

// ---------- 定期申報 ----------

export interface ControlledReportRow {
  drugId: string
  drugName: string
  nameZh: string
  spec: string
  unit: string
  controlled: number
  /** 地點；全院合計那一列是 undefined */
  locationId?: string
  locationName: string
  opening: number
  totalIn: number
  totalOut: number
  residualTotal: number
  closing: number
}

export interface ControlledReport {
  from: string
  to: string
  /** 每種藥：各地點一列（有帳的地點），後面接一列全院合計 */
  rows: ControlledReportRow[]
}

/** 院內撥補（藥庫 → 藥局 → 病房）：對全院來說只是換地點，全院合計不算收入也不算支出 */
const INTERNAL: StockTxnType[] = ['transfer-in', 'transfer-out']

/**
 * 管制藥品收支結存申報表（定期向主管機關申報；展示用：期間自選，常用月報、年報）：
 * 每種管制藥、每個地點一列——就是那本簿冊的期初、收入、支出、期末；再加一列全院合計（院內撥補互相抵銷，不算收支）。
 * 期間內沒有帳也沒有結存的地點不列。
 */
export function controlledReport(q: { from: string; to: string }): Promise<ControlledReport> {
  return query(() => {
    requireUser('pharmacist', 'admin')
    const v = fieldErrors()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '')) v.add('from', '請選擇起始日期')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '')) v.add('to', '請選擇結束日期')
    else if (q.to < q.from) v.add('to', '結束日期不能早於起始日期')
    else if (q.to > addDays(q.from, 366)) v.add('to', '申報期間最長一年')
    v.done()
    const rows: ControlledReportRow[] = []
    const drugs = db.drugs.filter((d) => d.controlled).sort((a, b) => (a.controlled ?? 9) - (b.controlled ?? 9) || a.name.localeCompare(b.name))
    for (const drug of drugs) {
      const base = { drugId: drug.id, drugName: drug.name, nameZh: drug.nameZh, spec: drug.spec, unit: drug.unit, controlled: drug.controlled! }
      const locs = db.stockLocations.filter((l) => db.stockTxns.some((t) => t.drugId === drug.id && t.locationId === l.id && t.at.slice(0, 10) <= q.to))
      const per = locs.map((l) => ledgerOf(drug, l, q.from, q.to)).filter((L) => L.rows.length || L.opening || L.closing)
      for (const L of per) rows.push({ ...base, locationId: L.locationId, locationName: L.locationName, opening: L.opening, totalIn: L.totalIn, totalOut: L.totalOut, residualTotal: L.residualTotal, closing: L.closing })
      if (!per.length) continue
      const ext = (kind: 'in' | 'out') => per.reduce((n, L) => n + L.rows.filter((r) => r.kind === kind && !INTERNAL.includes(TYPE_KEY[r.typeLabel])).reduce((s, r) => s + r.qty, 0), 0)
      const sum = (k: 'opening' | 'closing' | 'residualTotal') => Math.round(per.reduce((n, L) => n + L[k], 0) * 100) / 100
      rows.push({ ...base, locationName: '全院合計', opening: sum('opening'), totalIn: ext('in'), totalOut: ext('out'), residualTotal: sum('residualTotal'), closing: sum('closing') })
    }
    return { from: q.from, to: q.to, rows }
  })
}


// ---------- 門診專用處方箋 ----------

export interface SpecialRxSheet {
  encounterId: string
  date: string
  patient: { name: string; chartNo: string; gender: string; birthDate: string; idNo: string; address: string }
  diagnoses: string[]
  dept: string
  doctor: { name: string; licenseNo: string; controlledLicenseNo: string }
  items: { drugName: string; nameZh: string; spec: string; controlled: number; dose: number; doseUnit: string; freqLabel: string; route: string; days: number; qty: number; qtyUpper: string; unit: string }[]
  /** 這張處方的領藥號（批價後才有） */
  pickupNo?: number
}

/**
 * 管制藥品專用處方箋（門診，第一～三級）：只列第一～三級的藥（其他藥照一般處方）；總量附國字大寫。
 * 開立時已檢查過執照與必填（opd.completeEncounter），這裡只整理列印用的資料
 */
export function specialRxSheet(encounterId: string): Promise<SpecialRxSheet> {
  return query(() => {
    requireUser('doctor', 'pharmacist', 'admin')
    const e = must(db.encounters.find((x) => x.id === encounterId), '病歷')
    const items = e.medications.flatMap((m) => {
      const d = find.drug(m.drugId)
      if (!d || !needsSpecialRx(d.controlled)) return []
      return [{ drugName: d.name, nameZh: d.nameZh, spec: d.spec, controlled: d.controlled!, dose: m.dose, doseUnit: doseUnitOf(d), freqLabel: find.freq(m.freq)?.label ?? m.freq, route: m.route, days: m.days, qty: m.qty, qtyUpper: chineseUpper(m.qty), unit: d.unit }]
    })
    if (!items.length) fail('這次處方沒有第一～三級管制藥，不需要專用處方箋')
    const p = must(find.patient(e.patientId), '病患')
    const doc = find.doctor(e.doctorId)
    return {
      encounterId: e.id, date: e.date,
      patient: { name: p.name, chartNo: p.chartNo, gender: p.gender === 'M' ? '男' : '女', birthDate: p.birthDate, idNo: p.idNo, address: p.address },
      diagnoses: e.diagnoses.map((d) => `${d.icd} ${d.name}`),
      dept: nameOf.dept(e.deptId),
      doctor: { name: doc?.name ?? e.doctorId, licenseNo: doc?.licenseNo ?? '', controlledLicenseNo: doc?.controlledLicense?.no ?? '' },
      items,
      ...(() => { const d = db.dispenses.find((x) => x.encounterId === e.id); return d ? { pickupNo: d.pickupNo } : {} })(),
    }
  })
}
