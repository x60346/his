// 病房常備：每個病房一個常備地點（StockLocation.kind = ward），放藥劑部與護理部協議的品項，各有基準量。
//   - 補充：住院藥局把低於基準量的補到基準量（一步完成，跟著藥車送；送錯短少由點班抓）
//   - 給藥：PRN、STAT 從病人所在病房的常備扣（stock-ledger.wardStockOut）；不夠就改由住院藥局直送，不擋給藥
//   - 點班：每班一次，逐項實點（看得到帳上數量），差異寫原因、自動調帳
import type { WardCount, WardStockItem } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { postStock } from './stock-ledger'
import { shiftInstanceOf, shiftOf } from './nursing-rules'
import { allocateFefo, usableQty } from './stock-rules'
import { find, nameOf, stockLoc } from './views'
import { consumeWitness, WITNESS_MIN, witnessFor } from './witness-core'

function wardLoc(ward: string) {
  const l = stockLoc.ward(ward)
  if (!l) fail(`「${ward}」沒有病房常備`)
  return l!
}
/** 帳上數量（含過期：點的是櫃子裡實際有的） */
const bookQty = (drugId: string, locId: string) => stockLoc.lots(drugId, locId).reduce((n, l) => n + l.qty, 0)

/** 現在這一班（點班以「班」為單位：小夜在午夜後算前一天的小夜） */
function currentShift(at = now()) {
  const shift = shiftOf(at)
  return shiftInstanceOf(shift, at)
}

export interface WardStockRow {
  drugId: string
  drugName: string
  unit: string
  /** 基準量；不在常備清單、櫃子裡卻還有的（例：品項剛移除）為 0 */
  par: number
  /** 帳上數量（含過期） */
  onHand: number
  /** 可用（未過期） */
  usable: number
  /** 低於基準量 */
  below: boolean
  /** 管制藥品級別（有就是管制藥：點班要另一位護理師見證） */
  controlled?: number
}

export interface WardStockView {
  ward: string
  locationId: string
  locationName: string
  rows: WardStockRow[]
  shift: { shift: WardCount['shift']; date: string; counted: boolean }
  lastCount?: { at: string; byName: string; shift: WardCount['shift']; diffs: number; witnessName?: string }
  /** 有管制藥：點班要另一位護理師當場見證（witness.approveWitness wardCount） */
  needsWitness: boolean
}

function wardView(ward: string): WardStockView {
  const loc = wardLoc(ward)
  const t = now()
  const rows: WardStockRow[] = stockLoc.wardDrugIds(ward, loc.id).map((drugId) => {
    const par = db.wardStockItems.find((x) => x.ward === ward && x.drugId === drugId)?.par ?? 0
    const d = find.drug(drugId)
    const onHand = bookQty(drugId, loc.id)
    const usable = usableQty(stockLoc.lots(drugId, loc.id), t)
    return { drugId, drugName: d?.name ?? drugId, unit: d?.unit ?? '', par, onHand, usable, below: par > 0 && usable < par, ...(d?.controlled ? { controlled: d.controlled } : {}) }
  })
  const cur = currentShift(t)
  const last = db.wardCounts.filter((c) => c.ward === ward).sort((a, b) => b.at.localeCompare(a.at))[0]
  return {
    ward, locationId: loc.id, locationName: loc.name, rows, needsWitness: rows.some((r) => r.controlled),
    shift: { ...cur, counted: db.wardCounts.some((c) => c.ward === ward && c.shift === cur.shift && c.date === cur.date) },
    ...(last ? { lastCount: { at: last.at, byName: nameOf.user(last.countedBy), shift: last.shift, diffs: last.lines.filter((l) => l.counted !== l.book).length, ...(last.witnessBy ? { witnessName: nameOf.user(last.witnessBy) } : {}) } } : {}),
  }
}

/** 這個病房的常備：品項、基準量、帳上與可用、本班點過沒 */
export function getWardStock(ward: string): Promise<WardStockView> {
  return query(() => {
    requireUser('nurse', 'pharmacist', 'admin')
    return wardView(ward)
  })
}

