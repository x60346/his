// 藥品庫存：帳本（異動紀錄）、批號、進貨、盤點、報廢過期。
//
// 核心原則：庫存只能透過 postStock 改變。
//   - 每次增減寫一筆 StockTxn（帳本只增不改）
//   - 同時更新批號剩餘量與 drug.stock（快取）
//   - drug.stock 永遠等於所有批號剩餘量的總和，也等於帳本加總——流程測試會驗證這個不變式
// 其他模組（藥局發藥）要扣庫存，也是呼叫 postStock，不可以自己去改 drug.stock。
import type { Drug, DrugLot, StockTxn, StockTxnType } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failField, must, mutate, query, requireUser } from './http'
import { allocateFefo, daysOfSupply, isExpiringSoon, stockStatus, usableQty, type StockStatus } from './stock-rules'
import { find, nameOf } from './views'

// ---------- 唯一的寫入點（服務層內部） ----------
type Post =
  | { kind: 'in'; drugId: string; qty: number; type: StockTxnType; lot: Pick<DrugLot, 'lotNo' | 'expiry'>; ref?: string; reason?: string }
  | { kind: 'out'; drugId: string; qty: number; type: StockTxnType; ref?: string; reason?: string; includeExpired?: boolean; lotId?: string }

/** 寫入一筆庫存異動。出庫依 FEFO 扣批號（或指定批號），不足時整筆失敗 */
export function postStock(p: Post, userId: string, at = now()): StockTxn {
  const drug = must(find.drug(p.drugId), '藥品')
  if (!Number.isInteger(p.qty) || p.qty <= 0) fail('數量需為正整數')
  const lots = db.drugLots.filter((l) => l.drugId === drug.id)
  let moved: { lotNo: string; qty: number }[]

  if (p.kind === 'in') {
    // 同批號再進貨就加到原批號（效期必須一致）
    let lot = lots.find((l) => l.lotNo === p.lot.lotNo)
    if (lot && lot.expiry !== p.lot.expiry) failField('lotNo', `批號 ${p.lot.lotNo} 已存在，效期為 ${lot.expiry}，與輸入不符`)
    if (!lot) {
      lot = { id: newId('LOT'), drugId: drug.id, lotNo: p.lot.lotNo, expiry: p.lot.expiry, qty: 0, receivedAt: at }
      db.drugLots.push(lot)
    }
    lot.qty += p.qty
    moved = [{ lotNo: lot.lotNo, qty: p.qty }]
  } else {
    const takes = p.lotId
      ? (() => {
          const l = must(lots.find((x) => x.id === p.lotId), '批號')
          return l.qty >= p.qty ? [{ lotId: l.id, lotNo: l.lotNo, qty: p.qty }] : null
        })()
      : allocateFefo(lots, p.qty, at, p.includeExpired)
    if (!takes) fail(`${drug.name} 可用庫存不足（需 ${p.qty}，可用 ${usableQty(lots, at)}）`, 'CONFLICT')
    for (const t of takes!) db.drugLots.find((l) => l.id === t.lotId)!.qty -= t.qty
    moved = takes!.map((t) => ({ lotNo: t.lotNo, qty: -t.qty }))
  }

  const signed = p.kind === 'in' ? p.qty : -p.qty
  drug.stock += signed
  const txn: StockTxn = { id: newId('ST'), drugId: drug.id, at, type: p.type, qty: signed, balance: drug.stock, lots: moved, ref: p.ref, reason: p.reason, userId }
  db.stockTxns.push(txn)
  return txn
}

// ---------- 查詢 ----------
const USAGE_DAYS = 30

export interface InventoryRow extends Drug {
  /** 未過期、可發給病人的數量 */
  usable: number
  /** 已過期、待報廢的數量 */
  expiredQty: number
  status: StockStatus
  /** 近 30 天發藥量 */
  used30: number
  /** 預估可用天數（無用量時為 null） */
  daysLeft: number | null
  /** 最近到期的批號效期（有剩餘量者） */
  nearestExpiry?: string
  expiringSoon: boolean
}

function inventoryRow(d: Drug, t: string): InventoryRow {
  const lots = db.drugLots.filter((l) => l.drugId === d.id && l.qty > 0)
  const usable = usableQty(lots, t)
  const since = addDays(t, -USAGE_DAYS)
  const used30 = -db.stockTxns.filter((x) => x.drugId === d.id && x.type === 'dispense' && x.at >= since).reduce((s, x) => s + x.qty, 0)
  const nearestExpiry = lots.filter((l) => l.expiry >= t).map((l) => l.expiry).sort()[0]
  return {
    ...d,
    usable,
    expiredQty: lots.filter((l) => l.expiry < t).reduce((s, l) => s + l.qty, 0),
    status: stockStatus(usable, d.safetyStock),
    used30,
    daysLeft: daysOfSupply(usable, used30, USAGE_DAYS),
    nearestExpiry,
    expiringSoon: !!nearestExpiry && isExpiringSoon(nearestExpiry, t),
  }
}

export interface InventoryQuery {
  keyword?: string
  category?: string
  /** 只看需要處理的：缺貨、偏低、效期將到、有過期品 */
  attentionOnly?: boolean
}

export function listInventory(q: InventoryQuery = {}): Promise<InventoryRow[]> {
  return query(() => {
    const t = today()
    const kw = q.keyword?.trim().toLowerCase()
    const order: Record<StockStatus, number> = { out: 0, low: 1, ok: 2 }
    return db.drugs
      .filter((d) => d.active && (!q.category || d.category === q.category))
      .filter((d) => !kw || [d.id, d.name, d.generic, d.nhiCode].some((x) => x.toLowerCase().includes(kw)))
      .map((d) => inventoryRow(d, t))
      .filter((r) => !q.attentionOnly || r.status !== 'ok' || r.expiringSoon || r.expiredQty > 0)
      .sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name))
  })
}

