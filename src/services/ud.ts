// 住院藥局：UD（Unit Dose）調劑與退藥點收。
//
// 流程：
//   - 每日調劑：藥師每天下午把「明天整天」的劑量調好送病房（每位病人、每筆長期給藥醫囑一行），扣住院藥局的庫存
//   - 補調劑：今天才開的醫囑、還沒調劑的今天劑量（急件，列在最上面）
//   - 護理師只能給「已調劑」的排程劑量（nursing.executeMar 擋）；PRN、STAT 用病房常備，給藥時直接扣（stock-ledger.wardStockOut）
//   - 退藥：發出去但不會給的劑量（暫停、拒絕、醫囑停止、出院）自動列入「待退藥」，藥師點收才入庫；
//     實收比應退少要寫原因（破損、遺失）。退回原本發出的那幾個批號
//
// 頁面送出的是「畫面上看得到的那幾劑」（marIds）：藥師按下前醫師剛好又開的新醫囑，不會被一起調劑——
// 和護理師核對醫囑同一個原則。
import type { MarRecord, UdDispense, UdLine, UdReturn } from '@/types'
import { commitIfPossible, db, newId, nextCounter } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failFields, failField, must, mutate, query, requireUser } from './http'
import { ensureMar } from './ipd'
import { doseUnitOf } from './billing'
import { openQuery } from './nursing-rules'
import { postStock } from './stock-ledger'
import { usableQty } from './stock-rules'
import { UD_RETURN_CAUSE, udPerDose, type UdReturnCause } from './ud-rules'
import { pendingReturn, udCandidate } from './ud-work'
import { admissionView, find, nameOf, stockLoc } from './views'

export interface UdWorkLine {
  orderId: string
  drugId: string
  drugName: string
  drugNameZh: string
  spec: string
  /** 調劑單位（發多少） */
  unit: string
  dose: number
  /** 給藥單位（每次用多少） */
  doseUnit: string
  freqLabel: string
  route: string
  marIds: string[]
  /** 這幾劑的時間（MM-DD HH:mm） */
  times: string[]
  /** 每劑幾個調劑單位；無法換算的沒有（藥師填數量） */
  perDose?: number
  /** 可換算時的發藥量 */
  qty?: number
  highAlert: boolean
  /** 醫囑有疑問、待醫師回覆（照樣可以調劑；提醒藥師） */
  pendingQuery?: string
  /** 住院藥局目前可用量；這種藥正在盤點時不給（盲盤），改標盤點單號 */
  available?: number
  counting?: string
}

export interface UdWorkGroup {
  admissionId: string
  admitNo: string
  bedNo: string
  patientName: string
  chartNo: string
  allergies: string[]
  lines: UdWorkLine[]
}

export interface UdReturnRow {
  dispenseId: string
  lineId: string
  no: string
  dispensedAt: string
  admissionId: string
  admitNo: string
  bedNo: string
  patientName: string
  drugName: string
  unit: string
  /** 應退的量（調劑單位） */
  expected: number
  doses: number
  /** 原因摘要：「暫停給藥 1、醫囑停止 2」 */
  causes: string
}

export interface UdDispenseView {
  id: string
  no: string
  kind: UdDispense['kind']
  dispensedAt: string
  dispensedByName: string
  patients: number
  lines: number
  returned: number
}

export interface UdWork {
  locationId: string
  locationName: string
  today: string
  tomorrow: string
  /** 補調劑：今天（含更早）還沒調劑的劑量——醫囑今天才開的、或漏調的 */
  extra: UdWorkGroup[]
  /** 每日調劑：明天整天 */
  daily: UdWorkGroup[]
  /** 待退藥點收 */
  returns: UdReturnRow[]
  /** 最近的調劑紀錄 */
  recent: UdDispenseView[]
}

