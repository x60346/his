// 採購單規則（純函式）：服務層與頁面共用。
import type { PurchaseLine } from '@/types'

/** 這一行還沒到的數量 */
export const remainingOf = (l: Pick<PurchaseLine, 'qty' | 'receivedQty'>) => Math.max(0, l.qty - l.receivedQty)

/**
 * 統一編號檢查（空白＝沒填，不檢查）：8 碼數字＋檢查碼。
 * 各位數乘上 1,2,1,2,1,2,4,1，乘積的十位與個位相加後總和能被 5 整除（2023 年起由 10 放寬為 5，舊號碼也符合）；
 * 第 7 碼是 7 時乘積 28 可算成 10 或 11，總和加 1 能整除也算對。打錯一碼幾乎一定被擋下
 */
export function taxIdProblem(taxId: string | undefined): string | null {
  const s = (taxId ?? '').trim()
  if (!s) return null
  if (!/^\d{8}$/.test(s)) return '統一編號是 8 碼數字'
  const w = [1, 2, 1, 2, 1, 2, 4, 1]
  const sum = [...s].reduce((t, c, i) => {
    const p = Number(c) * w[i]
    return t + Math.floor(p / 10) + (p % 10)
  }, 0)
  if (sum % 5 === 0 || (s[6] === '7' && (sum + 1) % 5 === 0)) return null
  return '統一編號檢查碼不符，請確認是否打錯'
}

/** 供應商名稱比對用：去頭尾空白、連續空白當一個、全形括號當半形（「（股）」「(股)」是同一家） */
export const normalizeSupplierName = (name: string) => name.trim().replace(/\s+/g, ' ').replace(/（/g, '(').replace(/）/g, ')').toLowerCase()

/** 採購金額（數量 × 進價，四捨五入到元） */
export const purchaseTotal = (lines: Pick<PurchaseLine, 'qty' | 'unitCost'>[]) => Math.round(lines.reduce((s, l) => s + l.qty * l.unitCost, 0))
