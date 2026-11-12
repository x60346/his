// 採購單：藥師開單（草稿）→ 送出 → 管理員核准／退回 → 已訂購 → 分批到貨（對品項入批號效期）→ 已到齊／短交結案。
//
// 幾個關鍵：
//   - 開單與核准分開（內控）：送出的人不能自己核准；管理員核准，藥師到貨入庫
//   - 補貨申請是「需求來源」：開單時列出待處理的申請與低於安全庫存的藥，勾選帶入；到貨照常沖銷申請
//   - 到貨一律對品項入，超過尚未到貨的數量擋下；全部到齊自動「已到齊」，短交要寫原因結案
//   - 入庫地點＝採購入庫的地點（小型＝藥局、大型＝藥庫），核准時記下
import type { PurchaseLine, PurchaseOrder, Supplier } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { find, nameOf, stockLoc } from './views'
import { checkReceiveInput, offsetRestock, openRestockOf, outstandingOf, postStock } from './stock-ledger'
import { stockStatus, suggestRestockQty, usableQty } from './stock-rules'
import { normalizeSupplierName, purchaseTotal, remainingOf, taxIdProblem } from './purchase-rules'

export interface PurchaseLineView extends PurchaseLine {
  drugName: string
  drugNameZh: string
  spec: string
  unit: string
  remaining: number
  amount: number
}

export interface PurchaseView extends Omit<PurchaseOrder, 'lines'> {
  lines: PurchaseLineView[]
  locationName: string
  createdByName: string
  approvedByName?: string
  closedByName?: string
  total: number
  /** 已到貨的品項數／品項數 */
  receivedLines: number
}

function view(po: PurchaseOrder): PurchaseView {
  return {
    ...po,
    lines: po.lines.map((l) => {
      const d = find.drug(l.drugId)
      return { ...l, drugName: d?.name ?? l.drugId, drugNameZh: d?.nameZh ?? '', spec: d?.spec ?? '', unit: d?.unit ?? '', remaining: remainingOf(l), amount: Math.round(l.qty * l.unitCost * 10) / 10 }
    }),
    locationName: nameOf.location(po.locationId),
    createdByName: nameOf.user(po.createdBy),
    ...(po.approvedBy ? { approvedByName: nameOf.user(po.approvedBy) } : {}),
    ...(po.closedBy ? { closedByName: nameOf.user(po.closedBy) } : {}),
    total: purchaseTotal(po.lines),
    receivedLines: po.lines.filter((l) => remainingOf(l) === 0).length,
  }
}

const poOf = (id: string) => must(db.purchaseOrders.find((x) => x.id === id), '採購單')
const ACTIVE: PurchaseOrder['status'][] = ['draft', 'pending', 'ordered']
/** 這張補貨申請已經在哪張進行中的採購單上（一張申請只列入一張單） */
const poOfRestock = (restockId: string, exceptId?: string) =>
  db.purchaseOrders.find((p) => p.id !== exceptId && ACTIVE.includes(p.status) && p.lines.some((l) => l.restockId === restockId))

/** 採購單清單：進行中的在前（待核准 → 已訂購 → 草稿），其餘依建立時間新到舊 */
export function listPurchaseOrders(q: { status?: PurchaseOrder['status'][] } = {}): Promise<PurchaseView[]> {
  return query(() => {
    requireUser('pharmacist', 'admin')
    const rank = (s: PurchaseOrder['status']) => ['pending', 'ordered', 'draft'].indexOf(s) + 1 || 9
    return db.purchaseOrders
      .filter((p) => !q.status || q.status.includes(p.status))
      .sort((a, b) => rank(a.status) - rank(b.status) || b.createdAt.localeCompare(a.createdAt))
      .map(view)
  })
}

export const getPurchaseOrder = (id: string): Promise<PurchaseView> => query(() => (requireUser('pharmacist', 'admin'), view(poOf(id))))

export interface PurchaseCandidate {
  drugId: string
  drugName: string
  unit: string
  /** 採購入庫地點的可用量與安全庫存 */
  usable: number
  safetyStock: number
  /** 建議數量（和補貨申請同一個公式；已訂購未到的量已扣掉） */
  suggestedQty: number
  /** 已在待核准、已訂購的採購單上、還沒到的量（建議量是 0 時，原因多半是這個） */
  onOrder: number
  /** 待處理的補貨申請（沒列入其他採購單的）；有病人在等的排前面 */
  restock?: { id: string; outstanding: number; waiting: number }
  /** 上次採購的供應商與進價（帶入用） */
  last?: { supplierId: string; supplier: string; unitCost: number; date: string }
  reason: 'restock' | 'low'
}