function groupsOf(mars: MarRecord[], locationId: string): UdWorkGroup[] {
  const byAdm = new Map<string, MarRecord[]>()
  for (const m of mars) byAdm.set(m.admissionId, [...(byAdm.get(m.admissionId) ?? []), m])
  return [...byAdm.entries()]
    .map(([admissionId, list]) => {
      const a = admissionView(must(find.admission(admissionId), '住院紀錄'))
      const byOrder = new Map<string, MarRecord[]>()
      for (const m of list.sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt))) byOrder.set(m.orderId, [...(byOrder.get(m.orderId) ?? []), m])
      const lines = [...byOrder.entries()].map(([orderId, ms]): UdWorkLine => {
        const o = db.ipdOrders.find((x) => x.id === orderId)!
        const d = must(find.drug(o.drugId!), '藥品')
        const per = udPerDose(d, o.dose)
        const counting = stockLoc.counting(d.id, locationId)
        return {
          orderId,
          drugId: d.id,
          drugName: d.name,
          drugNameZh: d.nameZh,
          spec: d.spec,
          unit: d.unit,
          dose: o.dose ?? 0,
          doseUnit: doseUnitOf(d),
          freqLabel: find.freq(o.freq ?? '')?.label ?? o.freq ?? '',
          route: o.route ?? '',
          marIds: ms.map((m) => m.id),
          times: ms.map((m) => m.scheduledAt.slice(5)),
          ...(per ? { perDose: per, qty: per * ms.length } : {}),
          highAlert: d.highAlert,
          ...(openQuery(o) ? { pendingQuery: openQuery(o)!.reason } : {}),
          ...(counting ? { counting } : { available: usableQty(stockLoc.lots(d.id, locationId), today()) }),
        }
      })
      return { admissionId, admitNo: a.admitNo, bedNo: a.bed?.bedNo ?? '', patientName: a.patientName, chartNo: a.chartNo, allergies: a.allergies, lines }
    })
    .sort((x, y) => x.bedNo.localeCompare(y.bedNo))
}

function returnRows(): UdReturnRow[] {
  const rows: UdReturnRow[] = []
  for (const u of db.udDispenses) {
    for (const l of u.lines) {
      const p = pendingReturn(l)
      if (!p.marIds.length) continue
      const a = find.admission(l.admissionId)
      const d = find.drug(l.drugId)
      const count = new Map<UdReturnCause, number>()
      for (const c of p.causes) count.set(c, (count.get(c) ?? 0) + 1)
      rows.push({
        dispenseId: u.id,
        lineId: l.id,
        no: u.no,
        dispensedAt: u.dispensedAt,
        admissionId: l.admissionId,
        admitNo: a?.admitNo ?? '',
        bedNo: a?.bedId ? find.bed(a.bedId)?.bedNo ?? '' : '',
        patientName: nameOf.patient(a?.patientId),
        drugName: d?.name ?? l.drugId,
        unit: d?.unit ?? '',
        expected: l.perDose! * p.marIds.length,
        doses: p.marIds.length,
        causes: [...count.entries()].map(([c, n]) => `${UD_RETURN_CAUSE[c]} ${n}`).join('、'),
      })
    }
  }
  return rows.sort((x, y) => x.dispensedAt.localeCompare(y.dispensedAt) || x.bedNo.localeCompare(y.bedNo))
}

