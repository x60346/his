// 盤點單：建立（選地點與範圍，展開成每批一列）→ 清點（盲盤）→ 送出 → 另一人覆核過帳。
//
// 幾個關鍵：
//   - 盲盤：清點中、待覆核時，範圍內藥品在這個地點的帳上數量，庫存頁、藥品明細、調劑畫面都不給看（views.stockLoc.counting）
//   - 盤點期間照常發藥：每一列清點的「那一刻」記下帳上數量（systemQty），差異以它為準——
//     不能拿建立盤點單時的帳比，那樣盤點期間發出去的藥全都會變成盤虧
//   - 過帳只在覆核時發生，每一批一筆調整異動、單號寫在異動上（從異動帳查得回是哪張盤點單）
import type { StocktakeLine, StocktakeSheet } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { find, nameOf, stockLoc } from './views'
import { postStock } from './inventory'
import { checkStocktakeActual } from './stock-rules'
import { isOpenStocktake, lineDiff, reviewBlocker, uncountedLines } from './stocktake-rules'

export interface StocktakeLineView extends StocktakeLine {
  drugName: string
  drugNameZh: string
  spec: string
  unit: string
  countedByName?: string
  /** 差異（只有送出後才給；清點中不給，盲盤） */
  diff?: number
}

export interface StocktakeView extends Omit<StocktakeSheet, 'lines'> {
  locationName: string
  scopeText: string
  createdByName: string
  submittedByName?: string
  reviewedByName?: string
  cancelledByName?: string
  lines: StocktakeLineView[]
  total: number
  countedCount: number
  /** 有差異的列數（送出後才有） */
  diffCount?: number
  /** 是否已揭露帳上數量與差異（送出後） */
  revealed: boolean
  /** 目前使用者不能覆核的原因（可以覆核就沒有） */
  reviewBlocked?: string
}

const scopeText = (s: StocktakeSheet['scope']) =>
  s.kind === 'all' ? '全部藥品' : s.kind === 'category' ? `${s.category}劑型` : `指定 ${s.drugIds.length} 種藥品`

function view(s: StocktakeSheet, userId?: string): StocktakeView {
  // 清點中不揭露：帳上數量、差異都拿掉（不只是畫面不顯示——資料就不給）
  const revealed = s.status !== 'counting'
  const lines: StocktakeLineView[] = s.lines.map((l) => {
    const d = find.drug(l.drugId)
    const { systemQty, ...rest } = l
    return {
      ...rest,
      ...(revealed ? { systemQty, diff: lineDiff(l) } : {}),
      drugName: d?.name ?? l.drugId,
      drugNameZh: d?.nameZh ?? '',
      spec: d?.spec ?? '',
      unit: d?.unit ?? '',
      ...(l.countedBy ? { countedByName: nameOf.user(l.countedBy) } : {}),
    }
  })
  return {
    ...s,
    lines,
    locationName: nameOf.location(s.locationId),
    scopeText: scopeText(s.scope),
    createdByName: nameOf.user(s.createdBy),
    ...(s.submittedBy ? { submittedByName: nameOf.user(s.submittedBy) } : {}),
    ...(s.reviewedBy ? { reviewedByName: nameOf.user(s.reviewedBy) } : {}),
    ...(s.cancelledBy ? { cancelledByName: nameOf.user(s.cancelledBy) } : {}),
    total: s.lines.length,
    countedCount: s.lines.filter((l) => l.counted !== undefined).length,
    ...(revealed ? { diffCount: s.lines.filter((l) => (lineDiff(l) ?? 0) !== 0).length } : {}),
    revealed,
    ...(userId && s.status === 'submitted' ? { reviewBlocked: reviewBlocker(s, userId) } : {}),
  }
}

const sheetOf = (id: string) => must(db.stocktakes.find((s) => s.id === id), '盤點單')
const lineOf = (s: StocktakeSheet, lineId: string) => must(s.lines.find((l) => l.id === lineId), '盤點列')

/** 盤點單清單：進行中的在前，其餘依建立時間新到舊 */
export function listStocktakes(q: { locationId?: string; status?: StocktakeSheet['status'][] } = {}): Promise<StocktakeView[]> {
  return query(() => {
    const u = requireUser('pharmacist', 'admin')
    return db.stocktakes
      .filter((s) => (!q.locationId || s.locationId === q.locationId) && (!q.status || q.status.includes(s.status)))
      .sort((a, b) => Number(isOpenStocktake(b)) - Number(isOpenStocktake(a)) || b.createdAt.localeCompare(a.createdAt))
      .map((s) => view(s, u.id))
  })
}

export function getStocktake(id: string): Promise<StocktakeView> {
  return query(() => view(sheetOf(id), requireUser('pharmacist', 'admin').id))
}

export interface StocktakeInput {
  locationId?: string
  scope: StocktakeSheet['scope']
}