/**
 * 開單時的「需求清單」：待處理的補貨申請（還沒列入任何進行中的採購單）＋採購入庫地點低於安全庫存的藥。
 * 建議量和補貨申請同一個公式（suggestRestockQty）；已在別張採購單上、還沒到的量算「已訂購」扣掉。
 */
export function purchaseCandidates(): Promise<PurchaseCandidate[]> {
  return query(() => {
    requireUser('pharmacist')
    const loc = stockLoc.receiving()
    const t = today()
    const onOrder = (drugId: string) =>
      db.purchaseOrders.filter((p) => ['pending', 'ordered'].includes(p.status)).flatMap((p) => p.lines).filter((l) => l.drugId === drugId).reduce((n, l) => n + remainingOf(l), 0)
    const lastOf = (drugId: string) => {
      const p = db.purchaseOrders.filter((x) => x.status !== 'draft' && x.status !== 'cancelled' && x.lines.some((l) => l.drugId === drugId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      const l = p?.lines.find((x) => x.drugId === drugId)
      return p && l ? { supplierId: p.supplierId, supplier: p.supplier, unitCost: l.unitCost, date: p.createdAt.slice(0, 10) } : undefined
    }
    const out: PurchaseCandidate[] = []
    for (const d of db.drugs.filter((x) => x.active)) {
      // 盤點中（盲盤）的藥不列出建議量：建議量是用可用量算的
      if (stockLoc.counting(d.id, loc)) continue
      const usable = usableQty(stockLoc.lots(d.id, loc), t)
      const safety = stockLoc.safety(d, loc)
      // 補貨申請是門診藥局的需求：只有「採購到貨就進門診藥局」的小型醫院才拿來開採購單；大型醫院走撥補（藥庫撥給藥局）
      const req = loc === stockLoc.opd() ? openRestockOf(d.id) : undefined
      const freeReq = req && !poOfRestock(req.id) ? req : undefined
      const low = stockStatus(usable, safety) !== 'ok'
      if (!freeReq && !low) continue
      // 近 30 天這個地點的用量（發藥＋撥出，和庫存頁同一個定義）
      const since = addDays(t, -30)
      const used30 = -db.stockTxns.filter((x) => x.drugId === d.id && x.locationId === loc && (x.type === 'dispense' || x.type === 'transfer-out') && x.at >= since).reduce((n, x) => n + x.qty, 0)
      const waiting = freeReq ? freeReq.dispenseIds.map((id) => db.dispenses.find((x) => x.id === id)).filter((x) => x && x.status !== 'dispensed').length : 0
      const sug = suggestRestockQty({ usable, need: 0, safetyStock: safety, used30, onOrder: onOrder(d.id) })
      out.push({
        drugId: d.id, drugName: d.name, unit: d.unit, usable, safetyStock: safety,
        suggestedQty: Math.max(sug.qty, freeReq ? outstandingOf(freeReq) : 0),
        onOrder: onOrder(d.id),
        ...(freeReq ? { restock: { id: freeReq.id, outstanding: outstandingOf(freeReq), waiting } } : {}),
        ...(lastOf(d.id) ? { last: lastOf(d.id)! } : {}),
        reason: freeReq ? 'restock' : 'low',
      })
    }
    return out.sort((a, b) => (b.restock?.waiting ?? 0) - (a.restock?.waiting ?? 0) || Number(!!b.restock) - Number(!!a.restock) || a.drugName.localeCompare(b.drugName))
  })
}

// ---------- 供應商主檔 ----------
// 藥師（開採購單的人）與管理員都能維護。只能停用、不能刪除；還有進行中的採購單不能停用。

export interface SupplierView extends Supplier {
  /** 採購單張數（不含草稿、取消）與最近一次開單日 */
  orderCount: number
  lastOrderAt?: string
  /** 進行中（草稿、待核准、已訂購）的採購單號：停用前要先處理 */
  openOrders: string[]
}

/** 算進「以前的進價」的採購單：核准訂購過的（草稿、待核准只是打算——可能被退回；取消的沒買成） */
const countedPo = (p: PurchaseOrder) => ['ordered', 'received', 'closed'].includes(p.status)

export function listSuppliers(q: { includeInactive?: boolean } = {}): Promise<SupplierView[]> {
  return query(() => {
    requireUser('pharmacist', 'admin')
    return db.suppliers
      .filter((x) => q.includeInactive || x.active)
      .map((x) => {
        const pos = db.purchaseOrders.filter((p) => p.supplierId === x.id)
        const counted = pos.filter(countedPo).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        return { ...x, orderCount: counted.length, ...(counted[0] ? { lastOrderAt: counted[0].createdAt.slice(0, 10) } : {}), openOrders: pos.filter((p) => ACTIVE.includes(p.status)).map((p) => p.no) }
      })
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'zh-Hant'))
  })
}

