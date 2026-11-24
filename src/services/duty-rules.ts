// 醫師值班（純函式）：下班時間（平日 17:00 到隔天 08:00、週六日全天）由各科一位值班醫師接主治不在時的急事。
// 凌晨 08:00 前算前一天那一班。服務層（duty.ts、床邊處置判讀升級、危急值通報提示）、畫面、種子、測試共用
import type { DutyShift } from '@/types'

/** 要排值班的科（有醫師、會收住院的臨床科；放射科、感染科、急診不排） */
export const DUTY_DEPTS = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08']
export const DUTY_DAY_START = 8
export const DUTY_DAY_END = 17
const hourOf = (t: string) => Number(t.slice(11, 13))
const weekdayOf = (date: string) => new Date(`${date}T00:00:00`).getDay()
const prevDay = (date: string) => { const d = new Date(`${date}T00:00:00`); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
/** 這個時間是不是下班時間（值班醫師負責） */
export function isOffHours(t: string): boolean {
  const h = hourOf(t)
  const wd = weekdayOf(t.slice(0, 10))
  return wd === 0 || wd === 6 || h < DUTY_DAY_START || h >= DUTY_DAY_END
}
/** 這個時間屬於哪一天的值班（凌晨 08:00 前算前一天） */
export const dutyDateOf = (t: string) => (hourOf(t) < DUTY_DAY_START ? prevDay(t.slice(0, 10)) : t.slice(0, 10))
/** 某一科現在的值班（上班時間回 undefined） */
export const onCallFor = <S extends Pick<DutyShift, 'date' | 'deptId'>>(shifts: S[], deptId: string, t: string): S | undefined =>
  isOffHours(t) ? shifts.find((s) => s.deptId === deptId && s.date === dutyDateOf(t)) : undefined
/** 值班時段的文字 */
export const dutyHoursText = (date: string) => ((wd) => (wd === 0 || wd === 6 ? `${date.slice(5).replace('-', '/')} 08:00 到隔天 08:00（假日全天）` : `${date.slice(5).replace('-', '/')} 17:00 到隔天 08:00`))(weekdayOf(date))
