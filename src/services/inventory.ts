// 藥品庫存：帳本（異動紀錄）、批號、進貨、盤點、報廢過期。
//
// 核心原則：庫存只能透過 postStock 改變。
//   - 每次增減寫一筆 StockTxn（帳本只增不改），記在某個庫存地點（小型只有一個藥局；大型有藥庫與多個藥局）
//   - 同時更新該地點的批號剩餘量與 drug.stock（全院總量的快取）
//   - 不變式（流程測試驗證）：每個地點的批號總和 = 該地點帳本加總，且結存連續；drug.stock = 各地點總和
// 其他模組（藥局發藥）要扣庫存，也是呼叫 postStock，不可以自己去改 drug.stock。
import type { Dispense, Drug, DrugLot, HospitalScale, RestockRequest, RestockStatus, StockLocation, StockTxn, StockTxnType } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failField, fieldErrors, must, mutate, query, requireUser } from './http'
import { allocateFefo, daysOfSupply, isExpiringSoon, STOCK_FLAG_ORDER, stockFlags, stockStatus, suggestRestockQty, usableQty, type RestockSuggestion, type StockFlag, type StockStatus } from './stock-rules'
import { find, nameOf, stockLoc } from './views'
import { matchesDrug } from './drug-rules'

// ---------- 唯一的寫入點（服務層內部） ----------
type Post =
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

// ---------- 查詢 ----------
const USAGE_DAYS = 30

export interface InventoryRow extends Drug {
  /** 這一列是哪個地點的（stock、safetyStock 也是這個地點的） */
  locationId: string
  /**
   * 正在盤點（盲盤）：盤點單號。有它時 stock、usable、expiredQty、daysLeft 都是 0／null、flags 為空——
   * 數量不給看，畫面要先看這個欄位，顯示「盤點中」而不是 0
   */
  counting?: string
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
  /** 需要處理的事項（缺貨／偏低／待報廢／近效期），空陣列表示正常；見 stock-rules.ts 的 stockFlags */
  flags: StockFlag[]
  /** 待到貨的補貨申請（沒有就不給）：尚欠數量、有幾位病人在等 */
  restock?: { id: string; outstanding: number; waiting: number }
}

/** 這個地點的「用量」：發給病人的，加上撥給別的地點的（藥庫的用量就是撥出量） */
const isUsage = (x: StockTxn) => x.type === 'dispense' || x.type === 'transfer-out'

function inventoryRow(d: Drug, t: string, locationId: string): InventoryRow {
  const lots = stockLoc.lots(d.id, locationId).filter((l) => l.qty > 0)
  const usable = usableQty(lots, t)
  const since = addDays(t, -USAGE_DAYS)
  const used30 = -db.stockTxns.filter((x) => x.drugId === d.id && x.locationId === locationId && isUsage(x) && x.at >= since).reduce((s, x) => s + x.qty, 0)
  const safetyStock = stockLoc.safety(d, locationId)
  const nearestExpiry = lots.filter((l) => l.expiry >= t).map((l) => l.expiry).sort()[0]
  const row = {
    ...d,
    // 這個地點的安全庫存與帳上量（藥品主檔的 stock 是全院總量）
    safetyStock,
    stock: lots.reduce((s, l) => s + l.qty, 0),
    locationId,
    usable,
    expiredQty: lots.filter((l) => l.expiry < t).reduce((s, l) => s + l.qty, 0),
    status: stockStatus(usable, safetyStock),
    used30,
    daysLeft: daysOfSupply(usable, used30, USAGE_DAYS),
    nearestExpiry,
    expiringSoon: !!nearestExpiry && isExpiringSoon(nearestExpiry, t),
  }
  const req = openRestockOf(d.id)
  const restock = req ? { restock: { id: req.id, outstanding: outstandingOf(req), waiting: waitingOf(req).length } } : {}
  const counting = stockLoc.counting(d.id, locationId)
  // 盲盤：數量、可用天數、缺貨偏低的標籤都會洩漏帳上數量，一律遮掉
  if (counting) return { ...row, stock: 0, usable: 0, expiredQty: 0, daysLeft: null, status: 'ok', flags: [], counting, ...restock }
  return { ...row, flags: stockFlags(row), ...restock }
}

