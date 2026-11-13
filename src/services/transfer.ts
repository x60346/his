// 撥補單（大型醫院）：藥局請領 → 藥庫撥發（依 FEFO，運送中）→ 藥局逐批簽收才入帳（短少要寫原因）。
//
// 幾個關鍵：
//   - 撥發時藥庫就扣（transfer-out），簽收時藥局才入（transfer-in）；中間是「運送中」，不屬於任何地點
//   - 批號、效期跟著藥走：藥局入的是藥庫撥出的那幾批（日後回收、報廢追得到）
//   - 藥庫不夠可以少撥（0＝這次沒撥）；簽收可以少收（短少寫原因），不能多收
//   - 門診藥局的補貨申請（窗口缺藥）在大型醫院由撥補滿足：請領時帶入，簽收進門診藥局才沖銷
//   - 小型醫院只有一個藥局，沒有撥補（服務層擋下）
//   - 反方向「退回藥庫」：藥局逐批選要退的（近效期、請領過多…），送出就扣（運送中），藥庫照一般簽收入帳；過期的也能退（送藥庫集中報廢）
import type { TransferLine, TransferOrder } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { find, nameOf, stockLoc } from './views'
import { offsetRestock, openRestockOf, outstandingOf, postStock, quarantineOf } from './stock-ledger'
import type { ReturnDisposition } from '@/types'
import { isExpiringSoon, stockStatus, suggestRestockQty, usableQty } from './stock-rules'

export interface TransferLineView extends TransferLine {
  drugName: string
  drugNameZh: string
  spec: string
  unit: string
  /** 藥庫目前可撥的量（請領中才給；藥庫正在盤點時不給——盲盤） */
  available?: number
  /** 簽收短少的量（已簽收才有） */
  shortQty?: number
}

export interface TransferView extends Omit<TransferOrder, 'lines'> {
  lines: TransferLineView[]
  fromName: string
  toName: string
  requestedByName: string
  issuedByName?: string
  receivedByName?: string
  cancelledByName?: string
}

const ACTIVE: TransferOrder['status'][] = ['requested', 'issued']

function view(tr: TransferOrder): TransferView {
  const t = today()
  return {
    ...tr,
    lines: tr.lines.map((l) => {
      const d = find.drug(l.drugId)
      const counting = stockLoc.counting(l.drugId, tr.fromLocationId)
      const short = tr.status === 'received' ? (l.lots ?? []).reduce((n, x) => n + (x.qty - (x.receivedQty ?? x.qty)), 0) : undefined
      return {
        ...l,
        drugName: d?.name ?? l.drugId,
        drugNameZh: d?.nameZh ?? '',
        spec: d?.spec ?? '',
        unit: d?.unit ?? '',
        ...(tr.status === 'requested' && !counting ? { available: usableQty(stockLoc.lots(l.drugId, tr.fromLocationId), t) } : {}),
        ...(short ? { shortQty: short } : {}),
      }
    }),
    fromName: nameOf.location(tr.fromLocationId),
    toName: nameOf.location(tr.toLocationId),
    requestedByName: nameOf.user(tr.requestedBy),
    ...(tr.issuedBy ? { issuedByName: nameOf.user(tr.issuedBy) } : {}),
    ...(tr.receivedBy ? { receivedByName: nameOf.user(tr.receivedBy) } : {}),
    ...(tr.cancelledBy ? { cancelledByName: nameOf.user(tr.cancelledBy) } : {}),
  }
}

const trOf = (id: string) => must(db.transfers.find((x) => x.id === id), '撥補單')
/** 撥補只在有藥庫（大型醫院）時存在 */
function warehouse() {
  const wh = db.stockLocations.find((l) => l.kind === 'warehouse' && l.active)
  if (!wh) fail('沒有啟用中的藥庫，不能撥補（只有藥局的醫院，採購直接進藥局）', 'CONFLICT')
  return wh!
}
/** 這張補貨申請已在哪張進行中的撥補單上 */
const trOfRestock = (restockId: string, exceptId?: string) =>
  db.transfers.find((x) => x.id !== exceptId && ACTIVE.includes(x.status) && x.lines.some((l) => l.restockId === restockId))