export type SupplierInput = Pick<Supplier, 'name' | 'taxId' | 'contact' | 'phone' | 'note' | 'active'> & { id?: string }

export function saveSupplier(input: SupplierInput): Promise<Supplier> {
  return mutate(() => {
    requireUser('pharmacist', 'admin')
    const old = input.id ? db.suppliers.find((x) => x.id === input.id) : undefined
    if (input.id && !old) fail('找不到供應商', 'NOT_FOUND')
    const name = (input.name ?? '').trim().replace(/\s+/g, ' ')
    const taxId = (input.taxId ?? '').trim()
    const errors: Record<string, string> = {}
    if (!name) errors.name = '請輸入供應商名稱'
    else {
      // 同名（含停用的）：多半是同一家，停用的請直接啟用——兩筆同一家，進價紀錄就分散了
      const same = db.suppliers.find((x) => x.id !== old?.id && normalizeSupplierName(x.name) === normalizeSupplierName(name))
      if (same) errors.name = `已有同名供應商${same.active ? '' : '（停用中，請直接啟用那一筆）'}`
    }
    const tp = taxIdProblem(taxId)
    if (tp) errors.taxId = tp
    else if (taxId) {
      const same = db.suppliers.find((x) => x.id !== old?.id && x.taxId === taxId)
      if (same) errors.taxId = `統一編號和「${same.name}」相同`
    }
    failFields(errors)
    if (old?.active && !input.active) {
      const open = db.purchaseOrders.filter((p) => p.supplierId === old.id && ACTIVE.includes(p.status))
      if (open.length) failField('active', `還有 ${open.length} 張進行中的採購單（${open.map((p) => p.no).join('、')}），請先到貨結案或取消再停用`, 'CONFLICT')
    }
    const t = now()
    const saved: Supplier = {
      id: old?.id ?? `S${String(db.suppliers.length + 1).padStart(3, '0')}`,
      name, ...(taxId ? { taxId } : {}),
      ...(input.contact?.trim() ? { contact: input.contact.trim() } : {}),
      ...(input.phone?.trim() ? { phone: input.phone.trim() } : {}),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      active: !!input.active, createdAt: old?.createdAt ?? t, ...(old ? { updatedAt: t } : {}),
    }
    if (old) db.suppliers[db.suppliers.indexOf(old)] = saved
    else db.suppliers.push(saved)
    audit(old ? '修改供應商' : '新增供應商', `${saved.id} ${name}${input.id && !input.active ? '（停用）' : ''}`)
    return saved
  })
}

export interface SupplierPrice {
  drugId: string
  drugName: string
  unit: string
  /** 這家最近一次的進價、日期、單號；買過幾次 */
  unitCost: number
  date: string
  poNo: string
  times: number
  /** 其他供應商最近一次的進價（比價用） */
  other?: { supplier: string; unitCost: number; date: string }
}

/** 這家供應商以前的進價：每種藥最近一次（送出過的採購單），附其他供應商最近的價格比較 */
export function supplierPrices(supplierId: string): Promise<SupplierPrice[]> {
  return query(() => {
    requireUser('pharmacist', 'admin')
    must(db.suppliers.find((x) => x.id === supplierId), '供應商')
    const pos = db.purchaseOrders.filter(countedPo).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const out = new Map<string, SupplierPrice>()
    for (const p of pos.filter((x) => x.supplierId === supplierId)) {
      for (const l of p.lines) {
        const cur = out.get(l.drugId)
        if (cur) {
          cur.times++
          continue
        }
        const d = find.drug(l.drugId)
        const otherPo = pos.find((x) => x.supplierId !== supplierId && x.lines.some((y) => y.drugId === l.drugId))
        const ol = otherPo?.lines.find((y) => y.drugId === l.drugId)
        out.set(l.drugId, {
          drugId: l.drugId, drugName: d?.name ?? l.drugId, unit: d?.unit ?? '', unitCost: l.unitCost, date: p.createdAt.slice(0, 10), poNo: p.no, times: 1,
          ...(otherPo && ol ? { other: { supplier: otherPo.supplier, unitCost: ol.unitCost, date: otherPo.createdAt.slice(0, 10) } } : {}),
        })
      }
    }
    return [...out.values()].sort((a, b) => b.date.localeCompare(a.date) || a.drugName.localeCompare(b.drugName))
  })
}