export interface InventoryQuery {
  /** 哪個地點（沒給＝門診發藥的藥局） */
  locationId?: string
  keyword?: string
  category?: string
  /** 只看需要處理的：缺貨、偏低、效期將到、有過期品 */
  attentionOnly?: boolean
  /** 只看有其中任一標籤的（摘要卡片點擊用；和卡片數字同一個來源 flags） */
  flags?: StockFlag[]
  /** 只看有「待到貨」補貨申請的（有病人在等的排前面） */
  restockOnly?: boolean
}

export function listInventory(q: InventoryQuery = {}): Promise<InventoryRow[]> {
  return query(() => {
    const t = today()
    const loc = stockLoc.usable(q.locationId).id
    const kw = q.keyword?.trim().toLowerCase()
    return db.drugs
      .filter((d) => d.active && (!q.category || d.category === q.category))
      .filter((d) => !kw || matchesDrug(d, kw))
      .map((d) => inventoryRow(d, t, loc))
      .filter((r) => !q.attentionOnly || r.flags.length > 0)
      .filter((r) => !q.flags?.length || r.flags.some((f) => q.flags!.includes(f)))
      .filter((r) => !q.restockOnly || !!r.restock)
      .sort((a, b) => (q.restockOnly ? (b.restock?.waiting ?? 0) - (a.restock?.waiting ?? 0) : 0) || rank(a) - rank(b) || a.name.localeCompare(b.name))
  })
}

/** 排序：依最嚴重的一項（缺貨 → 偏低 → 待報廢 → 近效期 → 正常） */
const rank = (r: InventoryRow) => (r.flags.length ? STOCK_FLAG_ORDER.indexOf(r.flags[0]) : STOCK_FLAG_ORDER.length)

export interface InventorySummary {
  total: number
  out: number
  low: number
  expiring: number
  expired: number
  /** 待到貨的補貨申請數（一種藥最多一張） */
  restockOpen: number
}

export function inventorySummary(locationId?: string): Promise<InventorySummary> {
  return query(() => {
    const t = today()
    const loc = stockLoc.usable(locationId).id
    const rows = db.drugs.filter((d) => d.active).map((d) => inventoryRow(d, t, loc))
    return {
      total: rows.length,
      // 和清單的標籤同一個來源：卡片上的數字 = 有該標籤的藥品數
      out: rows.filter((r) => r.flags.includes('out')).length,
      low: rows.filter((r) => r.flags.includes('low')).length,
      expiring: rows.filter((r) => r.flags.includes('expiring')).length,
      expired: rows.filter((r) => r.flags.includes('expired')).length,
      restockOpen: rows.filter((r) => r.restock).length,
    }
  })
}

export interface StockTxnView extends StockTxn {
  userName: string
}

/** 藥品庫存明細（BFF）：庫存狀態、批號、異動紀錄、近 30 天每日用量，一次取回 */
export interface DrugLedger {
  /** 正在盤點：批號只列批號效期（數量 0）、異動不列（結存會洩漏帳上數量） */
  counting?: string
  row: InventoryRow
  lots: DrugLot[]
  txns: StockTxnView[]
  /** 近 30 天每日發藥量（含今天），供趨勢圖 */
  daily: { date: string; qty: number }[]
  /** 待到貨的補貨申請 */
  restock?: RestockView
}

export function getDrugLedger(drugId: string, locationId?: string): Promise<DrugLedger> {
  return query(() => {
    const d = must(find.drug(drugId), '藥品')
    const t = today()
    const loc = stockLoc.usable(locationId).id
    const txns = db.stockTxns.filter((x) => x.drugId === d.id && x.locationId === loc)
    const daily = Array.from({ length: USAGE_DAYS }, (_, i) => addDays(t, i - USAGE_DAYS + 1)).map((date) => ({
      date,
      qty: -txns.filter((x) => isUsage(x) && x.at.startsWith(date)).reduce((s, x) => s + x.qty, 0),
    }))
    const counting = stockLoc.counting(d.id, loc)
    const lots = stockLoc.lots(d.id, loc).filter((l) => l.qty > 0).sort((a, b) => a.expiry.localeCompare(b.expiry))
    return {
      ...(counting ? { counting } : {}),
      row: inventoryRow(d, t, loc),
      lots: counting ? lots.map((l) => ({ ...l, qty: 0 })) : lots,
      // 帳本只增不改，寫入順序就是發生順序：新到舊直接反轉，不用時間排序——
      // 時間只到分鐘，同一分鐘的兩筆（報廢後馬上盤點）用時間排會分不出先後，結存就看起來跳號
      txns: counting ? [] : [...txns].reverse().slice(0, 100).map((x) => ({ ...x, userName: nameOf.user(x.userId) })),
      daily,
      ...(openRestockOf(d.id) ? { restock: restockView(openRestockOf(d.id)!) } : {}),
    }
  })
}