/** 撥補單清單：可依地點（請領方或撥出方是它）；進行中的在前 */
export function listTransfers(q: { locationId?: string } = {}): Promise<TransferView[]> {
  return query(() => {
    requireUser('pharmacist', 'admin')
    const rank = (s: TransferOrder['status']) => ['issued', 'requested'].indexOf(s) + 1 || 9
    return db.transfers
      .filter((x) => !q.locationId || x.fromLocationId === q.locationId || x.toLocationId === q.locationId)
      .sort((a, b) => rank(a.status) - rank(b.status) || b.requestedAt.localeCompare(a.requestedAt))
      .map(view)
  })
}

export const getTransfer = (id: string): Promise<TransferView> => query(() => (requireUser('pharmacist', 'admin'), view(trOf(id))))

export interface TransferCandidate {
  drugId: string
  drugName: string
  unit: string
  usable: number
  safetyStock: number
  /** 建議請領量（和補貨申請同一個公式；已請領、運送中的扣掉） */
  suggestedQty: number
  /** 已在請領中、運送中、還沒簽收的量 */
  onTheWay: number
  /** 門診藥局：待處理的補貨申請（病人在等） */
  restock?: { id: string; outstanding: number; waiting: number }
  reason: 'restock' | 'low'
}

/** 某藥局的請領需求：低於該藥局安全庫存的藥＋（門診藥局）待處理的補貨申請 */
export function transferCandidates(toLocationId: string): Promise<TransferCandidate[]> {
  return query(() => {
    requireUser('pharmacist')
    warehouse()
    const to = stockLoc.usable(toLocationId)
    if (to.kind !== 'pharmacy') fail('請領要從藥局發起（藥庫是撥出的一方）')
    const t = today()
    const since = addDays(t, -30)
    const onTheWay = (drugId: string) =>
      db.transfers.filter((x) => ACTIVE.includes(x.status) && x.toLocationId === to.id).flatMap((x) => x.lines).filter((l) => l.drugId === drugId)
        .reduce((n, l) => n + (l.issuedQty ?? l.qty), 0)
    const out: TransferCandidate[] = []
    for (const d of db.drugs.filter((x) => x.active)) {
      if (stockLoc.counting(d.id, to.id)) continue // 盲盤中不給建議量（建議量是用可用量算的）
      const usable = usableQty(stockLoc.lots(d.id, to.id), t)
      const safety = stockLoc.safety(d, to.id)
      const req = to.id === stockLoc.opd() ? openRestockOf(d.id) : undefined
      const freeReq = req && !trOfRestock(req.id) ? req : undefined
      if (!freeReq && stockStatus(usable, safety) === 'ok') continue
      const used30 = -db.stockTxns.filter((x) => x.drugId === d.id && x.locationId === to.id && x.type === 'dispense' && x.at >= since).reduce((n, x) => n + x.qty, 0)
      const way = onTheWay(d.id)
      const sug = suggestRestockQty({ usable, need: 0, safetyStock: safety, used30, onOrder: way })
      const waiting = freeReq ? freeReq.dispenseIds.map((id) => db.dispenses.find((x) => x.id === id)).filter((x) => x && x.status !== 'dispensed').length : 0
      out.push({
        drugId: d.id, drugName: d.name, unit: d.unit, usable, safetyStock: safety, onTheWay: way,
        suggestedQty: Math.max(sug.qty, freeReq ? outstandingOf(freeReq) : 0),
        ...(freeReq ? { restock: { id: freeReq.id, outstanding: outstandingOf(freeReq), waiting } } : {}),
        reason: freeReq ? 'restock' : 'low',
      })
    }
    return out.sort((a, b) => (b.restock?.waiting ?? 0) - (a.restock?.waiting ?? 0) || Number(!!b.restock) - Number(!!a.restock) || a.drugName.localeCompare(b.drugName))
  })
}

