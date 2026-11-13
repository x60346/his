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

/** 調劑單還沒結束（待調劑、已核對）：等著領藥、要算進缺藥需求的。已發藥、已退藥的都不算 */
/** 處方第 idx 項已經退了多少（所有退藥紀錄加總） */
export const returnedQty = (d: { returns?: { lines: { idx: number; qty: number }[] }[] }, idx: number) =>
  (d.returns ?? []).reduce((n, r) => n + r.lines.filter((l) => l.idx === idx).reduce((s, l) => s + l.qty, 0), 0)

/** 病人實際拿走的藥：處方數量扣掉已退的（退完的拿掉）。批價重算部分退費用 */
export function keptMedications<T extends { qty: number }>(meds: T[], d?: { returns?: { lines: { idx: number; qty: number }[] }[] }): T[] {
  return meds.map((m, i) => ({ ...m, qty: m.qty - (d ? returnedQty(d, i) : 0) })).filter((m) => m.qty > 0)
}

export const dispenseOpen = (d: { status: string }) => d.status === 'pending' || d.status === 'verified'