// ---------- 異動 ----------
export interface ReceiveInput {
  drugId: string
  /** 入哪個地點（沒給＝採購入庫的地點：小型＝藥局、大型＝藥庫） */
  locationId?: string
  qty: number
  lotNo: string
  expiry: string
  /** 進貨單號 */
  ref?: string
}

export interface ReceiveResult extends StockTxn {
  /** 這次進貨抵掉的補貨申請：全部到齊就結案，不足就留著並記下尚欠多少 */
  restock?: { id: string; status: RestockStatus; outstanding: number }
}

/**
 * 進貨：新增或累加批號。
 * 這種藥有「待到貨」的補貨申請時，進貨量自動抵掉申請（不管從申請按「到貨入庫」或一般「進貨」進來）——
 * 不然貨已經上架，申請還掛著，首頁一直提醒「待到貨」。
 */
export function receiveStock(input: ReceiveInput): Promise<ReceiveResult> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const lotNo = input.lotNo.trim().toUpperCase()
    const v = fieldErrors()
    if (!Number.isInteger(input.qty) || input.qty <= 0) v.add('qty', '進貨數量需為正整數')
    if (!lotNo) v.add('lotNo', '請輸入批號')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiry ?? '')) v.add('expiry', '請輸入效期')
    else if (input.expiry <= today()) v.add('expiry', '效期已過或為今天，不可進貨')
    v.done()
    const txn = postStock({ kind: 'in', type: 'receive', drugId: input.drugId, locationId: input.locationId || stockLoc.receiving(), qty: input.qty, lot: { lotNo, expiry: input.expiry }, ref: input.ref?.trim() || undefined }, u.id)
    const req = openRestockOf(input.drugId)
    let restock: ReceiveResult['restock']
    if (req) {
      req.receivedQty += txn.qty
      req.txnIds.push(txn.id)
      const outstanding = outstandingOf(req)
      if (!outstanding) Object.assign(req, { status: 'fulfilled', closedAt: txn.at, closedBy: u.id })
      restock = { id: req.id, status: req.status, outstanding }
    }
    const note = !restock ? '' : restock.outstanding ? `，補貨申請尚欠 ${restock.outstanding}` : '，補貨申請已到齊'
    audit('藥品進貨', `${find.drug(input.drugId)?.name} +${input.qty}（批號 ${lotNo}${note}）`)
    return { ...txn, ...(restock ? { restock } : {}) }
  })
}

/** 報廢某藥在某地點所有已過期批號（沒給地點＝門診藥局） */
export function scrapExpired(drugId: string, locationId?: string): Promise<StockTxn[]> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const t = today()
    const loc = stockLoc.usable(locationId)
    const expired = stockLoc.lots(drugId, loc.id).filter((l) => l.qty > 0 && l.expiry < t)
    if (!expired.length) fail(`${loc.name}沒有已過期的批號`)
    const txns = expired.map((l) => postStock({ kind: 'out', type: 'adjust', drugId, locationId: loc.id, qty: l.qty, lotId: l.id, reason: `過期報廢（效期 ${l.expiry}）` }, u.id))
    audit('過期藥品報廢', `${find.drug(drugId)?.name} ${loc.name} ${expired.map((l) => l.lotNo).join('、')}`)
    return txns
  })
}

// ---------- 補貨申請（U25） ----------
// 調劑窗口缺藥：藥師只提出申請（數量），不在病人面前填批號、效期；貨到了在藥品庫存頁「到貨入庫」。
// 同一種藥同時只有一張待到貨的申請（再缺就追加），進貨時自動抵掉。