/** 藥局請領：向藥庫要藥（請領中） */
export function requestTransfer(input: { toLocationId: string; note?: string; lines: { drugId: string; qty: number; restockId?: string }[] }): Promise<TransferView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const wh = warehouse()
    const to = stockLoc.usable(input.toLocationId)
    if (to.kind !== 'pharmacy') failField('toLocationId', '請領要從藥局發起（藥庫是撥出的一方）')
    const errors: Record<string, string> = {}
    if (!input.lines?.length) errors.lines = '請至少加一個品項'
    const seen = new Set<string>()
    input.lines?.forEach((l, i) => {
      const d = find.drug(l.drugId)
      if (!d) errors[`line-${i}`] = '請選擇藥品'
      else if (!d.active) errors[`line-${i}`] = `${d.name} 已停用`
      else if (seen.has(d.id)) errors[`line-${i}`] = `${d.name} 重複了，請合併成一行`
      else if (!Number.isInteger(l.qty) || l.qty <= 0) errors[`line-${i}`] = '數量需為正整數'
      else if (l.restockId) {
        const r = db.restockRequests.find((x) => x.id === l.restockId)
        if (!r || r.status !== 'open' || r.drugId !== d.id || to.id !== stockLoc.opd()) errors[`line-${i}`] = '關聯的補貨申請已結案、不是這種藥，或不是門診藥局的'
        else if (trOfRestock(r.id)) errors[`line-${i}`] = `這張補貨申請已在 ${trOfRestock(r.id)!.no} 請領中`
      }
      if (d) seen.add(d.id)
    })
    failFields(errors)
    const no = `TR${today().replace(/-/g, '')}-${String(nextCounter(`transfer:${today()}`)).padStart(2, '0')}`
    const tr: TransferOrder = {
      id: newId('TR'), no, fromLocationId: wh.id, toLocationId: to.id, status: 'requested',
      lines: input.lines.map((l, i) => ({ id: `L${i + 1}`, drugId: l.drugId, qty: l.qty, ...(l.restockId ? { restockId: l.restockId } : {}) })),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      requestedBy: u.id, requestedAt: now(),
    }
    db.transfers.push(tr)
    audit('請領', `${no} ${to.name} 向 ${wh.name}（${tr.lines.length} 項）`)
    return view(tr)
  })
}

/**
 * 藥庫撥發：每一行給實撥數量（≤ 請領量；藥庫不夠可以少撥，0＝這次不撥），依 FEFO 從藥庫扣（transfer-out），
 * 記下撥了哪幾批；藥品進入「運送中」，等藥局簽收才入帳。
 */
export function issueTransfer(id: string, issued: Record<string, number>): Promise<TransferView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const tr = trOf(id)
    if (tr.status !== 'requested') fail('只有請領中的撥補單可以撥發', 'CONFLICT')
    const t = today()
    const errors: Record<string, string> = {}
    for (const l of tr.lines) {
      const q = issued[l.id]
      const avail = usableQty(stockLoc.lots(l.drugId, tr.fromLocationId), t)
      if (!Number.isInteger(q) || q < 0) errors[`issue-${l.id}`] = '撥發數量需為 0 以上的整數'
      else if (q > l.qty) errors[`issue-${l.id}`] = `不能多於請領量 ${l.qty}`
      else if (q > avail) errors[`issue-${l.id}`] = stockLoc.counting(l.drugId, tr.fromLocationId) ? '藥庫可用量不足（盤點中，請少撥或等盤點完成）' : `藥庫可用只有 ${avail}`
    }
    failFields(errors)
    if (tr.lines.every((l) => issued[l.id] === 0)) fail('每一項都是 0：沒有要撥的，請用「取消」並寫原因', 'CONFLICT')
    for (const l of tr.lines) {
      const q = issued[l.id]
      l.issuedQty = q
      if (!q) continue
      const txn = postStock({ kind: 'out', type: 'transfer-out', drugId: l.drugId, locationId: tr.fromLocationId, qty: q, ref: tr.no }, u.id)
      l.lots = txn.lots.map((x) => ({ lotNo: x.lotNo, expiry: stockLoc.lots(l.drugId, tr.fromLocationId).find((lot) => lot.lotNo === x.lotNo)!.expiry, qty: -x.qty }))
    }
    Object.assign(tr, { status: 'issued', issuedBy: u.id, issuedAt: now() })
    const short = tr.lines.filter((l) => (l.issuedQty ?? 0) < l.qty).length
    audit('撥發', `${tr.no} ${nameOf.location(tr.fromLocationId)} → ${nameOf.location(tr.toLocationId)}（${tr.lines.length} 項${short ? `，${short} 項少撥` : ''}）`)
    return view(tr)
  })
}

