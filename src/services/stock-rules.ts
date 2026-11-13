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

/** 補貨建議涵蓋的天數：補完要撐得到下一次進貨 */
export const RESTOCK_COVER_DAYS = 14

export interface RestockSuggestion {
  /** 建議數量（取整到 10；不需要補為 0） */
  qty: number
  /** 未取整的需要量 */
  raw: number
  /** 給使用者看的算式，例：「缺 12＋安全庫存 50＋14 天用量 42＝104 → 110」 */
  formula: string
}

/**
 * 建議補貨量 ＝（等著領的需求 − 現有可用 − 已申請未到貨）＋ 安全庫存 ＋ 14 天用量（近 30 天日均推算），無條件進位到 10。
 * 以前固定「缺量＋500」：一天用 2 顆的藥也補 500，一天用 80 顆的藥補完兩週又缺。
 * 「已申請未到貨」算進現有：第二位病人缺同一種藥時，只建議追加不夠的部分，不會重複叫一整批。
 */
export function suggestRestockQty(i: { usable: number; need: number; safetyStock: number; used30: number; onOrder?: number }): RestockSuggestion {
  const cover = Math.ceil((Math.max(0, i.used30) / 30) * RESTOCK_COVER_DAYS)
  const have = i.usable + (i.onOrder ?? 0)
  const left = have - i.need // 這些病人領完後還剩多少（負的就是缺多少）
  const raw = i.safetyStock + cover - left
  const qty = raw > 0 ? Math.ceil(raw / 10) * 10 : 0
  const head = left < 0 ? `缺 ${-left}＋` : ''
  const tail = left > 0 ? `－現有 ${left}` : ''
  const onOrder = i.onOrder ? `（已扣除申請中 ${i.onOrder}）` : ''
  return { qty, raw, formula: `${head}安全庫存 ${i.safetyStock}＋${RESTOCK_COVER_DAYS} 天用量 ${cover}${tail}${raw > 0 ? `＝${raw} → ${qty}` : '，已足夠、不需追加'}${onOrder}` }
}

/**
 * 沒有採購單的進貨，要選原因（一般進貨請走採購單：開單、核准、到貨對品項入庫）。
 * 這些是「確實會發生、但不經採購」的情況；異動帳上會標「無單進貨：原因」，月底對帳查得到。
 */
export const NO_PO_REASONS = ['緊急調貨（向鄰近藥局借調）', '廠商贈品／樣品', '病人退藥回收', '其他'] as const

// ---------- 庫存地點 ----------
/** 地點負責的工作：每項同一時間只由一個啟用中的地點負責 */
export type LocationRole = 'opd' | 'ipd' | 'receiving'
export const LOCATION_ROLES: { key: LocationRole; flag: 'dispensesOpd' | 'dispensesIpd' | 'receivesPurchase'; label: string; verb: string; pharmacyOnly: boolean }[] = [
  { key: 'opd', flag: 'dispensesOpd', label: '門診發藥', verb: '扣', pharmacyOnly: true },
  { key: 'ipd', flag: 'dispensesIpd', label: '住院調劑與病房常備', verb: '扣', pharmacyOnly: true },
  { key: 'receiving', flag: 'receivesPurchase', label: '採購入庫', verb: '入', pharmacyOnly: false },
]
export const LOCATION_NAME_MAX = 12
export const normalizeLocationName = (s: string) => (s ?? '').trim().replace(/\s+/g, '').toLowerCase()
/** 地點名稱：必填、最多 12 字 */
export function locationNameProblem(name: string): string | null {
  const n = (name ?? '').trim()
  if (!n) return '請輸入地點名稱'
  if (n.length > LOCATION_NAME_MAX) return `地點名稱最多 ${LOCATION_NAME_MAX} 字`
  return null
}