const openRestockOf = (drugId: string) => db.restockRequests.find((x) => x.drugId === drugId && x.status === 'open')
const outstandingOf = (r: RestockRequest) => Math.max(0, r.qty - r.receivedQty)
const medsOf = (d: Dispense) => db.encounters.find((e) => e.id === d.encounterId)?.medications ?? []
/** 這張申請關聯、還沒發藥的調劑單（病人還在等） */
const waitingOf = (r: RestockRequest) =>
  r.dispenseIds.map((id) => db.dispenses.find((d) => d.id === id)).filter((d): d is Dispense => !!d && d.status !== 'dispensed')

export interface RestockWaiting {
  dispenseId: string
  pickupNo: number
  /** 開立日（領藥號每天重編，要日期才分得出是哪一天的「3 號」） */
  date: string
  patientName: string
  qty: number
}

export interface RestockView extends RestockRequest {
  drugName: string
  unit: string
  usable: number
  /** 尚欠（申請 − 已到貨） */
  outstanding: number
  requestedByName: string
  waiting: RestockWaiting[]
}

function restockView(r: RestockRequest): RestockView {
  const drug = find.drug(r.drugId)
  return {
    ...r,
    drugName: drug?.name ?? r.drugId,
    unit: drug?.unit ?? '',
    usable: stockLoc.counting(r.drugId, stockLoc.opd()) ? 0 : usableQty(stockLoc.lots(r.drugId, stockLoc.opd()), today()),
    outstanding: outstandingOf(r),
    requestedByName: nameOf.user(r.requestedBy),
    waiting: waitingOf(r).map((d) => ({
      dispenseId: d.id,
      pickupNo: d.pickupNo,
      date: d.createdAt.slice(0, 10),
      patientName: find.patient(d.patientId)?.name ?? '',
      qty: medsOf(d).filter((m) => m.drugId === r.drugId).reduce((n, m) => n + m.qty, 0),
    })),
  }
}

/** 申請對話框要的資料：現有可用、所有等這種藥的需求、已申請未到貨、建議數量（算式） */
export interface RestockPlan {
  /** 門診藥局正在盤點：可用量與建議量不給（建議量是用可用量算的），請自行填數量 */
  counting?: string
  drugId: string
  drugName: string
  unit: string
  usable: number
  safetyStock: number
  used30: number
  /** 還沒發藥、處方有這種藥的調劑單需求合計（不只眼前這位——別人也在等同一種藥） */
  need: number
  waitingCount: number
  open?: RestockView
  suggestion: RestockSuggestion
}

export function getRestockPlan(drugId: string): Promise<RestockPlan> {
  return query(() => {
    const d = must(find.drug(drugId), '藥品')
    const row = inventoryRow(d, today(), stockLoc.opd())
    const waiting = db.dispenses.filter((x) => x.status !== 'dispensed' && medsOf(x).some((m) => m.drugId === d.id))
    const need = waiting.reduce((n, x) => n + medsOf(x).filter((m) => m.drugId === d.id).reduce((k, m) => k + m.qty, 0), 0)
    const open = openRestockOf(d.id)
    const counting = row.counting
    return {
      ...(counting ? { counting } : {}),
      drugId: d.id,
      drugName: d.name,
      unit: d.unit,
      usable: row.usable,
      safetyStock: row.safetyStock,
      used30: row.used30,
      need,
      waitingCount: waiting.length,
      ...(open ? { open: restockView(open) } : {}),
      suggestion: counting ? { qty: 0, raw: 0, formula: `盤點中（${counting}），可用量暫不顯示，請自行填寫數量` } : suggestRestockQty({ usable: row.usable, need, safetyStock: row.safetyStock, used30: row.used30, onOrder: open ? outstandingOf(open) : 0 }),
    }
  })
}

export interface RestockInput {
  drugId: string
  /** 申請（或追加）數量；已有待到貨申請時可為 0（只把這位病人加進等待名單） */
  qty: number
  /** 從調劑窗口申請時：哪一張調劑單在等 */
  dispenseId?: string
  note?: string
}