export interface PurchaseInput {
  id?: string
  supplierId: string
  expectedDate?: string
  note?: string
  lines: { drugId: string; qty: number; unitCost: number; restockId?: string }[]
}

/** 新增或修改草稿（只有草稿能改；被退回的單會回到草稿） */
export function savePurchaseDraft(input: PurchaseInput): Promise<PurchaseView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const old = input.id ? poOf(input.id) : undefined
    if (old && old.status !== 'draft') fail('只有草稿可以修改（已送出的單請管理員退回後再改）', 'CONFLICT')
    const errors: Record<string, string> = {}
    // 供應商：只能選主檔裡啟用中的（以前是文字欄位，同一家打成兩種寫法就分成兩家）
    const sup = db.suppliers.find((x) => x.id === input.supplierId)
    if (!input.supplierId) errors.supplierId = '請選擇供應商'
    else if (!sup) errors.supplierId = '找不到這家供應商'
    else if (!sup.active) errors.supplierId = `${sup.name} 已停用，請改選其他供應商`
    if (input.expectedDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.expectedDate)) errors.expectedDate = '日期格式不正確'
    else if (input.expectedDate && input.expectedDate < today()) errors.expectedDate = '預計到貨日不能早於今天'
    if (!input.lines?.length) errors.lines = '請至少加一個品項'
    const seen = new Set<string>()
    input.lines?.forEach((l, i) => {
      const d = find.drug(l.drugId)
      if (!d) errors[`line-${i}`] = '請選擇藥品'
      else if (!d.active) errors[`line-${i}`] = `${d.name} 已停用，不能採購`
      else if (seen.has(d.id)) errors[`line-${i}`] = `${d.name} 重複了，請合併成一行`
      else if (!Number.isInteger(l.qty) || l.qty <= 0) errors[`line-${i}`] = '數量需為正整數'
      else if (!(typeof l.unitCost === 'number' && l.unitCost >= 0 && Number.isFinite(l.unitCost))) errors[`line-${i}`] = '進價需為 0 以上的數字'
      else if (l.restockId) {
        const r = db.restockRequests.find((x) => x.id === l.restockId)
        if (!r || r.status !== 'open' || r.drugId !== d.id) errors[`line-${i}`] = '關聯的補貨申請已結案或不是這種藥'
        else if (poOfRestock(r.id, old?.id)) errors[`line-${i}`] = `這張補貨申請已列入 ${poOfRestock(r.id, old?.id)!.no}`
      }
      if (d) seen.add(d.id)
    })
    failFields(errors)
    const lines: PurchaseLine[] = input.lines.map((l, i) => ({
      id: `L${i + 1}`, drugId: l.drugId, qty: l.qty, unitCost: Math.round(l.unitCost * 100) / 100, ...(l.restockId ? { restockId: l.restockId } : {}), receivedQty: 0, txnIds: [],
    }))
    // 名稱存當時的（單據是文件）；供應商之後改名，舊單仍是開單時的名稱
    const supplier = sup!.name
    const content = { supplierId: sup!.id, supplier, expectedDate: input.expectedDate || undefined, note: input.note?.trim() || undefined, lines }
    if (old) {
      Object.assign(old, content)
      audit('修改採購單', `${old.no}（${lines.length} 項）`)
      return view(old)
    }
    const no = `PO${today().replace(/-/g, '')}-${String(nextCounter(`purchase:${today()}`)).padStart(2, '0')}`
    const po: PurchaseOrder = { id: newId('PO'), no, ...content, status: 'draft', locationId: stockLoc.receiving(), createdBy: u.id, createdAt: now() }
    db.purchaseOrders.push(po)
    audit('新增採購單', `${no} ${supplier}（${lines.length} 項）`)
    return view(po)
  })
}

/** 送出待核准 */
export function submitPurchase(id: string): Promise<PurchaseView> {
  return mutate(() => {
    requireUser('pharmacist')
    const po = poOf(id)
    if (po.status !== 'draft') fail('只有草稿可以送出', 'CONFLICT')
    Object.assign(po, { status: 'pending', submittedAt: now() })
    audit('送出採購單', `${po.no} ${po.supplier}（${purchaseTotal(po.lines).toLocaleString()} 元）`)
    return view(po)
  })
}