/** 建立盤點單：範圍內、這個地點有庫存的批號各一列；同一批號不能同時在兩張進行中的盤點單上 */
export function createStocktake(input: StocktakeInput): Promise<StocktakeView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const loc = stockLoc.usable(input.locationId)
    const sc = input.scope
    if (sc?.kind === 'category' && !sc.category) failField('category', '請選擇劑型')
    if (sc?.kind === 'drugs' && !sc.drugIds?.length) failField('drugIds', '請選擇要盤點的藥品')
    if (!sc || !['all', 'category', 'drugs'].includes(sc.kind)) failField('scope', '請選擇盤點範圍')
    const inScope = db.drugs.filter((d) => d.active && (sc.kind === 'all' || (sc.kind === 'category' ? d.category === sc.category : sc.drugIds.includes(d.id))))
    const lots = inScope
      .flatMap((d) => stockLoc.lots(d.id, loc.id).filter((l) => l.qty > 0))
      .sort((a, b) => (find.drug(a.drugId)?.name ?? '').localeCompare(find.drug(b.drugId)?.name ?? '') || a.expiry.localeCompare(b.expiry))
    if (!lots.length) fail(`${loc.name}在這個範圍內沒有庫存批號`)
    const busy = db.stocktakes.filter((s) => isOpenStocktake(s) && s.locationId === loc.id && s.lines.some((l) => lots.some((x) => x.id === l.lotId)))
    if (busy.length) fail(`範圍內有藥品正在盤點（${busy.map((s) => s.no).join('、')}），請先完成或取消那張盤點單`, 'CONFLICT')
    const t = now()
    const no = `PD${today().replace(/-/g, '')}-${String(nextCounter(`stocktake:${today()}`)).padStart(2, '0')}`
    const sheet: StocktakeSheet = {
      id: newId('PD'),
      no,
      locationId: loc.id,
      scope: sc.kind === 'drugs' ? { kind: 'drugs', drugIds: [...new Set(sc.drugIds)] } : sc.kind === 'category' ? { kind: 'category', category: sc.category } : { kind: 'all' },
      status: 'counting',
      lines: lots.map((l, i) => ({ id: `L${i + 1}`, drugId: l.drugId, lotId: l.id, lotNo: l.lotNo, expiry: l.expiry })),
      createdBy: u.id,
      createdAt: t,
    }
    db.stocktakes.push(sheet)
    audit('建立盤點單', `${no} ${loc.name} ${scopeText(sheet.scope)}（${sheet.lines.length} 批）`)
    return view(sheet, u.id)
  })
}

/**
 * 填一批的實點數量（可以重填）。這一刻的帳上數量記在 systemQty——盤點期間照常發藥，
 * 差異要和「點的那一刻」比，才不會把盤點期間發出去的藥算成盤虧。
 */
export function countLine(sheetId: string, lineId: string, counted: number): Promise<StocktakeView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const s = sheetOf(sheetId)
    if (s.status !== 'counting') fail('這張盤點單已送出，不能再修改清點數量（需要的話請覆核者退回重盤）', 'CONFLICT')
    const err = checkStocktakeActual(counted)
    if (err) failField('counted', err)
    const l = lineOf(s, lineId)
    const lot = l.lotId ? db.drugLots.find((x) => x.id === l.lotId) : undefined
    Object.assign(l, { counted, countedBy: u.id, countedAt: now(), systemQty: lot?.qty ?? 0 })
    return view(s, u.id)
  })
}

/** 架上找到、清點表上沒有的批號（例：帳上已扣完、其實還有；或進貨沒登記）：加一列，帳上數量視為 0（或該批號在這個地點目前的量） */
export function addFoundLot(sheetId: string, input: { drugId: string; lotNo: string; expiry: string; counted: number }): Promise<StocktakeView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const s = sheetOf(sheetId)
    if (s.status !== 'counting') fail('這張盤點單已送出，不能再加批號', 'CONFLICT')
    const drug = must(find.drug(input.drugId), '藥品')
    const lotNo = (input.lotNo ?? '').trim().toUpperCase()
    const errors: Record<string, string> = {}
    if (!lotNo) errors.lotNo = '請輸入批號'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiry ?? '')) errors.expiry = '請輸入效期'
    const cErr = checkStocktakeActual(input.counted)
    if (cErr) errors.counted = cErr
    failFields(errors)
    const sc = s.scope
    if (sc.kind === 'category' && drug.category !== sc.category) failField('drugId', `${drug.name} 不在這張盤點單的範圍（${sc.category}）`)
    if (sc.kind === 'drugs' && !sc.drugIds.includes(drug.id)) failField('drugId', `${drug.name} 不在這張盤點單的範圍`)
    const dup = s.lines.find((l) => l.drugId === drug.id && l.lotNo === lotNo)
    if (dup) failField('lotNo', `批號 ${lotNo} 已在清點表上（第 ${s.lines.indexOf(dup) + 1} 列），請直接填那一列`)
    const existing = stockLoc.lots(drug.id, s.locationId).find((l) => l.lotNo === lotNo)
    if (existing && existing.expiry !== input.expiry) failField('expiry', `批號 ${lotNo} 帳上的效期是 ${existing.expiry}`)
    s.lines.push({
      id: `L${s.lines.length + 1}`, drugId: drug.id, ...(existing ? { lotId: existing.id } : {}), lotNo, expiry: input.expiry,
      counted: input.counted, countedBy: u.id, countedAt: now(), systemQty: existing?.qty ?? 0,
    })
    audit('盤點加列', `${s.no} ${drug.name} 批號 ${lotNo}（清點表上沒有）`)
    return view(s, u.id)
  })
}