export interface InventorySummary {
  total: number
  out: number
  low: number
  expiring: number
  expired: number
}

export function inventorySummary(): Promise<InventorySummary> {
  return query(() => {
    const t = today()
    const rows = db.drugs.filter((d) => d.active).map((d) => inventoryRow(d, t))
    return {
      total: rows.length,
      out: rows.filter((r) => r.status === 'out').length,
      low: rows.filter((r) => r.status === 'low').length,
      expiring: rows.filter((r) => r.expiringSoon).length,
      expired: rows.filter((r) => r.expiredQty > 0).length,
    }
  })
}

export interface StockTxnView extends StockTxn {
  userName: string
}

/** 藥品庫存明細（BFF）：庫存狀態、批號、異動紀錄、近 30 天每日用量，一次取回 */
export interface DrugLedger {
  row: InventoryRow
  lots: DrugLot[]
  txns: StockTxnView[]
  /** 近 30 天每日發藥量（含今天），供趨勢圖 */
  daily: { date: string; qty: number }[]
}

export function getDrugLedger(drugId: string): Promise<DrugLedger> {
  return query(() => {
    const d = must(find.drug(drugId), '藥品')
    const t = today()
    const txns = db.stockTxns.filter((x) => x.drugId === d.id)
    const daily = Array.from({ length: USAGE_DAYS }, (_, i) => addDays(t, i - USAGE_DAYS + 1)).map((date) => ({
      date,
      qty: -txns.filter((x) => x.type === 'dispense' && x.at.startsWith(date)).reduce((s, x) => s + x.qty, 0),
    }))
    return {
      row: inventoryRow(d, t),
      lots: db.drugLots.filter((l) => l.drugId === d.id && l.qty > 0).sort((a, b) => a.expiry.localeCompare(b.expiry)),
      // 帳本只增不改，寫入順序就是發生順序：新到舊直接反轉，不用時間排序——
      // 時間只到分鐘，同一分鐘的兩筆（報廢後馬上盤點）用時間排會分不出先後，結存就看起來跳號
      txns: [...txns].reverse().slice(0, 100).map((x) => ({ ...x, userName: nameOf.user(x.userId) })),
      daily,
    }
  })
}

// ---------- 異動 ----------
export interface ReceiveInput {
  drugId: string
  qty: number
  lotNo: string
  expiry: string
  /** 進貨單號 */
  ref?: string
}

/** 進貨：新增或累加批號 */
export function receiveStock(input: ReceiveInput): Promise<StockTxn> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const lotNo = input.lotNo.trim().toUpperCase()
    if (!lotNo) failField('lotNo', '請輸入批號')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiry ?? '')) failField('expiry', '請輸入效期')
    if (input.expiry <= today()) failField('expiry', '效期已過或為今天，不可進貨')
    if (!Number.isInteger(input.qty) || input.qty <= 0) failField('qty', '進貨數量需為正整數')
    const txn = postStock({ kind: 'in', type: 'receive', drugId: input.drugId, qty: input.qty, lot: { lotNo, expiry: input.expiry }, ref: input.ref?.trim() || undefined }, u.id)
    audit('藥品進貨', `${find.drug(input.drugId)?.name} +${input.qty}（批號 ${lotNo}）`)
    return txn
  })
}

/**
 * 盤點：輸入「實際清點到的數量」，系統算出差異並寫入調整。
 * 人只負責填看到的事實（貨架上還有 47 盒），差異由系統算，避免心算出錯。
 * 盤點以批號為單位——不同批號效期不同，混在一起盤就不知道少的是哪一批。
 */
export function stocktake(input: { lotId: string; actual: number; reason: string }): Promise<StockTxn | null> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const lot = must(db.drugLots.find((l) => l.id === input.lotId), '批號')
    if (!Number.isInteger(input.actual) || input.actual < 0) failField('actual', '實際數量需為 0 以上的整數')
    const diff = input.actual - lot.qty
    if (diff === 0) return null // 帳實相符，不需要調整
    if (!input.reason.trim()) failField('reason', '帳實不符，請註明原因（例：破損、過期報廢、計數錯誤）')
    const reason = input.reason.trim()
    const txn =
      diff > 0
        ? postStock({ kind: 'in', type: 'adjust', drugId: lot.drugId, qty: diff, lot: { lotNo: lot.lotNo, expiry: lot.expiry }, reason }, u.id)
        : postStock({ kind: 'out', type: 'adjust', drugId: lot.drugId, qty: -diff, lotId: lot.id, reason }, u.id)
    audit('藥品盤點', `${find.drug(lot.drugId)?.name} 批號 ${lot.lotNo}：帳 ${lot.qty - diff} → 實 ${input.actual}（${reason}）`)
    return txn
  })
}

/** 報廢某藥所有已過期批號 */
export function scrapExpired(drugId: string): Promise<StockTxn[]> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const t = today()
    const expired = db.drugLots.filter((l) => l.drugId === drugId && l.qty > 0 && l.expiry < t)
    if (!expired.length) fail('沒有已過期的批號')
    const txns = expired.map((l) => postStock({ kind: 'out', type: 'adjust', drugId, qty: l.qty, lotId: l.id, reason: `過期報廢（效期 ${l.expiry}）` }, u.id))
    audit('過期藥品報廢', `${find.drug(drugId)?.name} ${expired.map((l) => l.lotNo).join('、')}`)
    return txns
  })
}