/** 藥師的住院調劑工作清單：補調劑（今天）、每日調劑（明天）、待退藥、最近的調劑 */
export function getUdWork(): Promise<UdWork> {
  return query(() => {
    requireUser('pharmacist')
    const t = today()
    const tomorrow = addDays(t, 1)
    let added = false
    for (const a of db.admissions.filter((x) => x.status === 'admitted')) {
      added = ensureMar(a.id, t) || added
      added = ensureMar(a.id, tomorrow) || added
    }
    if (added) commitIfPossible()
    const loc = stockLoc.usable(stockLoc.ipd())
    const cand = db.mar.filter((m) => m.scheduledAt.slice(0, 10) <= tomorrow && udCandidate(m))
    return {
      locationId: loc.id,
      locationName: loc.name,
      today: t,
      tomorrow,
      extra: groupsOf(cand.filter((m) => m.scheduledAt.slice(0, 10) <= t), loc.id),
      daily: groupsOf(cand.filter((m) => m.scheduledAt.slice(0, 10) === tomorrow), loc.id),
      returns: returnRows(),
      recent: [...db.udDispenses]
        .sort((x, y) => y.dispensedAt.localeCompare(x.dispensedAt))
        .slice(0, 8)
        .map((u) => ({
          id: u.id,
          no: u.no,
          kind: u.kind,
          dispensedAt: u.dispensedAt,
          dispensedByName: nameOf.user(u.dispensedBy),
          patients: new Set(u.lines.map((l) => l.admissionId)).size,
          lines: u.lines.length,
          returned: u.lines.reduce((n, l) => n + (l.returns ?? []).reduce((s, r) => s + r.qty, 0), 0),
        })),
    }
  })
}

export interface UdDispenseInput {
  kind: UdDispense['kind']
  /** 畫面上看得到的那幾劑 */
  marIds: string[]
  /** 無法換算的藥：每筆醫囑發多少（調劑單位；0＝床邊已有、這次不發） */
  qtys?: Record<string, number>
}

/**
 * 調劑：扣住院藥局的庫存（任一藥不足就整筆不扣），那幾劑標上「已調劑」，護理師才能給。
 * 每日調劑只收明天的劑量、補調劑只收今天（含更早）的——頁面分成兩區，送錯區就是畫面過期了
 */
export function dispenseUd(input: UdDispenseInput): Promise<{ no: string; patients: number; lines: number }> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const loc = stockLoc.usable(stockLoc.ipd())
    const t = now()
    const tomorrow = addDays(t, 1)
    const ids = [...new Set(input.marIds ?? [])]
    if (!ids.length) fail('沒有要調劑的劑量')
    const mars = ids.map((id) => must(db.mar.find((m) => m.id === id), '給藥排程'))
    const stale = mars.filter((m) => !udCandidate(m))
    if (stale.length) fail(`有 ${stale.length} 劑已調劑、已執行或醫囑已停止，請重新整理後再調劑`, 'CONFLICT')
    const wrongDay = mars.filter((m) => (input.kind === 'daily' ? m.scheduledAt.slice(0, 10) !== tomorrow : m.scheduledAt.slice(0, 10) > t.slice(0, 10)))
    if (wrongDay.length) fail(input.kind === 'daily' ? '每日調劑只調明天的劑量' : '補調劑只調今天的劑量（明天的請用每日調劑）', 'CONFLICT')

    // 每位病人、每筆醫囑一行
    const byOrder = new Map<string, MarRecord[]>()
    for (const m of mars.sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt))) byOrder.set(m.orderId, [...(byOrder.get(m.orderId) ?? []), m])
    const errors: Record<string, string> = {}
    const plan = [...byOrder.entries()].map(([orderId, ms]) => {
      const o = db.ipdOrders.find((x) => x.id === orderId)!
      const d = must(find.drug(o.drugId!), '藥品')
      const per = udPerDose(d, o.dose)
      const raw = input.qtys?.[orderId]
      if (!per && (raw === undefined || !Number.isInteger(raw) || raw < 0)) errors[`qty.${orderId}`] = `${d.name} 每次 ${o.dose} ${doseUnitOf(d)} 無法換算，請填發幾 ${d.unit}（床邊已有填 0）`
      const counting = stockLoc.counting(d.id, loc.id)
      if (counting) errors[`qty.${orderId}`] = `${d.name}在${loc.name}盤點中（${counting}），盤點完成前不能調劑`
      return { o, d, ms, per, qty: per ? per * ms.length : raw ?? 0 }
    })
    failFields(errors)

    const no = `UD${t.slice(0, 10).replace(/-/g, '')}-${String(nextCounter(`ud:${t.slice(0, 10)}`)).padStart(2, '0')}`
    const lines: UdLine[] = plan.map((p) => {
      const line: UdLine = { id: newId('UDL'), admissionId: p.o.admissionId, orderId: p.o.id, drugId: p.d.id, marIds: p.ms.map((m) => m.id), qty: p.qty, ...(p.per ? { perDose: p.per } : {}) }
      if (p.qty > 0) line.txnId = postStock({ kind: 'out', type: 'dispense', drugId: p.d.id, locationId: loc.id, qty: p.qty, ref: no }, u.id, t).id
      for (const m of p.ms) m.udLineId = line.id
      return line
    })
    db.udDispenses.push({ id: newId('UD'), no, locationId: loc.id, kind: input.kind, dispensedBy: u.id, dispensedAt: t, lines })
    const patients = new Set(lines.map((l) => l.admissionId)).size
    audit('住院調劑', `${no} ${input.kind === 'daily' ? '每日調劑（明日）' : '補調劑'}：${patients} 位病人、${lines.length} 項`)
    return { no, patients, lines: lines.length }
  })
}

