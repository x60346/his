// 盤點單規則（純函式）：服務層與頁面共用。
import type { StocktakeLine, StocktakeSheet } from '@/types'

/** 還在進行中的盤點單（清點中、待覆核）：範圍內的帳上數量不給看，同一批號也不能同時在兩張單上 */
export const isOpenStocktake = (s: Pick<StocktakeSheet, 'status'>) => s.status === 'counting' || s.status === 'submitted'

/** 差異＝實點 − 清點那一刻的帳上數量；還沒清點的沒有差異 */
export const lineDiff = (l: Pick<StocktakeLine, 'counted' | 'systemQty'>) => (l.counted === undefined ? undefined : l.counted - (l.systemQty ?? 0))

/**
 * 誰不能覆核：清點過任何一列的人、送出的人——「點的人自己核」等於沒有覆核。
 * 回傳擋下的原因；可以覆核回傳 undefined。
 */
export function reviewBlocker(s: Pick<StocktakeSheet, 'status' | 'lines' | 'submittedBy'>, userId: string): string | undefined {
  if (s.status !== 'submitted') return '這張盤點單不是待覆核狀態'
  if (s.submittedBy === userId) return '送出盤點的人不能自己覆核，請由另一位藥師或管理員覆核'
  if (s.lines.some((l) => l.countedBy === userId)) return '有清點這張單的人不能自己覆核，請由另一位藥師或管理員覆核'
  return undefined
}

/** 送出前：每一批都要有實點數量（沒有的請填 0） */
export const uncountedLines = (s: Pick<StocktakeSheet, 'lines'>) => s.lines.filter((l) => l.counted === undefined)
