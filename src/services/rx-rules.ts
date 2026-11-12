// 處方箋有效期（純函式）：藥局清單、發藥稽核、測試共用。
// 一般處方箋自開立（看診）日起 3 日內有效，含開立當天：11/10 開立 → 11/12 是最後一天。
// 本系統「只提醒、不擋」：逾期的單仍可發藥（病人可能已在窗口前，擋下只會讓他白跑），
// 但藥師一定看得到，發藥時稽核也會記下——要不要請醫師重開，由藥師判斷。
import { addDays } from '@/utils/date'

export const RX_VALID_DAYS = 3

/** 有效期最後一天 */
export const rxValidUntil = (issueDate: string) => addDays(issueDate.slice(0, 10), RX_VALID_DAYS - 1)

/** 在 at 這天是否已逾有效期 */
export const rxExpired = (issueDate: string, at: string) => at.slice(0, 10) > rxValidUntil(issueDate)

/**
 * 調劑雙人核對（U24）：開啟時，核對處方的藥師不能自己發藥——由第二位藥師在發藥時再看一次。
 * 預設關閉：許多診所只有一位藥師，寫死兩人會讓單人藥局無法發藥，所以做成管理員可設定。
 * 回傳擋下的原因；可以發藥回傳 undefined。
 */
export function dispenseBlocker(d: { status: string; verifiedBy?: string }, userId: string, twoPerson: boolean): string | undefined {
  if (d.status !== 'verified') return undefined
  if (twoPerson && d.verifiedBy === userId) return '本院規定核對與發藥須由不同藥師：請由另一位藥師發藥'
  return undefined
}
