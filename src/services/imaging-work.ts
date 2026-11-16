// 影像檢查的內部計算（index 不匯出，不會被包成 API）：待判讀清單、誰能判讀、誰能確認、首頁數量。
// 待判讀不另存，由醫令推算（同檢驗）：
//   門診：完成看診、已批價的影像醫令；櫃台標「未執行」的不列
//   住院：影像的臨時醫囑，護理師執行（已檢查）後才能判讀；還沒執行的列出但不能寫
// 判讀者：主檔 imaging.reader——radiology＝放射科醫師（科別代碼 RAD）；orderer＝開立醫師自己（心電圖）
import type { ImagingReport } from '@/types'
import { db } from '@/mock/db'
import { find, nameOf } from './views'

export interface ImagingWorkItem {
  /** E:看診id:醫令id（門診）或 O:醫囑id（住院） */
  key: string
  source: 'opd' | 'ipd'
  procId: string
  procName: string
  reader: 'radiology' | 'orderer'
  patientId: string
  patientName: string
  chartNo: string
  gender: 'M' | 'F'
  birthDate: string
  where: string
  doctorId: string
  doctorName: string
  orderedAt: string
  /** 臨床資訊：診斷（判讀時參考） */
  clinical: string
  /** 住院：還沒做（臨時醫囑還沒執行） */
  awaitingExam?: boolean
  normal: { findings: string; impression: string }
}

export const imagingOf = (procId: string) => find.procedure(procId)?.imaging
export const reportedImagingOpd = (encounterId: string, procId: string) => db.imagingReports.some((r) => r.encounterId === encounterId && r.procId === procId)
export const reportedImagingIpd = (orderId: string) => db.imagingReports.some((r) => r.orderId === orderId)

/** 這位醫師是不是放射科 */
export const isRadiologist = (doctorId?: string) => {
  const d = doctorId ? find.doctor(doctorId) : undefined
  return !!d && db.departments.find((x) => x.id === d.deptId)?.code === 'RAD'
}

/** 這位醫師能不能判讀這一筆：放射科判讀 radiology 的；開立醫師判讀 orderer 的（心電圖） */
export const canReadImaging = (w: Pick<ImagingWorkItem, 'reader' | 'doctorId'>, doctorId?: string) =>
  !!doctorId && (w.reader === 'radiology' ? isRadiologist(doctorId) : w.doctorId === doctorId)

/** 所有還沒判讀的影像（舊的在前） */
export function pendingImagingWork(): ImagingWorkItem[] {
  const list: ImagingWorkItem[] = []
  const base = (patientId: string) => {
    const p = find.patient(patientId)
    return { patientId, patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', gender: p?.gender ?? 'M', birthDate: p?.birthDate ?? '' }
  }
  for (const e of db.encounters) {
    if (e.status !== 'completed') continue
    const v = find.visit(e.visitId)
    if (!v || (v.status !== 'charged' && v.status !== 'dispensed')) continue
    for (const x of e.procedures) {
      const im = imagingOf(x.procId)
      if (!im || x.notDone || reportedImagingOpd(e.id, x.procId)) continue
      list.push({
        key: `E:${e.id}:${x.procId}`, source: 'opd', procId: x.procId, procName: find.procedure(x.procId)?.name ?? x.procId, reader: im.reader, ...base(e.patientId),
        where: `${nameOf.dept(e.deptId)}門診`, doctorId: e.doctorId, doctorName: nameOf.doctor(e.doctorId), orderedAt: e.completedAt ?? e.date,
        clinical: e.diagnoses.map((d) => `${d.icd} ${d.name}`).join('、'), normal: im.normal,
      })
    }
  }
  for (const o of db.ipdOrders) {
    const im = o.procId ? imagingOf(o.procId) : undefined
    if (!im || o.category !== 'procedure' || o.type !== 'stat' || o.status === 'stopped' || reportedImagingIpd(o.id)) continue
    const a = find.admission(o.admissionId)
    if (!a) continue
    const bed = a.bedId ? find.bed(a.bedId) : undefined
    list.push({
      key: `O:${o.id}`, source: 'ipd', procId: o.procId!, procName: find.procedure(o.procId!)?.name ?? o.procId!, reader: im.reader, ...base(a.patientId),
      where: bed ? `${bed.ward} ${bed.bedNo}` : '住院', doctorId: o.doctorId, doctorName: nameOf.doctor(o.doctorId), orderedAt: o.createdAt,
      clinical: a.diagnosis, normal: im.normal, ...(o.status === 'active' ? { awaitingExam: true } : {}),
    })
  }
  return list.sort((a, b) => a.orderedAt.localeCompare(b.orderedAt))
}

/** 要確認：重要發現、或有補充報告，而且還沒確認 */
export const imagingNeedsAck = (r: Pick<ImagingReport, 'significant' | 'addenda' | 'ackAt'>) => !r.ackAt && (!!r.significant || !!r.addenda?.length)

/** 誰能按「已知悉」：開立醫師；住院另加主治醫師 */
export function canAckImaging(r: ImagingReport, doctorId?: string): boolean {
  if (!doctorId) return false
  if (r.doctorId === doctorId) return true
  return !!r.admissionId && find.admission(r.admissionId)?.doctorId === doctorId
}

/** 首頁：這位醫師可以判讀的（不含還沒做的）；待確認的份數 */
export const imagingWorkCount = (doctorId: string) => pendingImagingWork().filter((w) => !w.awaitingExam && canReadImaging(w, doctorId)).length
export const imagingAckCount = (doctorId: string) => db.imagingReports.filter((r) => imagingNeedsAck(r) && canAckImaging(r, doctorId)).length
