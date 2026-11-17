// 排班與分床的內部工具（index 不匯出、不會被包成 API）：現在是哪一班、這班誰上班、病人分給誰、「我的病人」範圍（首頁待辦用）。
// 規則在 staffing-rules
import { db } from '@/mock/db'
import { addDays } from '@/utils/date'
import { shiftOf } from './nursing-rules'
import { RATIO_DEFAULT, ratioState, type ShiftName } from './staffing-rules'
import { find } from './views'
import { icuWard } from '@/mock/codes'
import { ICU_RATIO_DEFAULT } from './icu-rules'

export interface ShiftRef { date: string; shift: ShiftName }

export const shiftNow = (t: string): ShiftRef => ({ date: t.slice(0, 10), shift: shiftOf(t) })
/** 下一班（大夜 → 白班 → 小夜 → 隔天大夜） */
export function nextShift(s: ShiftRef): ShiftRef {
  if (s.shift === '大夜') return { date: s.date, shift: '白班' }
  if (s.shift === '白班') return { date: s.date, shift: '小夜' }
  return { date: addDays(s.date, 1), shift: '大夜' }
}

export const ratioOf = () => db.staffingSettings?.ratio ?? RATIO_DEFAULT
/** 加護病房護病比上限（三班同一個） */
export const icuRatioOf = () => db.staffingSettings?.icuRatio ?? ICU_RATIO_DEFAULT

/** 這一班這個病房排了誰（依排班順序） */
export const onDuty = (ward: string, s: ShiftRef): string[] =>
  db.nurseShifts.filter((x) => x.ward === ward && x.date === s.date && x.shift === s.shift).map((x) => x.nurseId)

/** 這一班這位病人分給誰 */
export const assignedNurse = (admissionId: string, s: ShiftRef): string | undefined =>
  db.nurseAssignments.find((x) => x.admissionId === admissionId && x.date === s.date && x.shift === s.shift)?.nurseId

/** 病房目前住院中的病人 */
export const wardAdmissions = (ward: string) => db.admissions.filter((a) => a.status === 'admitted' && a.bedId && find.bed(a.bedId)?.ward === ward)

/** 這一班的護病比（病人數依目前住院中；過去或未來的班也用目前人數估） */
export function staffingOf(ward: string, s: ShiftRef) {
  const nurses = onDuty(ward, s)
  const patients = wardAdmissions(ward).length
  const limit = ward === icuWard ? icuRatioOf() : ratioOf()[s.shift]
  return { nurses, patients, limit, ...ratioState(patients, nurses.length, limit) }
}

/** 「我的病人」：這位護理師這一班分到的病人；這班沒有分到任何人＝不限（看全部） */
export function myScope(nurseId: string | undefined, t: string): Set<string> | undefined {
  if (!nurseId) return undefined
  const s = shiftNow(t)
  const mine = db.nurseAssignments.filter((x) => x.nurseId === nurseId && x.date === s.date && x.shift === s.shift).map((x) => x.admissionId)
  return mine.length ? new Set(mine) : undefined
}
