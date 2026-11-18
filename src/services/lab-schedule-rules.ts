// 住院長期檢驗醫囑的排程（純函式）：頻率（每日、每兩天、每週一三五、每週一次）＋抽血時間，哪一天要抽、顯示文字、輸入檢查。
// 開醫囑、產生每一次的採檢、住院醫囑列、測試都用這一份
import type { IpdOrder } from '@/types'
import { diffDays, parseDate } from '@/utils/date'

export type LabEvery = NonNullable<IpdOrder['labSchedule']>['every']
export const LAB_EVERY_LABEL: Record<LabEvery, string> = { daily: '每日', qod: '每兩天', mwf: '每週一三五', weekly: '每週一次' }

/** 「每日 06:00」 */
export const labScheduleText = (s: NonNullable<IpdOrder['labSchedule']>) => `${LAB_EVERY_LABEL[s.every]} ${s.time}`

/**
 * 這一天要不要抽、幾點抽：依頻率（每兩天、每週一次從開立那天算），抽血時間早於開立時間的那一次不算
 * （10:00 開「每日 06:00」，今天的 06:00 已經過了，從明天開始）
 */
export function labDrawAt(s: NonNullable<IpdOrder['labSchedule']>, startAt: string, date: string): string | undefined {
  const d0 = startAt.slice(0, 10)
  if (date < d0) return undefined
  const n = diffDays(d0, date)
  const wd = parseDate(date).getDay()
  const due = s.every === 'daily' || (s.every === 'qod' && n % 2 === 0) || (s.every === 'mwf' && [1, 3, 5].includes(wd)) || (s.every === 'weekly' && n % 7 === 0)
  const at = `${date} ${s.time}`
  return due && at >= startAt ? at : undefined
}

export function checkLabSchedule(s: { every?: string; time?: string } | undefined): Record<string, string> {
  const e: Record<string, string> = {}
  if (!s?.every || !(s.every in LAB_EVERY_LABEL)) e.labEvery = '長期檢驗請選頻率（每日、每兩天、每週一三五、每週一次）'
  if (!s?.time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) e.labTime = '請填抽血時間（例：06:00）'
  return e
}