/** 全部病房（藥師的維護與補充畫面） */
export function listWardStocks(): Promise<WardStockView[]> {
  return query(() => {
    requireUser('pharmacist', 'admin')
    return db.stockLocations.filter((l) => l.kind === 'ward' && l.active).map((l) => wardView(l.ward!))
  })
}

/** 設定常備品項的基準量（藥師）；0＝移除（櫃子裡還有就不能移除：先點班或用完） */
export function saveWardStockItem(ward: string, drugId: string, par: number): Promise<WardStockItem | null> {
  return mutate(() => {
    requireUser('pharmacist')
    const loc = wardLoc(ward)
    const d = must(find.drug(drugId), '藥品')
    if (!Number.isInteger(par) || par < 0 || par > 999) failField('par', '基準量需為 0–999 的整數（0＝移除）')
    const old = db.wardStockItems.find((x) => x.ward === ward && x.drugId === drugId)
    if (par === 0) {
      if (!old) fail('這個藥不在常備清單上')
      if (bookQty(drugId, loc.id) > 0) fail(`${d.name}櫃子裡還有 ${bookQty(drugId, loc.id)} ${d.unit}，用完或退回後才能移除`, 'CONFLICT')
      db.wardStockItems = db.wardStockItems.filter((x) => x !== old)
      audit('病房常備品項', `${ward} 移除 ${d.name}`)
      return null
    }
    if (!d.active) fail(`${d.name}已停用`)
    const before = old?.par
    if (old) old.par = par
    else db.wardStockItems.push({ ward, drugId, par })
    audit('病房常備品項', `${ward} ${d.name}：基準量 ${before ?? '（新增）'} → ${par}`)
    return { ward, drugId, par }
  })
}

/**
 * 補充（住院藥局 → 病房常備，藥師）：從住院藥局依效期先到先出扣，同幾個批號進病房常備；一步完成（跟著藥車送）。
 * 送的是畫面上填的數量；補了會超過基準量的擋下（多放在病房的藥沒人管）
 */
export function refillWard(ward: string, lines: { drugId: string; qty: number }[]): Promise<{ no: string; lines: number }> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const loc = wardLoc(ward)
    const src = stockLoc.usable(stockLoc.ipd())
    const t = now()
    const errors: Record<string, string> = {}
    const todo = (lines ?? []).filter((l) => l.qty !== 0)
    if (!todo.length) fail('沒有要補充的品項')
    for (const l of todo) {
      const item = db.wardStockItems.find((x) => x.ward === ward && x.drugId === l.drugId)
      const d = find.drug(l.drugId)
      if (!item || !d) errors[`qty.${l.drugId}`] = '不是這個病房的常備品項'
      else if (!Number.isInteger(l.qty) || l.qty < 0) errors[`qty.${l.drugId}`] = '數量需為正整數'
      else if (usableQty(stockLoc.lots(l.drugId, loc.id), t) + l.qty > item.par) errors[`qty.${l.drugId}`] = `補了會超過基準量 ${item.par}`
      else if (stockLoc.counting(l.drugId, src.id)) errors[`qty.${l.drugId}`] = `${d.name}在${src.name}盤點中`
    }
    failFields(errors)
    const no = `WR${t.slice(0, 10).replace(/-/g, '')}-${String(nextCounter(`wardrefill:${t.slice(0, 10)}`)).padStart(2, '0')}`
    for (const l of todo) {
      const out = postStock({ kind: 'out', type: 'transfer-out', drugId: l.drugId, locationId: src.id, qty: l.qty, ref: no, reason: `病房常備補充 ${ward}` }, u.id, t)
      for (const m of out.lots) {
        const lot = must(stockLoc.lots(l.drugId, src.id).find((x) => x.lotNo === m.lotNo), '批號')
        postStock({ kind: 'in', type: 'transfer-in', drugId: l.drugId, locationId: loc.id, qty: -m.qty, lot: { lotNo: lot.lotNo, expiry: lot.expiry }, ref: no }, u.id, t)
      }
    }
    audit('病房常備補充', `${no} ${ward}：${todo.map((l) => `${find.drug(l.drugId)?.name} ${l.qty}`).join('、')}`)
    return { no, lines: todo.length }
  })
}

/**
 * 點班（護理師，每班一次）：畫面上列出的每一項都要填實點數量；有差異要寫原因，自動調帳（盤虧依效期先到先出扣、
 * 盤盈加到效期最晚的那一批）。送出的是畫面上看到的品項——之後才補充或用掉的，請重新整理再點
 */
