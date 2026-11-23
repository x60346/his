// 檢驗的內部計算（index 不匯出，不會被包成 API）：待檢驗清單、誰能確認、首頁的數量。
//   門診：完成看診、已批價（先批價再到檢驗科）的檢驗醫令；櫃台標「未執行」的不列
//   住院：檢驗的臨時醫囑。護理師「執行」＝已採檢，才能發報告；還沒採檢的列在清單上但不能登打
import type { Gender, LabItemDef, LabReport } from '@/types'
import { db } from '@/mock/db'
import { find, nameOf } from './views'
import { erBillMode } from './er-rules'
import { labOrderStage, opdSpecimenOf, specimenOfOrder } from './specimen-work'
import { labNeedsAck, labRefText } from './lab-rules'
import { calloutLimitOf, calloutStatus } from './callout-rules'
import { now } from '@/utils/date'

export interface LabWorkItem {
  /** E:看診id:醫令id（門診）或 O:醫囑id（住院） */
  key: string
  source: 'opd' | 'ipd'
  procId: string
  procName: string
  patientId: string
  patientName: string
  chartNo: string
  gender: Gender
  birthDate: string
  /** 門診：科別；住院：病房床號 */
  where: string
  doctorName: string
  orderedAt: string
  /** 還沒採檢（住院：護理師還沒執行這筆臨時醫囑；門診：還沒在抽血櫃台採檢）——不能發報告 */
  awaitingCollection?: boolean
  /** 住院：已採檢、檢驗科還沒收件（條碼）——收件後才能發報告 */
  awaitingReceipt?: string
  /** 儀器結果沒通過自動審核、等醫檢師在「儀器」審核（人工登打擋住） */
  analyzerHeld?: boolean
  /** 加做（住院）：掛在已收件的這支檢體（條碼）上，不用再抽 */
  addon?: string
  /** 急診的檢驗（床邊採檢、不經抽血櫃台） */
  er?: boolean
  /** 門診加做：自費還沒到批價補繳（繳完才能發報告） */
  awaitingPayment?: boolean
  /** 檢驗值的定義（畫面用同一個 judgeLab 即時標示偏高偏低）＋這位病人的參考範圍文字 */
  items: (LabItemDef & { ref: string })[]
}

export const procItems = (procId: string) => find.procedure(procId)?.labItems ?? []
export const reportedOpd = (encounterId: string, procId: string) => db.labReports.some((r) => r.encounterId === encounterId && r.procId === procId)
export const reportedIpd = (orderId: string) => db.labReports.some((r) => r.orderId === orderId)

function workItem(base: Omit<LabWorkItem, 'patientName' | 'chartNo' | 'gender' | 'birthDate' | 'items' | 'procName'>): LabWorkItem {
  const p = find.patient(base.patientId)
  const gender = p?.gender ?? 'M'
  return {
    ...base,
    procName: find.procedure(base.procId)?.name ?? base.procId,
    ...(db.analyzerResults.some((x) => x.key === base.key && x.status === 'held') ? { analyzerHeld: true } : {}),
    patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', gender, birthDate: p?.birthDate ?? '',
    items: procItems(base.procId).map((d) => ({ ...d, ref: labRefText(d, gender) })),
  }
}