/** 管理員核准：正式向藥商訂購；入庫地點以此刻的「採購入庫地點」為準 */
export function approvePurchase(id: string): Promise<PurchaseView> {
  return mutate(() => {
    const u = requireUser('admin')
    const po = poOf(id)
    if (po.status !== 'pending') fail('只有待核准的採購單可以核准', 'CONFLICT')
    if (po.createdBy === u.id) fail('開單的人不能自己核准', 'FORBIDDEN')
    Object.assign(po, { status: 'ordered', approvedBy: u.id, approvedAt: now(), locationId: stockLoc.receiving() })
    audit('核准採購單', `${po.no} ${po.supplier}（${purchaseTotal(po.lines).toLocaleString()} 元）`)
    return view(po)
  })
}

/** 管理員退回：回到草稿讓藥師修改，記下原因 */
export function rejectPurchase(id: string, reason: string): Promise<PurchaseView> {
  return mutate(() => {
    const u = requireUser('admin')
    const po = poOf(id)
    if (po.status !== 'pending') fail('只有待核准的採購單可以退回', 'CONFLICT')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫退回原因（例：數量太多、換供應商）')
    po.rejections = [...(po.rejections ?? []), { by: u.id, at: now(), reason: why! }]
    po.status = 'draft'
    delete po.submittedAt
    audit('退回採購單', `${po.no}（${why}）`)
    return view(po)
  })
}

/**
 * 到貨入庫：對某一行入一批（批號、效期照實物填），可分批；超過尚未到貨的數量擋下。
 * 入「採購入庫地點」，異動單號＝採購單號；照常沖銷這種藥待到貨的補貨申請。全部到齊自動「已到齊」。
 */
export function receivePurchase(id: string, lineId: string, input: { qty: number; lotNo: string; expiry: string }): Promise<PurchaseView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const po = poOf(id)
    if (po.status !== 'ordered') fail(po.status === 'pending' ? '採購單還沒核准，不能到貨入庫' : '這張採購單不在「已訂購」狀態', 'CONFLICT')
    const line = must(po.lines.find((l) => l.id === lineId), '採購品項')
    const lotNo = checkReceiveInput(input, { maxQty: remainingOf(line) })
    const txn = postStock({ kind: 'in', type: 'receive', drugId: line.drugId, locationId: po.locationId, qty: input.qty, lot: { lotNo, expiry: input.expiry }, ref: po.no }, u.id)
    line.receivedQty += input.qty
    line.txnIds.push(txn.id)
    const restock = offsetRestock(line.drugId, txn, u.id)
    const allIn = po.lines.every((l) => remainingOf(l) === 0)
    if (allIn) Object.assign(po, { status: 'received', closedBy: u.id, closedAt: now() })
    const tail = (restock ? (restock.outstanding ? `，補貨申請尚欠 ${restock.outstanding}` : '，補貨申請已到齊') : '') + (allIn ? '，採購單已到齊' : '')
    audit('採購到貨', `${po.no} ${find.drug(line.drugId)?.name} +${input.qty}（批號 ${lotNo}${tail}）`)
    return view(po)
  })
}

/** 短交結案：已到一部分、剩下的不會來了（寫原因）。一件都沒到的請用取消 */
export function closePurchase(id: string, reason: string): Promise<PurchaseView> {
  return mutate(() => {
    const u = requireUser('pharmacist', 'admin')
    const po = poOf(id)
    if (po.status !== 'ordered') fail('只有已訂購的採購單可以結案', 'CONFLICT')
    if (!po.lines.some((l) => l.receivedQty > 0)) fail('還沒有任何到貨，請用「取消」', 'CONFLICT')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫結案原因（例：廠商缺貨，剩餘不再出貨）')
    Object.assign(po, { status: 'closed', closedBy: u.id, closedAt: now(), closeReason: why })
    audit('採購單短交結案', `${po.no}（${why}）`)
    return view(po)
  })
}

/** 取消：還沒有任何到貨時（草稿、待核准、已訂購）；已到一部分的請用短交結案 */
export function cancelPurchase(id: string, reason: string): Promise<PurchaseView> {
  return mutate(() => {
    const u = requireUser('pharmacist', 'admin')
    const po = poOf(id)
    if (!ACTIVE.includes(po.status)) fail('這張採購單已結束，不能取消', 'CONFLICT')
    if (po.lines.some((l) => l.receivedQty > 0)) fail('已經有到貨，請用「短交結案」', 'CONFLICT')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫取消原因')
    Object.assign(po, { status: 'cancelled', closedBy: u.id, closedAt: now(), closeReason: why })
    audit('取消採購單', `${po.no}（${why}）`)
    return view(po)
  })
}