export function countWard(ward: string, input: { lines: { drugId: string; book: number; counted: number; reason?: string }[]; witness?: string }): Promise<WardCount> {
  return mutate(() => {
    const u = requireUser('nurse')
    const loc = wardLoc(ward)
    const view = wardView(ward)
    const lines = input.lines ?? []
    const missing = view.rows.filter((r) => !lines.some((l) => l.drugId === r.drugId))
    if (missing.length) fail(`還有 ${missing.map((r) => r.drugName).join('、')} 沒點`)
    const changed = lines.filter((l) => view.rows.find((r) => r.drugId === l.drugId)?.onHand !== l.book)
    if (changed.length) fail(`帳上數量在你點的時候變了（${changed.map((l) => find.drug(l.drugId)?.name).join('、')}：剛有人給藥或補充），請重新整理再點`, 'CONFLICT')
    const errors: Record<string, string> = {}
    for (const l of lines) {
      if (!Number.isInteger(l.counted) || l.counted < 0) errors[`counted.${l.drugId}`] = '實點需為 0 以上的整數'
      else if (l.counted !== l.book && !l.reason?.trim()) errors[`reason.${l.drugId}`] = `差 ${l.counted - l.book}，請寫原因`
    }
    failFields(errors)
    // 管制藥：另一位護理師當場見證（服務層把關，不是畫面擋）
    const w = view.needsWitness ? witnessFor(input.witness, 'wardCount', ward, u.id) : undefined
    if (w === null) failField('witness', '點班含管制藥，需另一位護理師見證')
    if (w === 'expired') failField('witness', `見證已超過 ${WITNESS_MIN} 分鐘，請重新見證`)
    const witness = w || undefined
    const t = now()
    const cur = currentShift(t)
    for (const l of lines.filter((x) => x.counted !== x.book)) {
      const diff = l.counted - l.book
      const why = `病房點班 ${ward}：${l.reason!.trim()}`
      if (diff < 0) {
        const lots = stockLoc.lots(l.drugId, loc.id)
        const takes = allocateFefo(lots, -diff, t, true)
        if (!takes) fail('帳上數量不足以調整，請重新整理', 'CONFLICT')
        postStock({ kind: 'out', type: 'adjust', drugId: l.drugId, locationId: loc.id, qty: -diff, ref: `點班 ${ward}`, reason: why, includeExpired: true, ...(witness ? { witnessBy: witness.witnessId } : {}) }, u.id, t)
      } else {
        const lot = stockLoc.lots(l.drugId, loc.id).sort((a, b) => b.expiry.localeCompare(a.expiry))[0]
        if (!lot) fail(`${find.drug(l.drugId)?.name}在病房沒有批號紀錄，多出來的藥請送回住院藥局確認`, 'CONFLICT')
        postStock({ kind: 'in', type: 'adjust', drugId: l.drugId, locationId: loc.id, qty: diff, lot: { lotNo: lot.lotNo, expiry: lot.expiry }, ref: `點班 ${ward}`, reason: why, ...(witness ? { witnessBy: witness.witnessId } : {}) }, u.id, t)
      }
    }
    const c: WardCount = {
      id: newId('WC'), ward, shift: cur.shift, date: cur.date, countedBy: u.id, ...(witness ? { witnessBy: witness.witnessId } : {}), at: t,
      lines: lines.map((l) => ({ drugId: l.drugId, book: l.book, counted: l.counted, ...(l.counted !== l.book ? { reason: l.reason!.trim() } : {}) })),
    }
    db.wardCounts.push(c)
    const diffs = c.lines.filter((l) => l.counted !== l.book)
    audit('病房點班', `${ward} ${cur.date} ${cur.shift}：${lines.length} 項${diffs.length ? `，差異 ${diffs.map((l) => `${find.drug(l.drugId)?.name} ${l.counted - l.book > 0 ? '+' : ''}${l.counted - l.book}（${l.reason}）`).join('、')}` : '，帳實相符'}${witness ? `；見證 ${witness.witnessName}` : ''}`)
    if (witness) consumeWitness(input.witness)
    return c
  })
}
