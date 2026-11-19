// 給藥條碼核對的內部工具（index 不匯出）：設定、核對資料、給藥前的最後檢查。
// 畫面先逐步掃（scan.scanCheck，不符會記下來）；真正給藥時服務層用同一份規則再核對一次，不相信畫面送來的結果
import type { Admission, IpdOrder, MarRecord, ScanSkipReason, Specimen } from '@/types'
import { db } from '@/mock/db'
import { fail, failField } from './http'
import { checkDrugScan, checkPatientScan, checkSpecimenScan, SCAN_SKIP_LABEL, type ScanAdmission } from './scan-rules'
import { specimenProcIds } from './specimen-work'
import { find, nameOf } from './views'

/** 給藥前送來的掃描結果：兩個條碼，或略過（原因＋說明） */
export type ScanInput = { patientCode: string; drugCode: string } | { skip: ScanSkipReason; note?: string }

/** 給藥要不要掃描（預設要）；沒有掃描器的小醫院可以關 */
export const scanRequired = () => db.securitySettings?.requireScan !== false
/** 示範用「模擬掃描」選單（預設開：整套系統是展示用的） */
export const scanDemoAssist = () => db.securitySettings?.scanDemoAssist !== false

export const scanAdmission = (a: Admission): ScanAdmission => ({
  id: a.id, admitNo: a.admitNo, patientId: a.patientId, status: a.status, patientName: nameOf.patient(a.patientId), bedNo: find.bed(a.bedId ?? '')?.bedNo,
})
export const allScanAdmissions = () => db.admissions.filter((a) => a.admitNo && a.status !== 'reserved' && a.status !== 'cancelled').map(scanAdmission)

/** 這一劑醫囑的藥（給藥醫囑才有）；沒有藥就不用掃藥品 */
export const orderDrug = (o: IpdOrder) => (o.drugId ? find.drug(o.drugId) : undefined)

/**
 * 給藥前的最後一關：設定要求掃描時，要嘛兩個條碼都對，要嘛選了略過原因；回傳要記在給藥紀錄上的 scan。
 * 不需要掃描（設定關閉）回傳 undefined
 */
export function settleScan(a: Admission, o: IpdOrder, scan: ScanInput | undefined): MarRecord['scan'] {
  if (!scanRequired()) return undefined
  if (!scan) fail('請先掃描病人腕帶與藥品條碼（掃不了請選略過原因）', 'CONFLICT', 'scan')
  if ('skip' in scan!) {
    if (!SCAN_SKIP_LABEL[scan.skip]) failField('scan', '請選擇略過掃描的原因')
    const note = scan.note?.trim()
    return { mode: 'skipped', reason: scan.skip, ...(note ? { note } : {}) }
  }
  const p = checkPatientScan(scan!.patientCode, scanAdmission(a), allScanAdmissions())
  if (!p.ok) fail(p.message, 'CONFLICT', 'scan')
  const d = orderDrug(o)
  if (d) {
    const r = checkDrugScan(scan!.drugCode, d, db.drugs)
    if (!r.ok) fail(r.message, 'CONFLICT', 'scan')
  }
  return { mode: 'scanned' }
}

/** 稽核用：給藥紀錄的掃描結果寫成一句 */
export const scanText = (s: MarRecord['scan']) => (!s ? '' : s.mode === 'scanned' ? '已掃描核對' : `未掃描（${SCAN_SKIP_LABEL[s.reason]}${s.note ? `：${s.note}` : ''}）`)

/** 採檢前送來的掃描結果：腕帶＋檢體條碼，或略過（原因＋說明） */
export type SpecimenScanInput = { patientCode: string; specimenCode: string } | { skip: ScanSkipReason; note?: string }
const specimenTests = (s: Specimen) => specimenProcIds(s).map((id) => find.procedure(id)?.name ?? id).join('、')
/** 核對用的檢體清單（還沒退件的） */
export const scanSpecimens = () => db.specimens.filter((s) => !s.partOf).map((s) => ({ barcode: s.barcode, patientId: s.patientId, patientName: nameOf.patient(s.patientId), tests: specimenTests(s) }))
export const scanSpecimenTarget = (s: Specimen) => ({ barcode: s.barcode, patientId: s.patientId, tests: specimenTests(s) })

/**
 * 住院採檢前的最後一關（和給藥同一個設定）：要求掃描時，腕帶與檢體條碼都要對，或選略過原因；
 * 回傳要記在檢體上的 scan。設定關閉回傳 undefined
 */
export function settleSpecimenScan(a: Admission, s: Specimen, scan: SpecimenScanInput | undefined): Specimen['scan'] {
  if (!scanRequired()) return undefined
  if (!scan) fail('請先掃描病人腕帶與檢體條碼（掃不了請選略過原因）', 'CONFLICT', 'scan')
  if ('skip' in scan!) {
    if (!SCAN_SKIP_LABEL[scan.skip]) failField('scan', '請選擇略過掃描的原因')
    const note = scan.note?.trim()
    return { mode: 'skipped', reason: scan.skip, ...(note ? { note } : {}) }
  }
  const p = checkPatientScan(scan!.patientCode, scanAdmission(a), allScanAdmissions())
  if (!p.ok) fail(p.message, 'CONFLICT', 'scan')
  const r = checkSpecimenScan(scan!.specimenCode, scanSpecimenTarget(s), scanSpecimens())
  if (!r.ok) fail(r.message, 'CONFLICT', 'scan')
  return { mode: 'scanned' }
}