/** 送出盤點：每一批都要有數量（沒有就填 0）；送出後才揭露差異，交給另一人覆核 */
export function submitStocktake(id: string): Promise<StocktakeView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const s = sheetOf(id)
    if (s.status !== 'counting') fail('這張盤點單不是清點中', 'CONFLICT')
    const left = uncountedLines(s)
    if (left.length) fail(`還有 ${left.length} 批沒有填數量（架上沒有請填 0）`, 'CONFLICT')
    Object.assign(s, { status: 'submitted', submittedBy: u.id, submittedAt: now() })
    audit('送出盤點單', `${s.no}（${s.lines.length} 批）`)
    return view(s, u.id)
  })
}

/** 覆核退回重盤：數量保留、可改；寫原因 */
export function returnStocktake(id: string, reason: string): Promise<StocktakeView> {
  return mutate(() => {
    const u = requireUser('pharmacist', 'admin')
    const s = sheetOf(id)
    const blocked = reviewBlocker(s, u.id)
    if (blocked) fail(blocked, s.status === 'submitted' ? 'FORBIDDEN' : 'CONFLICT')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫退回原因（例：第 3 列差異大，請重點）')
    s.returns = [...(s.returns ?? []), { by: u.id, at: now(), reason: why }]
    s.status = 'counting'
    delete s.submittedBy
    delete s.submittedAt
    audit('退回盤點單', `${s.no}（${why}）`)
    return view(s, u.id)
  })
}

/**
 * 覆核過帳：有差異的每一列都要寫原因；每一批一筆調整（盤盈入、盤虧出），單號寫在異動上。
 * 盤虧時，若這一批在清點後又發出、帳上已經不夠扣——代表清點或發藥有一邊錯了，整張不過帳，請退回重盤那一批。
 */
export function postStocktake(id: string, reasons: Record<string, string> = {}): Promise<StocktakeView> {
  return mutate(() => {
    const u = requireUser('pharmacist', 'admin')
    const s = sheetOf(id)
    const blocked = reviewBlocker(s, u.id)
    if (blocked) fail(blocked, s.status === 'submitted' ? 'FORBIDDEN' : 'CONFLICT')
    const diffs = s.lines.filter((l) => (lineDiff(l) ?? 0) !== 0)
    const missing: Record<string, string> = {}
    for (const l of diffs) if (!reasons[l.id]?.trim()) missing[`reason-${l.id}`] = '有差異，請寫原因（例：破損、計數錯誤、未登記進貨）'
    failFields(missing)
    for (const l of diffs) {
      const diff = lineDiff(l)!
      const reason = `盤點 ${s.no}：${reasons[l.id].trim()}`
      const drug = find.drug(l.drugId)!
      let txn
      if (diff > 0) {
        txn = postStock({ kind: 'in', type: 'adjust', drugId: l.drugId, locationId: s.locationId, qty: diff, lot: { lotNo: l.lotNo, expiry: l.expiry }, ref: s.no, reason }, u.id)
      } else {
        const lot = l.lotId ? db.drugLots.find((x) => x.id === l.lotId) : undefined
        if (!lot || lot.qty < -diff) fail(`${drug.name} 批號 ${l.lotNo}：清點後帳上剩 ${lot?.qty ?? 0}，不夠扣盤虧 ${-diff}（清點後又發出了），請退回重盤這一批`, 'CONFLICT')
        txn = postStock({ kind: 'out', type: 'adjust', drugId: l.drugId, locationId: s.locationId, qty: -diff, lotId: lot!.id, ref: s.no, reason }, u.id)
      }
      Object.assign(l, { reason: reasons[l.id].trim(), txnId: txn.id })
    }
    Object.assign(s, { status: 'posted', reviewedBy: u.id, reviewedAt: now() })
    const gain = diffs.filter((l) => lineDiff(l)! > 0).length
    const loss = diffs.length - gain
    audit('盤點過帳', `${s.no} ${nameOf.location(s.locationId)}：${s.lines.length} 批，盤盈 ${gain}、盤虧 ${loss}`)
    return view(s, u.id)
  })
}

export function cancelStocktake(id: string, reason: string): Promise<StocktakeView> {
  return mutate(() => {
    const u = requireUser('pharmacist', 'admin')
    const s = sheetOf(id)
    if (!isOpenStocktake(s)) fail('已過帳或已取消的盤點單不能取消', 'CONFLICT')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫取消原因')
    Object.assign(s, { status: 'cancelled', cancelledBy: u.id, cancelledAt: now(), cancelReason: why })
    audit('取消盤點單', `${s.no}（${why}）`)
    return view(s, u.id)
  })
}
