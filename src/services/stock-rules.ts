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

/**
 * 需要藥師處理的事項（可以同時有好幾項，例：偏低又近效期）；空陣列就是「正常」。
 * 庫存清單的狀態標籤、「只看需處理」篩選、上方摘要卡片的數字都用這一份結果——
 * 以前狀態只看庫存量，篩選和卡片另外算效期，結果「需處理」清單裡出現標著「正常」的藥。
 * 陣列順序就是嚴重度（清單依第一項排序）。
 */
export type StockFlag = 'out' | 'low' | 'expired' | 'expiring'
export const STOCK_FLAG_ORDER: StockFlag[] = ['out', 'low', 'expired', 'expiring']

export function stockFlags(r: { status: StockStatus; expiredQty: number; expiringSoon: boolean }): StockFlag[] {
  const flags: StockFlag[] = []
  if (r.status !== 'ok') flags.push(r.status)
  if (r.expiredQty > 0) flags.push('expired')
  if (r.expiringSoon) flags.push('expiring')
  return flags
}

/**
 * 盤點的「實際清點數量」：0 以上的整數。回傳錯誤訊息，正確回傳 null。
 * 服務層（stocktake）與盤點對話框共用——輸入不合法時畫面不顯示差異（以前輸入 -3 會同時出現錯誤和「差異 -23（盤虧）」）。
 */
export function checkStocktakeActual(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return '請輸入實際清點數量'
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? null : '實際數量需為 0 以上的整數'
}
