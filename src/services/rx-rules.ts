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
