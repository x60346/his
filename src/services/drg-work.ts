// DRG 的內部工具（index 不匯出、不會被包成 API）：一次住院的分組（主診斷、這次做完的手術、病人曾有的診斷、年齡）、
// 是否適用。API 在 drg.ts、規則在 drg-rules（輸入的算法也在 drg-rules，種子用同一份）
import type { Admission } from '@/types'
import { db } from '@/mock/db'
import { ageOf, now } from '@/utils/date'
import { ipdBillOf } from './ipd-bill'
import { linePoints } from './claim-rules'
import { ipdDays } from './billing'
import { secondaryFrom, drgProcsOf, drgAlert, drgExempt, groupDrg, historyFrom, mainDiagnosisFrom, type DrgResult } from './drg-rules'
import { find } from './views'

export const mainDiagnosisOf = (a: Admission) => mainDiagnosisFrom(a)

/** 分組；住院中（還沒出院）連排了還沒做的手術一起算（預估） */
export function drgOfAdmission(a: Admission): DrgResult {
  const p = find.patient(a.patientId)
  return groupDrg({
    mainDiagnosis: mainDiagnosisFrom(a), doneProcs: drgProcsOf(a, db.surgeries, (id) => find.procedure(id)?.name ?? id, a.status !== 'discharged'),
    history: historyFrom(db.encounters, db.admissions, a.patientId, a.id), secondary: secondaryFrom(a), age: p ? ageOf(p.birthDate, (a.admittedAt ?? a.reservedAt).slice(0, 10)) : 0,
  })
}

/** 這次住院適不適用 DRG（不適用的原因）：出院了看出院轉歸，住院中看到今天的天數 */
export function drgExemptOf(a: Admission, to: string): string | undefined {
  return drgExempt({ day: !!a.day && !a.day.converted, days: ipdDays(a.admittedAt ?? a.reservedAt, a.dischargedAt ?? to), dischargeType: a.dischargeType ?? a.dischargeSummary?.dischargeType })
}

/** 首頁（主治）：我主治、住院中、適用 DRG 的，點數接近上限（80% 以上）、超過上限 */
export function drgAlertCounts(doctorId: string): { near: number; over: number } {
  const t = now()
  const xs = db.admissions.filter((a) => a.status === 'admitted' && a.doctorId === doctorId && !a.obs && !drgExemptOf(a, t)).map((a) => drgAlert(linePoints(ipdBillOf(a).lines).points, drgOfAdmission(a)).level)
  return { near: xs.filter((x) => x === 'near').length, over: xs.filter((x) => x === 'over').length }
}