/** 提出補貨申請；這種藥已有待到貨的申請就追加上去（數量累加、等待名單合併） */
export function requestRestock(input: RestockInput): Promise<RestockView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const drug = must(find.drug(input.drugId), '藥品')
    if (!drug.active) fail(`${drug.name} 已停用，不能申請補貨`)
    const open = openRestockOf(drug.id)
    const qty = input.qty
    let disp: Dispense | undefined
    if (input.dispenseId) {
      disp = must(db.dispenses.find((x) => x.id === input.dispenseId), '調劑單')
      if (disp.status === 'dispensed') fail(`領藥號 ${disp.pickupNo} 已發藥，不需為它補貨`)
      if (!medsOf(disp).some((m) => m.drugId === drug.id)) fail(`領藥號 ${disp.pickupNo} 的處方沒有 ${drug.name}`)
    }
    const addsPatient = !!disp && !open?.dispenseIds.includes(disp.id)
    if (!Number.isInteger(qty) || qty < 0) failField('qty', '數量需為 0 以上的整數')
    if (!open && qty === 0) failField('qty', '請輸入申請數量')
    if (open && qty === 0 && !addsPatient) failField('qty', '請輸入追加數量')
    const note = input.note?.trim()
    const from = disp ? `（領藥號 ${disp.pickupNo}）` : ''
    if (open) {
      open.qty += qty
      if (addsPatient) open.dispenseIds.push(disp!.id)
      if (note) open.note = [open.note, note].filter(Boolean).join('；')
      audit('追加補貨申請', `${drug.name} ${qty ? `+${qty}，共 ${open.qty}` : '數量不變'} ${drug.unit}${from}`)
      return restockView(open)
    }
    const req: RestockRequest = {
      id: newId('RS'),
      drugId: drug.id,
      qty,
      receivedQty: 0,
      dispenseIds: disp ? [disp.id] : [],
      ...(note ? { note } : {}),
      requestedBy: u.id,
      requestedAt: now(),
      status: 'open',
      txnIds: [],
    }
    db.restockRequests.push(req)
    audit('補貨申請', `${drug.name} ${qty} ${drug.unit}${from}`)
    return restockView(req)
  })
}

/** 取消補貨申請（例：醫師改開替代藥、廠商缺貨改向他處調）：要寫原因 */
export function cancelRestock(id: string, reason: string): Promise<RestockView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const req = must(db.restockRequests.find((x) => x.id === id), '補貨申請')
    if (req.status !== 'open') fail('這張補貨申請已結案，不能取消')
    const why = reason?.trim()
    if (!why) failField('reason', '請註明取消原因（例：改開替代藥、廠商缺貨）')
    Object.assign(req, { status: 'cancelled', closedAt: now(), closedBy: u.id, cancelReason: why })
    audit('取消補貨申請', `${find.drug(req.drugId)?.name}（${why}）`)
    return restockView(req)
  })
}

/** 補貨申請清單：預設只看待到貨；有病人在等的排前面，其次依申請先後 */
export function listRestockRequests(q: { status?: RestockStatus } = {}): Promise<RestockView[]> {
  return query(() =>
    db.restockRequests
      .filter((x) => x.status === (q.status ?? 'open'))
      .map(restockView)
      .sort((a, b) => Number(b.waiting.length > 0) - Number(a.waiting.length > 0) || a.requestedAt.localeCompare(b.requestedAt)),
  )
}

// ---------- 庫存地點 ----------
export interface StockLocationView extends StockLocation {
  /** 有幾種藥在這裡有庫存 */
  drugCount: number
}

/** 庫存地點與醫院規模：庫存頁的地點選單用（小型只有一個，頁面就不顯示選單） */
export function listStockLocations(): Promise<{ scale: HospitalScale; locations: StockLocationView[]; opd: string; receiving: string }> {
  return query(() => ({
    scale: db.hospitalScale,
    locations: db.stockLocations
      .filter((l) => l.active)
      .map((l) => ({ ...l, drugCount: new Set(db.drugLots.filter((x) => x.locationId === l.id && x.qty > 0).map((x) => x.drugId)).size })),
    opd: stockLoc.opd(),
    receiving: stockLoc.receiving(),
  }))
}
