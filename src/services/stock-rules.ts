// 庫存規則（純函式）：服務層用來異動庫存，種子資料用同一套規則「重播」出半年的帳，測試用來驗證。
import type { DrugLot } from '@/types'
import { addDays } from '@/utils/date'

export interface LotTake {
  lotId: string
  lotNo: string
  qty: number
}

/**
 * FEFO（First Expire, First Out）：出庫時先扣最早到期的批號。
 * 只回傳「要從哪些批號扣多少」，不改動 lots；不夠扣回傳 null。
 * 已過期的批號不能發給病人，所以不列入可扣的範圍（盤虧報廢另外處理）。
 */
export function allocateFefo(lots: DrugLot[], qty: number, at: string, includeExpired = false): LotTake[] | null {
  const usable = lots
    .filter((l) => l.qty > 0 && (includeExpired || l.expiry >= at.slice(0, 10)))
    .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.receivedAt.localeCompare(b.receivedAt))
  const takes: LotTake[] = []
  let left = qty
  for (const l of usable) {
    if (left <= 0) break
    const n = Math.min(l.qty, left)
    takes.push({ lotId: l.id, lotNo: l.lotNo, qty: n })
    left -= n
  }
  return left > 0 ? null : takes
}

/** 可發給病人的數量（未過期批號的總和） */
export const usableQty = (lots: DrugLot[], at: string) => lots.filter((l) => l.expiry >= at.slice(0, 10)).reduce((s, l) => s + l.qty, 0)

export type StockStatus = 'out' | 'low' | 'ok'

/** 庫存狀態：沒有可用量 → 缺貨；低於安全庫存 → 偏低 */
export function stockStatus(usable: number, safetyStock: number): StockStatus {
  if (usable <= 0) return 'out'
  return usable <= safetyStock ? 'low' : 'ok'
}

/** 預估可用天數：近 N 天平均日用量推算；沒有用量回傳 null（不是「無限天」——是不知道） */
export function daysOfSupply(usable: number, usedInPeriod: number, periodDays: number): number | null {
  if (usedInPeriod <= 0) return null
  return Math.floor(usable / (usedInPeriod / periodDays))
}

/** 效期提醒門檻：60 天內到期 */
export const EXPIRY_WARN_DAYS = 60
export const isExpiringSoon = (expiry: string, today: string) => expiry >= today && expiry <= addDays(today, EXPIRY_WARN_DAYS)