/** 所有還沒發報告的檢驗（不限日期：沒做完的要一直帶著；舊的在前） */
export function pendingLabWork(): LabWorkItem[] {
  const list: LabWorkItem[] = []
  for (const e of db.encounters) {
    const v = find.visit(e.visitId)
    if (!v) continue
    const paid = e.status === 'completed' && (v.status === 'charged' || v.status === 'dispensed')
    // 急診：醫師存病歷就送出（orderedAt），不用等完成看診、批價；退掛的不算
    if (!paid && !(v.er && v.status !== 'cancelled')) continue
    for (const x of e.procedures) {
      if (x.notDone || !procItems(x.procId).length || reportedOpd(e.id, x.procId)) continue
      if (!paid && !x.orderedAt) continue
      // 門診：抽血櫃台採檢（或病人交回容器）；急診：急診護理師床邊採檢。檢驗科收件後才能登打
      const sp = opdSpecimenOf(`E:${e.id}:${x.procId}`)
      list.push(workItem({ key: `E:${e.id}:${x.procId}`, source: 'opd', procId: x.procId, patientId: e.patientId, where: v.er ? '急診' : `${nameOf.dept(e.deptId)}門診`, doctorName: nameOf.doctor(e.doctorId), orderedAt: x.addon?.at ?? x.orderedAt ?? e.completedAt ?? e.date, ...(v.er ? { er: true } : {}),
        ...(x.addon ? { addon: db.specimens.find((s) => s.id === x.addon!.specimenId)?.barcode ?? '', ...(x.addon.selfPay && !x.addon.chargeId ? { awaitingPayment: true } : {}) } : {}), ...(!sp?.collectedAt ? { awaitingCollection: true } : !sp.receivedAt ? { awaitingReceipt: sp.barcode } : {}) }))
    }
  }
  for (const o of db.ipdOrders) {
    if (o.category !== 'procedure' || o.type !== 'stat' || !o.procId || !procItems(o.procId).length) continue
    if (o.status === 'stopped' || reportedIpd(o.id)) continue
    const a = find.admission(o.admissionId)
    if (!a) continue
    const bed = a.bedId ? find.bed(a.bedId) : undefined
    list.push(workItem({
      key: `O:${o.id}`, source: 'ipd', procId: o.procId, patientId: a.patientId, where: bed ? `${bed.ward} ${bed.bedNo}` : '住院',
      doctorName: nameOf.doctor(o.doctorId), orderedAt: o.createdAt, ...(o.addonOf ? { addon: db.specimens.find((s) => s.id === o.addonOf)?.barcode ?? '' } : {}), ...(o.status === 'active' ? { awaitingCollection: true } : labOrderStage(o) === 'collected' ? { awaitingReceipt: specimenOfOrder(o.id)?.barcode ?? '' } : {}),
    }))
  }
  return list.sort((a, b) => a.orderedAt.localeCompare(b.orderedAt))
}

/** 誰能按「已知悉」：開立醫師；住院另加主治醫師 */
/**
 * 這份報告現在歸哪一次住院：住院醫囑的就是那次；急診開的、病人已經從急診收住院（直接或留觀後）還在住院中，
 * 危急值要找病房與主治，不是已經不在照顧的急診醫師
 */
export function careAdmissionOf(r: LabReport) {
  if (r.admissionId) return find.admission(r.admissionId)
  const e = r.encounterId ? db.encounters.find((x) => x.id === r.encounterId) : undefined
  const v = e ? find.visit(e.visitId) : undefined
  const id = v?.er && erBillMode(v.er) === 'ipd' ? v.er.disposition?.admissionId : undefined
  const a = id ? find.admission(id) : undefined
  return a?.status === 'admitted' ? a : undefined
}
// 開立醫師，或這份報告現在歸屬的住院的主治（急診開的、已收住院的也算）
export function canAckLab(r: LabReport, doctorId?: string): boolean {
  if (!doctorId) return false
  if (r.doctorId === doctorId) return true
  return careAdmissionOf(r)?.doctorId === doctorId
}

/** 首頁：可以登打的待檢驗（住院還沒採檢、還沒收件的不算）；某醫師待確認的報告份數 */
export const labWorkCount = () => pendingLabWork().filter((w) => !w.awaitingCollection && w.awaitingReceipt === undefined && !w.analyzerHeld && !w.awaitingPayment).length
/** 檢驗儀器：待審核的儀器結果 */
export const analyzerHeldCount = () => db.analyzerResults.filter((x) => x.status === 'held').length
export const labAckCount = (doctorId: string) => db.labReports.filter((r) => labNeedsAck(r) && canAckLab(r, doctorId)).length

/** 抽血櫃台：今天要採檢的門診病人數（已批價、檢體還沒採檢或容器還沒交回的） */
export const deskToCollectCount = () => new Set(pendingLabWork().filter((w) => w.source === 'opd' && !w.er && w.awaitingCollection).map((w) => w.patientId)).size

/** 危急值還沒通報的（其中已逾時的） */
export function calloutCounts(t: string = now()): { pending: number; late: number } {
  const xs = db.labReports.map((r) => calloutStatus(r, t, calloutMinutesOf(r.procId)).status).filter((s) => s === 'pending' || s === 'late')
  return { pending: xs.length, late: xs.filter((s) => s === 'late').length }
}

/** 這份報告的危急值通報時限（分鐘）：主檔「檢驗時限設定」有設就用，沒有用預設 */
export const calloutMinutesOf = (procId: string) => calloutLimitOf(find.procedure(procId)?.labLimits)