/**
 * 退藥點收：這一行目前要退的劑量全部結清。實收可以比應退少（破損、遺失要寫原因），不能多。
 * 退回發出時的那幾個批號（從最後扣的那批開始退），效期跟著走；實收 0 就只結清、不入庫
 */
export function receiveUdReturn(lineId: string, input: { qty: number; reason?: string }): Promise<UdReturn> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const disp = must(db.udDispenses.find((x) => x.lines.some((l) => l.id === lineId)), '調劑紀錄')
    const line = disp.lines.find((l) => l.id === lineId)!
    const p = pendingReturn(line)
    if (!p.marIds.length) fail('這一項沒有要退的藥（可能已點收）', 'CONFLICT')
    const expected = line.perDose! * p.marIds.length
    const qty = input.qty
    const reason = input.reason?.trim()
    if (!Number.isInteger(qty) || qty < 0) failField('qty', '實收數量需為 0 以上的整數')
    if (qty > expected) failField('qty', `實收不能多於應退（${expected}）`)
    if (qty < expected && !reason) failField('reason', `實收比應退少 ${expected - qty}，請寫原因（例：破損、遺失）`)

    const out = must(db.stockTxns.find((x) => x.id === line.txnId), '調劑異動')
    // 每個批號已經退回多少（之前的點收）
    const back = new Map<string, number>()
    for (const r of line.returns ?? []) for (const id of r.txnIds) for (const m of db.stockTxns.find((x) => x.id === id)?.lots ?? []) back.set(m.lotNo, (back.get(m.lotNo) ?? 0) + m.qty)
    const t = now()
    const txnIds: string[] = []
    let left = qty
    for (const m of [...out.lots].reverse()) {
      if (!left) break
      const room = -m.qty - (back.get(m.lotNo) ?? 0)
      const n = Math.min(left, room)
      if (n <= 0) continue
      const lot = must(stockLoc.lots(line.drugId, out.locationId).find((l) => l.lotNo === m.lotNo), '批號')
      txnIds.push(postStock({ kind: 'in', type: 'return', drugId: line.drugId, locationId: out.locationId, qty: n, lot: { lotNo: lot.lotNo, expiry: lot.expiry }, ref: disp.no, reason: reason || undefined }, u.id, t).id)
      left -= n
    }
    if (left) fail('退藥數量超過當初發出的量', 'CONFLICT')
    const r: UdReturn = { at: t, by: u.id, marIds: p.marIds, expected, qty, ...(reason ? { reason } : {}), txnIds }
    ;(line.returns ??= []).push(r)
    const d = find.drug(line.drugId)
    audit('退藥點收', `${disp.no} ${d?.name ?? line.drugId}：應退 ${expected}、實收 ${qty}${reason ? `（${reason}）` : ''}`)
    return r
  })
}
