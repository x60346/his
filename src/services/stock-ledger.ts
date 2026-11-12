// 庫存帳本的唯一寫入點（服務層內部模組）。
//
// 這個檔案「不」在 services/index.ts 對外：頁面拿到的 xxxApi 都是包過權限檢查的服務函式，
// postStock 本身不檢查登入與角色（它是給進貨、發藥、盤點過帳這些已經檢查過權限的服務呼叫的）。
// 以前它從 inventory.ts 匯出，overNetwork(inventory) 就把它一起對外了——任何頁面都能直接改庫存。
// 流程測試會檢查：各 Api 不得有 postStock、index.ts 不得匯出這個模組。
import type { DrugLot, RestockRequest, RestockStatus, StockTxn, StockTxnType } from '@/types'
import { db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { fail, failField, fieldErrors, must } from './http'
import { allocateFefo, usableQty } from './stock-rules'
import { find, stockLoc } from './views'

export type Post =
  | { kind: 'in'; drugId: string; locationId: string; qty: number; type: StockTxnType; lot: Pick<DrugLot, 'lotNo' | 'expiry'>; ref?: string; reason?: string }
  | { kind: 'out'; drugId: string; locationId: string; qty: number; type: StockTxnType; ref?: string; reason?: string; includeExpired?: boolean; lotId?: string }

/** 寫入一筆庫存異動。出庫依 FEFO 扣批號（或指定批號），不足時整筆失敗 */
export function postStock(p: Post, userId: string, at = now()): StockTxn {
  const drug = must(find.drug(p.drugId), '藥品')
  if (!Number.isInteger(p.qty) || p.qty <= 0) fail('數量需為正整數')
  const loc = stockLoc.usable(p.locationId)
  const lots = stockLoc.lots(drug.id, loc.id)
  let moved: { lotNo: string; qty: number }[]

  if (p.kind === 'in') {
    // 同批號再進貨就加到原批號（效期必須一致）
    let lot = lots.find((l) => l.lotNo === p.lot.lotNo)
    if (lot && lot.expiry !== p.lot.expiry) failField('lotNo', `批號 ${p.lot.lotNo} 已存在，效期為 ${lot.expiry}，與輸入不符`)
    if (!lot) {
      lot = { id: newId('LOT'), drugId: drug.id, locationId: loc.id, lotNo: p.lot.lotNo, expiry: p.lot.expiry, qty: 0, receivedAt: at }
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
    if (!takes) fail(`${drug.name} ${loc.name}可用庫存不足（需 ${p.qty}，可用 ${usableQty(lots, at)}）`, 'CONFLICT')
    for (const t of takes!) db.drugLots.find((l) => l.id === t.lotId)!.qty -= t.qty
    moved = takes!.map((t) => ({ lotNo: t.lotNo, qty: -t.qty }))
  }

  const signed = p.kind === 'in' ? p.qty : -p.qty
  drug.stock += signed
  // 結存是「這個地點」的：異動後該地點所有批號的總和（和帳本逐筆累加一致）
  const balance = stockLoc.lots(drug.id, loc.id).reduce((s, l) => s + l.qty, 0)
  const txn: StockTxn = { id: newId('ST'), drugId: drug.id, locationId: loc.id, at, type: p.type, qty: signed, balance, lots: moved, ref: p.ref, reason: p.reason, userId }
  db.stockTxns.push(txn)
  return txn
}


// ---------- 入庫共用（無單進貨、採購到貨） ----------

/**
 * 入庫的數量、批號、效期檢查，和呼叫端自己的欄位錯誤（例：無單進貨的原因）一起，一次標出所有欄位；
 * 回傳整理過的批號（轉大寫）
 */
export function checkReceiveInput(input: { qty: number; lotNo: string; expiry: string }, opts: { maxQty?: number; errors?: Record<string, string> } = {}): string {
  const lotNo = (input.lotNo ?? '').trim().toUpperCase()
  const maxQty = opts.maxQty
  const v = fieldErrors()
  for (const [k, m] of Object.entries(opts.errors ?? {})) v.add(k, m)
  if (!Number.isInteger(input.qty) || input.qty <= 0) v.add('qty', '數量需為正整數')
  else if (maxQty !== undefined && input.qty > maxQty) v.add('qty', `超過尚未到貨的數量（還差 ${maxQty}）`)
  if (!lotNo) v.add('lotNo', '請輸入批號')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiry ?? '')) v.add('expiry', '請輸入效期')
  else if (input.expiry <= today()) v.add('expiry', '效期已過或為今天，不可進貨')
  v.done()
  return lotNo
}

/** 補貨申請：同一種藥同時只有一張待到貨的 */
export const openRestockOf = (drugId: string) => db.restockRequests.find((x) => x.drugId === drugId && x.status === 'open')
export const outstandingOf = (r: RestockRequest) => Math.max(0, r.qty - r.receivedQty)

/**
 * 入庫後沖銷這種藥待到貨的補貨申請——不然貨已經上架，申請還掛著，首頁一直提醒「待到貨」。到齊就結案，不足留著記下尚欠。
 * 補貨申請是「門診藥局」的需求（窗口缺藥、病人在等），只有藥進了門診藥局才算：
 * 小型醫院採購到貨就是進藥局；大型醫院採購到貨進的是藥庫，要等撥補簽收進門診藥局才沖銷
 * （以前不分地點，大型醫院藥庫一到貨申請就結案，病人在窗口還是領不到）。
 */
export function offsetRestock(drugId: string, txn: StockTxn, userId: string): { id: string; status: RestockStatus; outstanding: number } | undefined {
  if (txn.locationId !== stockLoc.opd()) return undefined
  const req = openRestockOf(drugId)
  if (!req) return undefined
  req.receivedQty += txn.qty
  req.txnIds.push(txn.id)
  const outstanding = outstandingOf(req)
  if (!outstanding) Object.assign(req, { status: 'fulfilled', closedAt: txn.at, closedBy: userId })
  return { id: req.id, status: req.status, outstanding }
}
