// 護理排班與責任分床（純函式）：護病比上限、是否超過、分床建議（依床號連續平均分）、某個月的日期、複製上個月的對應日。
// 排班頁、護理站、服務層、測試都用這一份
import type { StaffingSettings } from '@/types'
import { addDays } from '@/utils/date'

export type ShiftName = '白班' | '小夜' | '大夜'
export const SHIFTS: ShiftName[] = ['白班', '小夜', '大夜']
/** 區域醫院標準（一位護理師最多照顧幾位病人） */
export const RATIO_DEFAULT: StaffingSettings['ratio'] = { 白班: 7, 小夜: 11, 大夜: 15 }

/** 護病比：病人數、護理師數；沒排人且有病人＝超過 */
export function ratioState(patients: number, nurses: number, limit: number): { text: string; over: boolean } {
  if (!nurses) return { text: patients ? `${patients} 位病人，沒有排護理師` : '—', over: patients > 0 }
  const per = Math.round((patients / nurses) * 10) / 10
  return { text: `1：${per}（上限 1：${limit}）`, over: per > limit }
}

export function checkRatio(r: Partial<StaffingSettings['ratio']>): Record<string, string> {
  const e: Record<string, string> = {}
  for (const s of SHIFTS) if (!(Number.isInteger(r[s]) && r[s]! >= 1 && r[s]! <= 30)) e[s] = '1–30 的整數'
  return e
}

/** 分床建議：病人依床號排好、護理師依順序，連續平均分（同一位護理師的病人在一起，走動少） */
export function suggestAssign(patientIds: string[], nurseIds: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (!nurseIds.length) return out
  const per = Math.ceil(patientIds.length / nurseIds.length)
  patientIds.forEach((p, i) => (out[p] = nurseIds[Math.min(nurseIds.length - 1, Math.floor(i / per))]))
  return out
}

/** 某個月（YYYY-MM）的每一天 */
export function monthDates(month: string): string[] {
  const out: string[] = []
  for (let d = `${month}-01`; d.startsWith(month); d = addDays(d, 1)) out.push(d)
  return out
}

/** 複製上個月：每一天照 4 週前（同一個星期幾）那天的班 */
export const copySourceOf = (date: string) => addDays(date, -28)
