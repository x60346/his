// 採購單規則（純函式）：服務層與頁面共用。
import type { PurchaseLine } from '@/types'

/** 這一行還沒到的數量 */
export const remainingOf = (l: Pick<PurchaseLine, 'qty' | 'receivedQty'>) => Math.max(0, l.qty - l.receivedQty)

/** 採購金額（數量 × 進價，四捨五入到元） */
export const purchaseTotal = (lines: Pick<PurchaseLine, 'qty' | 'unitCost'>[]) => Math.round(lines.reduce((s, l) => s + l.qty * l.unitCost, 0))
