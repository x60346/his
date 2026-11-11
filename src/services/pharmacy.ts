// 門診藥局：調劑清單、核對、發藥（扣庫存）。
// 扣庫存一律透過 inventory.postStock：寫異動帳、依 FEFO 扣批號；這裡不直接改 drug.stock。
// 狀態：pending（待調劑）→ verified（已核對）→ dispensed（已發藥，掛號狀態同步為 dispensed）。
import type { Dispense, DispenseStatus, Drug } from '@/types'
import { db } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, must, mutate, query, requireUser } from './http'
import { checkAllergies, type AllergyWarning } from './allergy'
import { doseUnitOf } from './billing'
import { postStock } from './inventory'
import { usableQty } from './stock-rules'
import { find, nameOf, patientBrief, type PatientBrief } from './views'

export interface DispenseItem {
  drugId: string
  drugName: string
  spec: string
  /** 調劑單位（總量用） */
  unit: string
  /** 給藥單位（每次劑量用） */
  doseUnit: string
  dose: number
  freq: string
  freqLabel: string
  route: string
  days: number
  qty: number
  /** 可用庫存（未過期批號）——過期的藥在架上也不能發 */
  stock: number
  highAlert: boolean
  shortage: boolean
}

export interface DispenseView extends Dispense, PatientBrief {
  date: string
  doctorName: string
  deptName: string
  items: DispenseItem[]
  allergyWarnings: AllergyWarning[]
  diagnoses: string[]
}

function dispenseView(d: Dispense): DispenseView {
  const e = must(db.encounters.find((x) => x.id === d.encounterId), '病歷')
  const p = find.patient(d.patientId)
  const items: DispenseItem[] = e.medications.map((m) => {
    const drug = find.drug(m.drugId)
    const usable = usableQty(db.drugLots.filter((l) => l.drugId === m.drugId), today())
    return {
      drugId: m.drugId,
      drugName: drug?.name ?? m.drugId,
      spec: drug?.spec ?? '',
      unit: drug?.unit ?? '',
      doseUnit: drug ? doseUnitOf(drug) : '',
      dose: m.dose,
      freq: m.freq,
      freqLabel: find.freq(m.freq)?.label ?? m.freq,
      route: m.route,
      days: m.days,
      qty: m.qty,
      stock: usable,
      highAlert: drug?.highAlert ?? false,
      shortage: d.status !== 'dispensed' && usable < m.qty,
    }
  })
  const drugs = e.medications.map((m) => find.drug(m.drugId)).filter((x): x is Drug => !!x)
  return {
    ...d,
    ...patientBrief(d.patientId),
    date: e.date,
    doctorName: nameOf.doctor(e.doctorId),
    deptName: nameOf.dept(e.deptId),
    items,
    allergyWarnings: checkAllergies(p?.allergies ?? [], drugs),
    diagnoses: e.diagnoses.map((x) => `${x.icd} ${x.name}`),
  }
}

/**
 * 某一天的調劑清單：
 *   待調劑／已核對：當天「以前（含）」開立、還沒發藥的——沒做完的工作要一直帶著走，
 *     以前只看「開立當天」，昨天批價沒領的病人今天回來，清單上找不到他。
 *   已發藥：當天「發出」的（依發藥時間，不是開立日）——昨天的單今天才領，算今天的工作量。
 * 排序：當天開立的在前（依領藥號），前幾天的接在後面（依日期、領藥號）——窗口前的人優先。
 */
/** 這一天還等著領藥的單：當天以前（含）開立、還沒發藥。藥局清單與首頁「待領藥」共用 */
export const awaitingPickup = (d: Pick<Dispense, 'status' | 'createdAt'>, date: string) => d.status !== 'dispensed' && d.createdAt.slice(0, 10) <= date

export function listDispenses(q: { date: string; status?: DispenseStatus[] }): Promise<DispenseView[]> {
  return query(() =>
    db.dispenses
      .filter((d) => (d.status === 'dispensed' ? !!d.dispensedAt?.startsWith(q.date) : awaitingPickup(d, q.date)))
      .filter((d) => !q.status || q.status.includes(d.status))
      .sort((a, b) => {
        const da = a.createdAt.slice(0, 10)
        const db_ = b.createdAt.slice(0, 10)
        return Number(da !== q.date) - Number(db_ !== q.date) || da.localeCompare(db_) || a.pickupNo - b.pickupNo
      })
      .map(dispenseView),
  )
}

export const getDispense = (id: string): Promise<DispenseView> => query(() => dispenseView(must(db.dispenses.find((d) => d.id === id), '調劑單')))

function assertStock(view: DispenseView): void {
  const short = view.items.filter((i) => i.stock < i.qty)
  if (short.length) fail(`庫存不足：${short.map((i) => `${i.drugName}（需 ${i.qty}，存 ${i.stock}）`).join('、')}`, 'CONFLICT')
}

/** 核對處方（第一位藥師） */
export function verifyDispense(id: string): Promise<DispenseView> {
  return mutate(() => {
    const ph = requireUser('pharmacist')
    const d = must(db.dispenses.find((x) => x.id === id), '調劑單')
    if (d.status !== 'pending') fail('此單已核對', 'CONFLICT')
    assertStock(dispenseView(d))
    d.status = 'verified'
    d.verifiedBy = ph.id
    d.verifiedAt = now()
    audit('調劑核對', `領藥號 ${d.pickupNo}`)
    return dispenseView(d)
  })
}

/** 發藥：扣庫存 → 調劑單 dispensed → 掛號 dispensed（整筆交易，任一藥不足就全部不扣） */
export function dispense(id: string): Promise<DispenseView> {
  return mutate(() => {
    const ph = requireUser('pharmacist')
    const d = must(db.dispenses.find((x) => x.id === id), '調劑單')
    if (d.status !== 'verified') fail('請先完成核對再發藥', 'CONFLICT')
    const view = dispenseView(d)
    assertStock(view)
    // 每個品項寫一筆發藥異動；任何一項失敗，mutate 會整筆回滾（不會只扣一半）
    for (const item of view.items) postStock({ kind: 'out', type: 'dispense', drugId: item.drugId, qty: item.qty, ref: `領藥號 ${d.pickupNo}` }, ph.id)
    d.status = 'dispensed'
    d.dispensedBy = ph.id
    d.dispensedAt = now()
    must(find.visit(d.visitId), '掛號紀錄').status = 'dispensed'
    audit('發藥', `領藥號 ${d.pickupNo} ${view.patientName}`)
    return dispenseView(d)
  })
}