/**
 * 藥局簽收：逐批填實收（≤ 撥發量），實收入藥局（transfer-in，批號效期照撥出的）；
 * 短少要寫原因（破損、遺失…）。門診藥局簽收時沖銷補貨申請。
 */
export interface ReceiveTransferInput {
  /** 每一行、每個批號的實收 */
  received: Record<string, number[]>
  shortReasons?: Record<string, string>
  /** 退回藥庫才有：每一行、每個批號怎麼處理（沒給＝入庫；過期的不能入庫） */
  dispositions?: Record<string, ReturnDisposition[]>
  /** 退回藥庫：有拒收的那一行要寫原因 */
  rejectReasons?: Record<string, string>
}

/**
 * 簽收。一般撥補：逐批實收入藥局。退回藥庫：藥庫逐批決定——入可用庫存、放待報廢區（過期的只能放這裡或拒收）、
 * 或拒收（寫原因，退回原藥局的同一個批號，帳回到藥局）。短少照舊寫原因
 */
export function receiveTransfer(id: string, input: ReceiveTransferInput): Promise<TransferView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const tr = trOf(id)
    if (tr.status !== 'issued') fail('只有運送中的撥補單可以簽收', 'CONFLICT')
    const isReturn = tr.kind === 'return'
    if (!isReturn && Object.values(input.dispositions ?? {}).some((ds) => ds.some((d) => d !== 'stock'))) fail('只有退回藥庫可以放待報廢區或拒收')
    const t = today()
    const dispOf = (lineId: string, k: number): ReturnDisposition => input.dispositions?.[lineId]?.[k] ?? 'stock'
    const errors: Record<string, string> = {}
    for (const l of tr.lines.filter((x) => x.lots?.length)) {
      const got = input.received?.[l.id] ?? []
      l.lots!.forEach((lot, k) => {
        const q = got[k]
        if (!Number.isInteger(q) || q < 0) errors[`recv-${l.id}-${k}`] = '實收需為 0 以上的整數'
        else if (q > lot.qty) errors[`recv-${l.id}-${k}`] = `不能多於撥發的 ${lot.qty}`
        const d = dispOf(l.id, k)
        if (!['stock', 'quarantine', 'rejected'].includes(d)) errors[`disp-${l.id}-${k}`] = '處理方式不正確'
        else if (isReturn && d === 'stock' && lot.expiry < t) errors[`disp-${l.id}-${k}`] = `已過期（${lot.expiry}），不能入可用庫存：請放待報廢區或拒收`
      })
      const short = l.lots!.reduce((n, lot, k) => n + (lot.qty - (got[k] ?? lot.qty)), 0)
      if (short > 0 && !input.shortReasons?.[l.id]?.trim()) errors[`short-${l.id}`] = `短少 ${short}，請寫原因（破損、遺失…）`
      if (isReturn && l.lots!.some((_, k) => dispOf(l.id, k) === 'rejected') && !input.rejectReasons?.[l.id]?.trim()) errors[`reject-${l.id}`] = '拒收請寫原因（例：未事先聯絡、包裝已拆無法再用）'
    }
    failFields(errors)
    const wh = db.stockLocations.find((x) => x.id === tr.toLocationId)!
    let shortTotal = 0
    const count = { quarantine: 0, rejected: 0 }
    for (const l of tr.lines.filter((x) => x.lots?.length)) {
      const got = input.received[l.id]
      l.lots!.forEach((lot, k) => {
        lot.receivedQty = got[k]
        const d = isReturn ? dispOf(l.id, k) : 'stock'
        if (isReturn) lot.disposition = d
        if (got[k] > 0) {
          const lotIn = { lotNo: lot.lotNo, expiry: lot.expiry }
          if (d === 'stock') {
            const txn = postStock({ kind: 'in', type: 'transfer-in', drugId: l.drugId, locationId: tr.toLocationId, qty: got[k], lot: lotIn, ref: tr.no }, u.id)
            offsetRestock(l.drugId, txn, u.id) // 只有進門診藥局才沖銷（offsetRestock 自己判斷地點）
          } else if (d === 'quarantine') {
            postStock({ kind: 'in', type: 'transfer-in', drugId: l.drugId, locationId: quarantineOf(wh).id, qty: got[k], lot: lotIn, ref: tr.no, reason: `退回待報廢（${tr.returnReason ?? ''}）` }, u.id)
            count.quarantine += got[k]
          } else {
            // 拒收：退回原藥局的同一個批號（帳回到藥局）
            postStock({ kind: 'in', type: 'transfer-in', drugId: l.drugId, locationId: tr.fromLocationId, qty: got[k], lot: lotIn, ref: tr.no, reason: `藥庫拒收：${input.rejectReasons![l.id].trim()}` }, u.id)
            count.rejected += got[k]
          }
        }
        shortTotal += lot.qty - got[k]
      })
      const reason = input.shortReasons?.[l.id]?.trim()
      if (reason && l.lots!.some((lot) => (lot.receivedQty ?? 0) < lot.qty)) l.shortReason = reason
      const rj = input.rejectReasons?.[l.id]?.trim()
      if (isReturn && rj && l.lots!.some((lot) => lot.disposition === 'rejected')) l.rejectReason = rj
    }
    Object.assign(tr, { status: 'received', receivedBy: u.id, receivedAt: now() })
    const notes = [shortTotal && `短少 ${shortTotal}`, count.quarantine && `待報廢 ${count.quarantine}`, count.rejected && `拒收退回 ${count.rejected}`].filter(Boolean).join('、')
    audit('撥補簽收', `${tr.no} ${nameOf.location(tr.toLocationId)}${notes ? `（${notes}）` : ''}`)
    return view(tr)
  })
}

