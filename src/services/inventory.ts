// 藥品庫存：帳本（異動紀錄）、批號、進貨、盤點、報廢過期。
//
// 核心原則：庫存只能透過 postStock 改變。
//   - 每次增減寫一筆 StockTxn（帳本只增不改），記在某個庫存地點（小型只有一個藥局；大型有藥庫與多個藥局）
//   - 同時更新該地點的批號剩餘量與 drug.stock（全院總量的快取）
//   - 不變式（流程測試驗證）：每個地點的批號總和 = 該地點帳本加總，且結存連續；drug.stock = 各地點總和
// 其他模組（藥局發藥）要扣庫存，也是呼叫 postStock，不可以自己去改 drug.stock。
import type { Dispense, Drug, DrugLot, HospitalScale, RestockRequest, RestockStatus, StockLocation, StockTxn } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failField, fieldErrors, must, mutate, query, requireUser, requirePermission } from './http'
import { LOCATION_ROLES, locationNameProblem, normalizeLocationName, type LocationRole } from './stock-rules'
import { pendingReturn } from './ud-work'
import { daysOfSupply, isExpiringSoon, STOCK_FLAG_ORDER, stockFlags, stockStatus, suggestRestockQty, usableQty, type RestockSuggestion, type StockFlag, type StockStatus, NO_PO_REASONS } from './stock-rules'
import { find, nameOf, stockLoc } from './views'
import { checkReceiveInput, offsetRestock, openRestockOf, outstandingOf, postStock } from './stock-ledger'
import { isExpired } from './stock-rules'
import { matchesDrug } from './drug-rules'
import { dispenseOpen } from './rx-rules'

// 寫入一律透過 stock-ledger.postStock（內部模組，不經 services/index 對外）

// ---------- 查詢 ----------
const USAGE_DAYS = 30

export interface InventoryRow extends Drug {
  /** 這一列是哪個地點的（stock、safetyStock 也是這個地點的） */
  locationId: string
  /** 撥往這裡、運送中還沒簽收的量（大型醫院） */
  inTransit: number
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
    inTransit: stockLoc.inTransit(d.id, locationId),
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
  /** 無單進貨的原因（NO_PO_REASONS 之一）；一般進貨請走採購單 */
  reason: string
  /** 說明（原因選「其他」時必填；例：向 OO 藥局借 2 盒） */
  note?: string
}

export interface ReceiveResult extends StockTxn {
  /** 這次進貨抵掉的補貨申請：全部到齊就結案，不足就留著並記下尚欠多少 */
  restock?: { id: string; status: RestockStatus; outstanding: number }
}

/**
 * 無單進貨：沒有採購單的入庫（緊急調貨、贈品、退藥回收…），要選原因，異動帳上標「無單進貨」。
 * 一般進貨請走採購單（開單 → 管理員核准 → 到貨對品項入庫，見 purchase.ts）。
 * 這種藥有待到貨的補貨申請時，一樣自動沖銷（病人等的是藥，不管藥從哪來）。
 */
export function receiveStock(input: ReceiveInput): Promise<ReceiveResult> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const reason = (NO_PO_REASONS as readonly string[]).includes(input.reason) ? input.reason : ''
    const note = input.note?.trim()
    const errors: Record<string, string> = {}
    if (!reason) errors.reason = '請選擇無單進貨的原因（一般進貨請開採購單）'
    else if (reason === '其他' && !note) errors.note = '原因選「其他」時請說明'
    const lotNo = checkReceiveInput(input, { errors })
    const ref = `無單進貨：${reason === '其他' ? note : reason}${reason !== '其他' && note ? `（${note}）` : ''}`
    const loc = stockLoc.usable(input.locationId || stockLoc.receiving()) // 一般作業的地點檢查（停用、待報廢區都擋）；postStock 本身允許待報廢區
    const txn = postStock({ kind: 'in', type: 'receive', drugId: input.drugId, locationId: loc.id, qty: input.qty, lot: { lotNo, expiry: input.expiry }, ref }, u.id)
    const restock = offsetRestock(input.drugId, txn, u.id)
    const tail = !restock ? '' : restock.outstanding ? `，補貨申請尚欠 ${restock.outstanding}` : '，補貨申請已到齊'
    audit('藥品進貨', `${find.drug(input.drugId)?.name} +${input.qty}（批號 ${lotNo}；${ref}${tail}）`)
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

const medsOf = (d: Dispense) => db.encounters.find((e) => e.id === d.encounterId)?.medications ?? []
/** 這張申請關聯、還沒發藥的調劑單（病人還在等） */
const waitingOf = (r: RestockRequest) =>
  r.dispenseIds.map((id) => db.dispenses.find((d) => d.id === id)).filter((d): d is Dispense => !!d && dispenseOpen(d))