/** 取消：只有請領中（還沒撥）的可以；撥出去的藥在路上，請簽收（短少寫原因） */
export function cancelTransfer(id: string, reason: string): Promise<TransferView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const tr = trOf(id)
    if (tr.status !== 'requested') fail(tr.status === 'issued' ? '已撥發的藥在運送中，不能取消；請簽收（沒收到的寫短少原因）' : '這張撥補單已結束', 'CONFLICT')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫取消原因')
    Object.assign(tr, { status: 'cancelled', cancelledBy: u.id, cancelledAt: now(), cancelReason: why })
    audit('取消撥補單', `${tr.no}（${why}）`)
    return view(tr)
  })
}

// ---------- 退回藥庫 ----------

export interface ReturnCandidate {
  lotId: string
  drugId: string
  drugName: string
  unit: string
  lotNo: string
  expiry: string
  qty: number
  /** expired 已過期、expiring 近效期、overstock 這個藥局存太多（可用量超過安全庫存 3 倍） */
  flag?: 'expired' | 'expiring' | 'overstock'
}

const RETURN_FLAG_ORDER = { expired: 0, expiring: 1, overstock: 2 } as const

/** 這個藥局可以退回藥庫的批號（有庫存的）；過期、近效期、存太多的排前面。盤點中的藥不列（盲盤） */
export function returnCandidates(fromLocationId: string): Promise<ReturnCandidate[]> {
  return query(() => {
    requireUser('pharmacist')
    warehouse()
    const from = stockLoc.usable(fromLocationId)
    if (from.kind !== 'pharmacy') fail('退回藥庫要從藥局發起')
    const t = today()
    const out: ReturnCandidate[] = []
    for (const lot of db.drugLots.filter((l) => l.locationId === from.id && l.qty > 0)) {
      const d = find.drug(lot.drugId)
      if (!d || stockLoc.counting(d.id, from.id)) continue
      const usable = usableQty(stockLoc.lots(d.id, from.id), t)
      const flag = lot.expiry < t ? 'expired' : isExpiringSoon(lot.expiry, t) ? 'expiring' : usable > stockLoc.safety(d, from.id) * 3 ? 'overstock' : undefined
      out.push({ lotId: lot.id, drugId: d.id, drugName: d.name, unit: d.unit, lotNo: lot.lotNo, expiry: lot.expiry, qty: lot.qty, ...(flag ? { flag } : {}) })
    }
    const rank = (c: ReturnCandidate) => (c.flag ? RETURN_FLAG_ORDER[c.flag] : 9)
    return out.sort((a, b) => rank(a) - rank(b) || a.drugName.localeCompare(b.drugName) || a.expiry.localeCompare(b.expiry))
  })
}