export interface RestockWaiting {
  dispenseId: string
  pickupNo: number
  /** 開立日（領藥號每天重編，要日期才分得出是哪一天的「3 號」） */
  date: string
  patientName: string
  qty: number
}

export interface RestockView extends RestockRequest {
  /** 已列入哪張進行中的採購單（草稿、待核准、已訂購）；到貨請在採購單入庫 */
  purchase?: { id: string; no: string; status: string }
  /** 大型醫院：已列入哪張進行中的撥補單（請領中、運送中）；門診藥局簽收後沖銷 */
  transfer?: { id: string; no: string; status: string }
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
  const po = db.purchaseOrders.find((p) => ['draft', 'pending', 'ordered'].includes(p.status) && p.lines.some((l) => l.restockId === r.id))
  return {
    ...r,
    ...(po ? { purchase: { id: po.id, no: po.no, status: po.status } } : {}),
    ...(() => {
      const tr = db.transfers.find((x) => ['requested', 'issued'].includes(x.status) && x.lines.some((l) => l.restockId === r.id))
      return tr ? { transfer: { id: tr.id, no: tr.no, status: tr.status } } : {}
    })(),
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
    const waiting = db.dispenses.filter((x) => dispenseOpen(x) && medsOf(x).some((m) => m.drugId === d.id))
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
  /** 負責的工作（門診發藥、住院調劑、採購入庫） */
  roles: LocationRole[]
  /** 不能停用的原因（管理清單才給；空陣列＝可以停用） */
  blockers?: string[]
}

const drugCountAt = (locId: string) => new Set(db.drugLots.filter((x) => x.locationId === locId && x.qty > 0).map((x) => x.drugId)).size
const rolesOf = (l: StockLocation): LocationRole[] => LOCATION_ROLES.filter((r) => l[r.flag]).map((r) => r.key)

/**
 * 這個地點為什麼不能停用：還負責某項工作、還有庫存、還有進行中的單據（盤點、撥補、已訂購待到貨的採購單、
 * 待核對的住院調劑、病房還沒送回或已送回待點收的退藥——這些都會回到這個地點）。停用前、管理清單共用同一份
 */
function locationBlockers(l: StockLocation): string[] {
  const out: string[] = []
  const roles = LOCATION_ROLES.filter((r) => l[r.flag])
  if (roles.length) out.push(`負責${roles.map((r) => r.label).join('、')}，請先改由其他地點負責`)
  const n = drugCountAt(l.id)
  if (n) out.push(`還有 ${n} 種藥的庫存（請先撥出、退回藥庫或報廢）`)
  const st = db.stocktakes.filter((s) => s.locationId === l.id && (s.status === 'counting' || s.status === 'submitted')).map((s) => s.no)
  if (st.length) out.push(`盤點中：${st.join('、')}`)
  const tr = db.transfers.filter((t) => (t.status === 'requested' || t.status === 'issued') && (t.fromLocationId === l.id || t.toLocationId === l.id)).map((t) => t.no)
  if (tr.length) out.push(`撥補進行中：${tr.join('、')}`)
  const po = db.purchaseOrders.filter((p) => p.status === 'ordered' && p.locationId === l.id).map((p) => p.no)
  if (po.length) out.push(`採購待到貨：${po.join('、')}`)
  const ud = db.udDispenses.filter((d) => d.locationId === l.id && d.boxes.some((b) => b.status === 'prepared')).map((d) => d.no)
  if (ud.length) out.push(`住院調劑待核對：${ud.join('、')}`)
  const ret = db.udDispenses
    .filter((d) => d.locationId === l.id && d.lines.some((x) => { const p = pendingReturn(x); return p.sent.marIds.length + p.waiting.marIds.length > 0 }))
    .map((d) => d.no)
  if (ret.length) out.push(`住院退藥還沒點收：${ret.join('、')}`)
  return out
}

/**
 * 庫存地點與醫院規模：庫存頁的地點選單只用啟用中的（只有一個時頁面不顯示選單）；
 * 管理畫面帶 includeInactive，連同停用的、與不能停用的原因
 */
export function listStockLocations(q: { includeInactive?: boolean } = {}): Promise<{ scale: HospitalScale; locations: StockLocationView[]; opd: string; receiving: string }> {
  return query(() => ({
    scale: db.hospitalScale,
    locations: db.stockLocations
      .filter((l) => q.includeInactive || (l.active && l.kind !== 'quarantine'))
      .map((l) => ({ ...l, drugCount: drugCountAt(l.id), roles: rolesOf(l), ...(q.includeInactive ? { blockers: l.active ? locationBlockers(l) : [] } : {}) })),
    opd: stockLoc.opd(),
    receiving: stockLoc.receiving(),
  }))
}

export interface StockLocationInput {
  id?: string
  name: string
  /** 只有新增時能選；建立後不能改（藥庫與藥局的單據流程不同） */
  kind?: StockLocation['kind']
  active: boolean
}

/**
 * 新增、改名、停用（藥師、管理員）。改名只改主檔：單據存的是地點 id，畫面顯示時查目前的名稱
 * （和供應商不同——那是外部的對象，單據要留當時的名稱；地點是院內自己的單位，改名只是換叫法）。
 * 藥庫最多一個（撥補、退回藥庫都找「那個藥庫」）；停用前檢查 locationBlockers
 */
export function saveStockLocation(input: StockLocationInput): Promise<StockLocationView> {
  return mutate(() => {
    requirePermission('location.edit')
    const old = input.id ? must(db.stockLocations.find((l) => l.id === input.id), '庫存地點') : undefined
    const name = (input.name ?? '').trim()
    const v = fieldErrors()
    const np = locationNameProblem(name)
    if (np) v.add('name', np)
    else {
      const dup = db.stockLocations.find((l) => l.id !== old?.id && normalizeLocationName(l.name) === normalizeLocationName(name))
      if (dup) v.add('name', `已有「${dup.name}」${dup.active ? '' : '（已停用，請直接啟用它）'}`)
    }
    const kind = old?.kind ?? input.kind
    if (!old && kind !== 'warehouse' && kind !== 'pharmacy') v.add('kind', '請選擇藥庫或藥局')
    if (old && input.kind && input.kind !== old.kind) v.add('kind', '建立後不能改類別（藥庫與藥局的流程不同），請另外新增')
    const active = input.active !== false
    if (kind === 'warehouse' && active && (!old || !old.active)) {
      const wh = db.stockLocations.find((l) => l.id !== old?.id && l.kind === 'warehouse' && l.active)
      if (wh) v.add(old ? 'active' : 'kind', `已有藥庫「${wh.name}」：撥補、退回藥庫都找那一個，同時只能有一個藥庫`)
    }
    if (old?.active && !active) {
      const b = locationBlockers(old)
      if (b.length) v.add('active', `不能停用：${b.join('；')}`)
    }
    v.done()
    let l: StockLocation
    if (old) {
      const was = { name: old.name, active: old.active }
      l = Object.assign(old, { name, active })
      const changes = [was.name !== name && `${was.name} → ${name}`, was.active !== active && (active ? '啟用' : '停用')].filter(Boolean)
      audit('修改庫存地點', `${name}${changes.length ? '：' + changes.join('、') : ''}`)
    } else {
      l = { id: newId('LOC'), name, kind: kind!, receivesPurchase: false, dispensesOpd: false, dispensesIpd: false, active }
      db.stockLocations.push(l)
      audit('新增庫存地點', `${name}（${kind === 'warehouse' ? '藥庫' : '藥局'}）`)
    }
    return { ...l, drugCount: drugCountAt(l.id), roles: rolesOf(l), blockers: l.active ? locationBlockers(l) : [] }
  })
}

/**
 * 某項工作改由哪個地點負責（每項同一時間只有一個地點）。改了之後新的作業從新地點扣／入；
 * 已經開出去的單據（已訂購的採購單、已調劑的 UD、撥補單）照原本存的地點處理。
 * 影響大，先回 CONFLICT 說明「之後從哪裡扣」，頁面確認後帶 confirm 重送
 */
export function setLocationRole(input: { role: LocationRole; locationId: string; confirm?: boolean }): Promise<{ from: string; to: string }> {
  return mutate(() => {
    requirePermission('location.edit')
    const r = LOCATION_ROLES.find((x) => x.key === input.role)
    if (!r) fail('不明的工作項目')
    const loc = stockLoc.usable(input.locationId)
    if (loc[r!.flag]) fail(`「${loc.name}」已經負責${r!.label}`)
    if (r!.pharmacyOnly && loc.kind !== 'pharmacy') fail(`藥庫不直接發藥給病人，${r!.label}要由藥局負責`)
    const from = db.stockLocations.find((l) => l[r!.flag] && l.active)
    if (!input.confirm) fail(`之後${r!.label}改從「${loc.name}」${r!.verb}${from ? `（原本是「${from.name}」）` : ''}。已經開出的單據照原地點處理。`, 'CONFLICT', 'confirm')
    for (const l of db.stockLocations) l[r!.flag] = false
    loc[r!.flag] = true
    audit('修改庫存地點', `${r!.label}：${from?.name ?? '（無）'} → ${loc.name}`)
    return { from: from?.name ?? '', to: loc.name }
  })
}

/**
 * 設定某地點的安全庫存（大型醫院各地點各自設；沒設定的地點用藥品主檔的值）。
 * 低於它就標「偏低」、列入採購或請領的需求清單。
 */
export function setSafetyStock(drugId: string, locationId: string, qty: number): Promise<{ qty: number }> {
  return mutate(() => {
    requireUser('pharmacist')
    const d = must(find.drug(drugId), '藥品')
    const loc = stockLoc.usable(locationId)
    if (!Number.isInteger(qty) || qty < 0) failField('qty', '安全庫存需為 0 以上的整數')
    const before = stockLoc.safety(d, loc.id)
    const row = db.safetyStocks.find((x) => x.locationId === loc.id && x.drugId === d.id)
    if (row) row.qty = qty
    else db.safetyStocks.push({ locationId: loc.id, drugId: d.id, qty })
    audit('修改安全庫存', `${d.name} ${loc.name}：${before} → ${qty}`)
    return { qty }
  })
}

// ---------- 待報廢區（藥庫底下）：退回的過期、破損品放這裡，只能報廢或放回可用 ----------
export interface QuarantineRow {
  lotId: string
  locationId: string
  locationName: string
  drugId: string
  drugName: string
  unit: string
  lotNo: string
  expiry: string
  qty: number
  expired: boolean
  /** 最近一次放進來的單號與原因（退回藥庫的撥補單） */
  ref?: string
  reason?: string
  at?: string
}

export function listQuarantine(): Promise<QuarantineRow[]> {
  return query(() => {
    requireUser('pharmacist', 'admin')
    const t = today()
    const qs = db.stockLocations.filter((l) => l.kind === 'quarantine')
    const rows: QuarantineRow[] = []
    for (const q of qs)
      for (const lot of db.drugLots.filter((x) => x.locationId === q.id && x.qty > 0)) {
        const d = find.drug(lot.drugId)
        const last = db.stockTxns.filter((x) => x.locationId === q.id && x.drugId === lot.drugId && x.qty > 0 && x.lots.some((m) => m.lotNo === lot.lotNo)).at(-1)
        rows.push({
          lotId: lot.id, locationId: q.id, locationName: q.name, drugId: lot.drugId, drugName: d?.name ?? lot.drugId, unit: d?.unit ?? '',
          lotNo: lot.lotNo, expiry: lot.expiry, qty: lot.qty, expired: isExpired(lot.expiry, t),
          ...(last ? { ref: last.ref, reason: last.reason, at: last.at } : {}),
        })
      }
    return rows.sort((a, b) => a.drugName.localeCompare(b.drugName) || a.expiry.localeCompare(b.expiry))
  })
}

function quarantineLot(lotId: string) {
  const lot = must(db.drugLots.find((x) => x.id === lotId), '批號')
  const loc = must(db.stockLocations.find((l) => l.id === lot.locationId), '庫存地點')
  if (loc.kind !== 'quarantine') fail('這個批號不在待報廢區')
  if (lot.qty <= 0) fail('這個批號已經處理完了', 'CONFLICT')
  return { lot, loc }
}

/** 報廢待報廢區的一個批號（整批；寫原因） */
export function scrapQuarantine(lotId: string, reason: string): Promise<StockTxn> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const { lot, loc } = quarantineLot(lotId)
    const why = reason?.trim()
    if (!why) failField('reason', '請寫報廢原因（例：過期、破損）')
    const txn = postStock({ kind: 'out', type: 'adjust', drugId: lot.drugId, locationId: loc.id, qty: lot.qty, lotId: lot.id, reason: `報廢（待報廢區）：${why}` }, u.id)
    audit('待報廢區報廢', `${find.drug(lot.drugId)?.name} 批號 ${lot.lotNo} ${-txn.qty}：${why}`)
    return txn
  })
}

/** 放回可用：沒過期的（例：判斷錯了、包裝其實完好）移回所屬藥庫；寫原因 */
export function releaseQuarantine(lotId: string, reason: string): Promise<{ qty: number; to: string }> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const { lot, loc } = quarantineLot(lotId)
    if (isExpired(lot.expiry, today())) fail(`已過期（${lot.expiry}），不能放回可用，只能報廢`, 'CONFLICT')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫放回的原因（例：確認包裝完好）')
    const wh = stockLoc.usable(loc.parentId)
    const qty = lot.qty
    const t = now()
    postStock({ kind: 'out', type: 'adjust', drugId: lot.drugId, locationId: loc.id, qty, lotId: lot.id, reason: `待報廢區放回可用：${why}` }, u.id, t)
    postStock({ kind: 'in', type: 'adjust', drugId: lot.drugId, locationId: wh.id, qty, lot: { lotNo: lot.lotNo, expiry: lot.expiry }, reason: `待報廢區放回可用：${why}` }, u.id, t)
    audit('待報廢區放回可用', `${find.drug(lot.drugId)?.name} 批號 ${lot.lotNo} ${qty} → ${wh.name}：${why}`)
    return { qty, to: wh.name }
  })
}