/**
 * 退回藥庫：逐批（lotId）給數量，送出就從藥局扣（transfer-out，指定批號；過期的也能退），單子直接是「運送中」，
 * 藥庫用一般的簽收（receiveTransfer）入帳。同一種藥的幾個批號併成一行
 */
export function returnToWarehouse(input: { fromLocationId: string; reason: string; lines: { lotId: string; qty: number }[] }): Promise<TransferView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const wh = warehouse()
    const from = stockLoc.usable(input.fromLocationId)
    if (from.kind !== 'pharmacy') failField('fromLocationId', '退回藥庫要從藥局發起')
    const errors: Record<string, string> = {}
    if (!input.reason?.trim()) errors.reason = '請寫退回原因（例：近效期、請領過多）'
    if (!input.lines?.length) errors.lines = '請至少選一個批號'
    const seen = new Set<string>()
    input.lines?.forEach((l, i) => {
      const lot = db.drugLots.find((x) => x.id === l.lotId && x.locationId === from.id)
      const d = lot && find.drug(lot.drugId)
      if (!lot || !d) errors[`line-${i}`] = '這個批號不在這個藥局'
      else if (seen.has(lot.id)) errors[`line-${i}`] = `${d.name} 批號 ${lot.lotNo} 重複了`
      else if (stockLoc.counting(d.id, from.id)) errors[`line-${i}`] = `${d.name}盤點中，盤點完成前不能退`
      else if (!Number.isInteger(l.qty) || l.qty <= 0) errors[`line-${i}`] = '數量需為正整數'
      else if (l.qty > lot.qty) errors[`line-${i}`] = `這個批號只有 ${lot.qty}`
      if (lot) seen.add(lot.id)
    })
    failFields(errors)
    const no = `TR${today().replace(/-/g, '')}-${String(nextCounter(`transfer:${today()}`)).padStart(2, '0')}`
    const byDrug = new Map<string, TransferLine>()
    for (const l of input.lines) {
      const lot = db.drugLots.find((x) => x.id === l.lotId)!
      postStock({ kind: 'out', type: 'transfer-out', drugId: lot.drugId, locationId: from.id, qty: l.qty, lotId: lot.id, ref: no, reason: input.reason.trim() }, u.id)
      const line = byDrug.get(lot.drugId) ?? { id: `L${byDrug.size + 1}`, drugId: lot.drugId, qty: 0, issuedQty: 0, lots: [] }
      line.qty += l.qty
      line.issuedQty! += l.qty
      line.lots!.push({ lotNo: lot.lotNo, expiry: lot.expiry, qty: l.qty })
      byDrug.set(lot.drugId, line)
    }
    const t = now()
    const tr: TransferOrder = {
      id: newId('TR'), no, kind: 'return', returnReason: input.reason.trim(), fromLocationId: from.id, toLocationId: wh.id, status: 'issued',
      lines: [...byDrug.values()], requestedBy: u.id, requestedAt: t, issuedBy: u.id, issuedAt: t,
    }
    db.transfers.push(tr)
    audit('退回藥庫', `${no} ${from.name} → ${wh.name}（${tr.lines.length} 項）：${tr.returnReason}`)
    return view(tr)
  })
}
