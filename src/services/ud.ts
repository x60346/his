// 住院藥局：UD（Unit Dose）調劑、核對與退藥。
//
// 流程：
//   - 每日調劑：藥師每天下午把「明天整天」的劑量調好（每位病人、每筆長期給藥醫囑一行）；補調劑：今天才開、還沒調劑的今天劑量
//   - 調劑只是備藥、不扣帳；核對以「一位病人的藥盒」為單位，通過才扣住院藥局、送病房，護理師才能給（nursing.executeMar 擋）。
//     雙人核對設定開啟時調劑的人不能自己核對（ud-rules.udVerifyBlocker，和門診共用同一個設定）；核對發現錯誤可退回重調
//   - PRN、STAT 用病房常備，給藥時直接扣（stock-ledger.wardStockOut），不經這裡
//   - 退藥：發出去但不會給的劑量（暫停、拒絕、醫囑停止、出院）→ 護理站「送回藥局」→ 藥師點收入庫（只能點收已送回的）；
//     實收比應退少要寫原因（破損、遺失）。退回原本發出的那幾個批號
//
// 頁面送出的是「畫面上看得到的那幾劑」（marIds）：藥師按下前醫師剛好又開的新醫囑，不會被一起調劑——
// 和護理師核對醫囑同一個原則。
import type { MarRecord, UdBox, UdDispense, UdLine, UdReturn } from '@/types'
import { commitIfPossible, db, newId, nextCounter } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failFields, failField, must, mutate, query, requireUser } from './http'
import { ensureMar } from './ipd'
import { doseUnitOf } from './billing'
import { openQuery } from './nursing-rules'
import { postStock } from './stock-ledger'
import { usableQty } from './stock-rules'
import { checkUdIssue, UD_RETURN_CAUSE, udPerDose, udVerifyBlocker, type UdReturnCause } from './ud-rules'
import { pendingReturn, udBoxWard, udCandidate, udLineHome, type PendingReturn } from './ud-work'
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

/** 待核對的藥盒（一位病人） */
export interface UdVerifyBox {
  dispenseId: string
  no: string
  kind: UdDispense['kind']
  admissionId: string
  bedNo: string
  patientName: string
  allergies: string[]
  preparedByName: string
  preparedAt: string
  /** 雙人核對開啟、而我就是調劑的人：先說清楚（服務層也擋） */
  blocked?: string
  lines: { lineId: string; drugName: string; spec: string; dose: number; doseUnit: string; freqLabel: string; route: string; times: string[]; qty: number; unit: string; highAlert: boolean }[]
}

export interface UdReturnRow {
  dispenseId: string
  lineId: string
  no: string
  dispensedAt: string
  admissionId: string
  admitNo: string
  bedNo: string
  ward: string
  patientName: string
  /** 病人已出院（剩藥一樣要送回） */
  discharged: boolean
  drugName: string
  unit: string
  /** 應退的量（調劑單位） */
  expected: number
  doses: number
  /** 原因摘要：「暫停給藥 1、醫囑停止 2」 */
  causes: string
  /** 病房最後一次送回的時間與人（已送回的才有） */
  sentAt?: string
  sentByName?: string
}

export interface UdDispenseView {
  id: string
  no: string
  kind: UdDispense['kind']
  dispensedAt: string
  dispensedByName: string
  patients: number
  /** 已核對送出的病人數（其餘待核對或退回重調） */
  verified: number
  lines: number
  returned: number
}

export interface UdWork {
  locationId: string
  locationName: string
  today: string
  tomorrow: string
  /** 補調劑：今天（含更早）還沒調劑的劑量——醫囑今天才開的、或漏調的、退回重調的 */
  extra: UdWorkGroup[]
  /** 每日調劑：明天整天 */
  daily: UdWorkGroup[]
  /** 已調劑、待核對的藥盒 */
  verify: UdVerifyBox[]
  /** 病房已送回、待點收 */
  returns: UdReturnRow[]
  /** 病房還沒送回的（參考：可以打電話催） */
  awaitingWard: UdReturnRow[]
  /** 最近的調劑紀錄 */
  recent: UdDispenseView[]
  /** 病房點收時回報不符、藥局還沒處理的藥盒 */
  issues: UdIssueRow[]
}

/** 點收不符的藥盒（藥局處理清單、護理站「已回報」都用這個） */
export interface UdIssueRow {
  dispenseId: string
  no: string
  admissionId: string
  ward: string
  bedNo: string
  patientName: string
  cause: string
  note?: string
  reportedByName: string
  reportedAt: string
  /** 這盒的藥（讓藥師知道要補什麼） */
  items: string[]
  /** 這盒每一行（處理時可以逐行補發） */
  lines: { lineId: string; drugName: string; unit: string; qty: number }[]
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

function verifyBoxes(userId: string): UdVerifyBox[] {
  const twoPerson = !!db.securitySettings?.twoPersonDispense
  const out: UdVerifyBox[] = []
  for (const u of db.udDispenses) {
    for (const b of u.boxes.filter((x) => x.status === 'prepared')) {
      const a = find.admission(b.admissionId)
      const why = udVerifyBlocker(u.dispensedBy, userId, twoPerson)
      out.push({
        dispenseId: u.id,
        no: u.no,
        kind: u.kind,
        admissionId: b.admissionId,
        bedNo: a?.bedId ? find.bed(a.bedId)?.bedNo ?? '' : '',
        patientName: nameOf.patient(a?.patientId),
        allergies: find.patient(a?.patientId ?? '')?.allergies ?? [],
        preparedByName: nameOf.user(u.dispensedBy),
        preparedAt: u.dispensedAt,
        ...(why ? { blocked: why } : {}),
        lines: u.lines.filter((l) => l.admissionId === b.admissionId).map((l) => {
          const o = db.ipdOrders.find((x) => x.id === l.orderId)
          const d = find.drug(l.drugId)
          return {
            lineId: l.id,
            drugName: d?.name ?? l.drugId,
            spec: d?.spec ?? '',
            dose: o?.dose ?? 0,
            doseUnit: d ? doseUnitOf(d) : '',
            freqLabel: find.freq(o?.freq ?? '')?.label ?? o?.freq ?? '',
            route: o?.route ?? '',
            times: l.marIds.map((id) => db.mar.find((m) => m.id === id)?.scheduledAt.slice(5)).filter((x): x is string => !!x),
            qty: l.qty,
            unit: d?.unit ?? '',
            highAlert: d?.highAlert ?? false,
          }
        }),
      })
    }
  }
  return out.sort((x, y) => x.preparedAt.localeCompare(y.preparedAt) || x.bedNo.localeCompare(y.bedNo))
}

/** 待退藥的列（which：sent 已送回待點收、waiting 病房還沒送回）；ward 有給就只列那個病房的 */
function returnRows(which: 'sent' | 'waiting', ward?: string): UdReturnRow[] {
  const rows: UdReturnRow[] = []
  for (const u of db.udDispenses) {
    for (const l of u.lines) {
      const p: PendingReturn = pendingReturn(l)[which]
      if (!p.marIds.length) continue
      const a = find.admission(l.admissionId)
      const bed = a?.bedId ? find.bed(a.bedId) : undefined
      if (ward && bed?.ward !== ward) continue
      const d = find.drug(l.drugId)
      const count = new Map<UdReturnCause, number>()
      for (const c of p.causes) count.set(c, (count.get(c) ?? 0) + 1)
      const lastSend = l.sendBacks?.at(-1)
      rows.push({
        dispenseId: u.id,
        lineId: l.id,
        no: u.no,
        dispensedAt: u.dispensedAt,
        admissionId: l.admissionId,
        admitNo: a?.admitNo ?? '',
        bedNo: bed?.bedNo ?? '',
        ward: bed?.ward ?? '',
        patientName: nameOf.patient(a?.patientId),
        discharged: a?.status === 'discharged',
        drugName: d?.name ?? l.drugId,
        unit: d?.unit ?? '',
        expected: l.perDose! * p.marIds.length,
        doses: p.marIds.length,
        causes: [...count.entries()].map(([c, n]) => `${UD_RETURN_CAUSE[c]} ${n}`).join('、'),
        ...(which === 'sent' && lastSend ? { sentAt: lastSend.at, sentByName: nameOf.user(lastSend.by) } : {}),
      })
    }
  }
  return rows.sort((x, y) => x.dispensedAt.localeCompare(y.dispensedAt) || x.bedNo.localeCompare(y.bedNo))
}

/** 藥師的住院調劑工作清單：補調劑（今天）、每日調劑（明天）、待核對、待退藥、最近的調劑 */
export function getUdWork(): Promise<UdWork> {
  return query(() => {
    const u = requireUser('pharmacist')
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
      verify: verifyBoxes(u.id),
      returns: returnRows('sent'),
      awaitingWard: returnRows('waiting'),
      issues: issueRows(),
      recent: [...db.udDispenses]
        .sort((x, y) => y.dispensedAt.localeCompare(x.dispensedAt))
        .slice(0, 8)
        .map((x) => ({
          id: x.id,
          no: x.no,
          kind: x.kind,
          dispensedAt: x.dispensedAt,
          dispensedByName: nameOf.user(x.dispensedBy),
          patients: x.boxes.length,
          verified: x.boxes.filter((b) => b.status === 'verified').length,
          lines: x.lines.length,
          returned: x.lines.reduce((n, l) => n + (l.returns ?? []).reduce((s, r) => s + r.qty, 0), 0),
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
 * 調劑（備藥）：那幾劑標上「已調劑、待核對」（不再列在待調劑），還不扣帳——核對通過才扣、送病房。
 * 可用量先檢查一次（同一種藥合計），不夠就不讓調，免得核對時才發現。
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
    // 同一種藥合計夠不夠（還沒核對的其他調劑也要算進去：它們核對時才扣）
    const holding = new Map<string, number>()
    for (const x of db.udDispenses) for (const l of x.lines) if (x.boxes.find((b) => b.admissionId === l.admissionId)?.status === 'prepared') holding.set(l.drugId, (holding.get(l.drugId) ?? 0) + l.qty)
    const need = new Map<string, number>()
    for (const p of plan) need.set(p.d.id, (need.get(p.d.id) ?? 0) + p.qty)
    for (const p of plan) {
      const avail = usableQty(stockLoc.lots(p.d.id, loc.id), today()) - (holding.get(p.d.id) ?? 0)
      if (need.get(p.d.id)! > avail && !errors[`qty.${p.o.id}`]) errors[`qty.${p.o.id}`] = `${p.d.name}${loc.name}可用不足（需 ${need.get(p.d.id)}，可用 ${Math.max(0, avail)}${holding.get(p.d.id) ? '，已扣除其他待核對的' : ''}）`
    }
    failFields(errors)

    const no = `UD${t.slice(0, 10).replace(/-/g, '')}-${String(nextCounter(`ud:${t.slice(0, 10)}`)).padStart(2, '0')}`
    const lines: UdLine[] = plan.map((p) => {
      const line: UdLine = { id: newId('UDL'), admissionId: p.o.admissionId, orderId: p.o.id, drugId: p.d.id, marIds: p.ms.map((m) => m.id), qty: p.qty, ...(p.per ? { perDose: p.per } : {}) }
      for (const m of p.ms) m.udLineId = line.id
      return line
    })
    // 藥盒記下送去哪個病房（調劑當下病人所在的）：之後轉床，藥盒還是在原病房等點收
    const boxes: UdBox[] = [...new Set(lines.map((l) => l.admissionId))].map((admissionId) => {
      const a = find.admission(admissionId)
      const ward = a?.bedId ? find.bed(a.bedId)?.ward : undefined
      return { admissionId, status: 'prepared', ...(ward ? { ward } : {}) }
    })
    db.udDispenses.push({ id: newId('UD'), no, locationId: loc.id, kind: input.kind, dispensedBy: u.id, dispensedAt: t, boxes, lines })
    audit('住院調劑', `${no} ${input.kind === 'daily' ? '每日調劑（明日）' : '補調劑'}：${boxes.length} 位病人、${lines.length} 項，待核對`)
    return { no, patients: boxes.length, lines: lines.length }
  })
}

function boxOf(dispenseId: string, admissionId: string) {
  const disp = must(db.udDispenses.find((x) => x.id === dispenseId), '調劑紀錄')
  const box = must(disp.boxes.find((b) => b.admissionId === admissionId), '藥盒')
  if (box.status !== 'prepared') fail(box.status === 'verified' ? '這位病人的藥已核對送出' : '這位病人的藥已退回重調', 'CONFLICT')
  return { disp, box, lines: disp.lines.filter((l) => l.admissionId === admissionId) }
}

/**
 * 核對通過（一位病人的藥盒）：扣住院藥局（任一藥不足就整盒不扣）、送病房，護理師才能給。
 * 調劑之後醫囑被停止、排程被刪的那幾劑不發（從這一行拿掉、不扣）
 */
export function verifyUdBox(dispenseId: string, admissionId: string): Promise<{ no: string; patientName: string; lines: number }> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const { disp, box, lines } = boxOf(dispenseId, admissionId)
    const why = udVerifyBlocker(disp.dispensedBy, u.id, !!db.securitySettings?.twoPersonDispense)
    if (why) fail(why, 'CONFLICT')
    const t = now()
    let sent = 0
    for (const l of lines) {
      const alive = l.marIds.filter((id) => db.mar.some((m) => m.id === id && m.status === 'pending'))
      if (alive.length !== l.marIds.length) {
        l.marIds = alive
        if (l.perDose) l.qty = l.perDose * alive.length
        else if (!alive.length) l.qty = 0
      }
      if (l.qty > 0) {
        l.txnId = postStock({ kind: 'out', type: 'dispense', drugId: l.drugId, locationId: disp.locationId, qty: l.qty, ref: disp.no }, u.id, t).id
        sent++
      }
    }
    Object.assign(box, { status: 'verified', verifiedBy: u.id, verifiedAt: t })
    const name = nameOf.patient(find.admission(admissionId)?.patientId)
    audit('住院調劑核對', `${disp.no} ${name}：${lines.length} 項，送病房`)
    return { no: disp.no, patientName: name, lines: sent }
  })
}

/** 核對發現錯誤：退回重調（寫原因）。這位病人的那幾劑回到待調劑，不扣帳 */
export function rejectUdBox(dispenseId: string, admissionId: string, reason: string): Promise<{ no: string }> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const { disp, box, lines } = boxOf(dispenseId, admissionId)
    if (!reason?.trim()) failField('reason', '請寫退回原因（例：劑量放錯、少一顆）')
    for (const l of lines) for (const m of db.mar.filter((x) => x.udLineId === l.id)) delete m.udLineId
    Object.assign(box, { status: 'rejected', rejectedBy: u.id, rejectedAt: now(), rejectReason: reason.trim() })
    audit('住院調劑退回重調', `${disp.no} ${nameOf.patient(find.admission(admissionId)?.patientId)}：${reason.trim()}`)
    return { no: disp.no }
  })
}

// ---------- 退藥：病房送回 → 藥局點收 ----------

/** 護理站：這個病房要送回藥局的（含已出院病人的剩藥） */
export function listWardUdReturns(ward: string): Promise<UdReturnRow[]> {
  return query(() => {
    requireUser('nurse')
    return returnRows('waiting', ward)
  })
}

/** 護理站「送回藥局」：這幾行目前要退的劑量全部送回（藥師點收時再核實數量） */
export function sendBackUd(lineIds: string[]): Promise<{ lines: number; doses: number }> {
  return mutate(() => {
    const u = requireUser('nurse')
    const ids = [...new Set(lineIds ?? [])]
    if (!ids.length) fail('沒有要送回的藥')
    const t = now()
    let doses = 0
    for (const id of ids) {
      const home = must(udLineHome(id), '調劑紀錄')
      const waiting = pendingReturn(home.line).waiting.marIds
      if (!waiting.length) fail('有一項已經送回或不需要退了，請重新整理', 'CONFLICT')
      ;(home.line.sendBacks ??= []).push({ at: t, by: u.id, marIds: waiting })
      doses += waiting.length
    }
    audit('送回藥局', `${ids.length} 項、${doses} 劑`)
    return { lines: ids.length, doses }
  })
}

/**
 * 退藥點收：這一行病房已送回的劑量全部結清（還沒送回的不能點收）。實收可以比應退少（破損、遺失要寫原因），不能多。
 * 退回發出時的那幾個批號（從最後扣的那批開始退），效期跟著走；實收 0 就只結清、不入庫
 */
export function receiveUdReturn(lineId: string, input: { qty: number; reason?: string }): Promise<UdReturn> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const home = must(udLineHome(lineId), '調劑紀錄')
    const { disp, line } = home
    const p = pendingReturn(line)
    if (!p.sent.marIds.length) fail(p.waiting.marIds.length ? '病房還沒把這一項送回藥局（護理站「送回藥局」後才能點收）' : '這一項沒有要退的藥（可能已點收）', 'CONFLICT')
    const expected = line.perDose! * p.sent.marIds.length
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
    const r: UdReturn = { at: t, by: u.id, marIds: p.sent.marIds, expected, qty, ...(reason ? { reason } : {}), txnIds }
    ;(line.returns ??= []).push(r)
    const d = find.drug(line.drugId)
    audit('退藥點收', `${disp.no} ${d?.name ?? line.drugId}：應退 ${expected}、實收 ${qty}${reason ? `（${reason}）` : ''}`)
    return r
  })
}

// ---------- 藥車交接：核對送出 → 病房點收（逐盒）；不符回報藥局 ----------

const boxItems = (disp: UdDispense, admissionId: string) =>
  disp.lines
    .filter((l) => l.admissionId === admissionId && l.qty > 0)
    .map((l) => {
      const d = find.drug(l.drugId)
      return `${d?.name ?? l.drugId} ${l.qty} ${d?.unit ?? ''}`.trim()
    })

function bedNoOf(admissionId: string) {
  const a = find.admission(admissionId)
  return a?.bedId ? find.bed(a.bedId)?.bedNo ?? '' : ''
}

function issueRows(ward?: string): UdIssueRow[] {
  const rows: UdIssueRow[] = []
  for (const d of db.udDispenses)
    for (const b of d.boxes) {
      if (!b.issue || b.issue.resolvedAt) continue
      const w = udBoxWard(b)
      if (ward && w !== ward) continue
      rows.push({
        dispenseId: d.id, no: d.no, admissionId: b.admissionId, ward: w, bedNo: bedNoOf(b.admissionId),
        patientName: nameOf.patient(find.admission(b.admissionId)?.patientId),
        cause: b.issue.cause, ...(b.issue.note ? { note: b.issue.note } : {}),
        reportedByName: nameOf.user(b.issue.by), reportedAt: b.issue.at, items: boxItems(d, b.admissionId),
        lines: d.lines.filter((l) => l.admissionId === b.admissionId).map((l) => {
          const dr = find.drug(l.drugId)
          return { lineId: l.id, drugName: dr?.name ?? l.drugId, unit: dr?.unit ?? '', qty: l.qty }
        }),
      })
    }
  return rows.sort((x, y) => x.reportedAt.localeCompare(y.reportedAt))
}

/** 一車（一張調劑單送到這個病房的藥盒）：還沒點收的那幾盒 */
export interface UdCart {
  dispenseId: string
  no: string
  kind: UdDispense['kind']
  /** 最後一盒核對送出的時間（藥車出發） */
  sentAt: string
  boxes: { admissionId: string; bedNo: string; patientName: string; verifiedByName: string; items: string[] }[]
}

/** 護理站：這個病房待點收的藥車、已回報不符（藥局處理中）的藥盒 */
export function listWardUdCarts(ward: string): Promise<{ carts: UdCart[]; issues: UdIssueRow[] }> {
  return query(() => {
    requireUser('nurse')
    const carts: UdCart[] = []
    for (const d of db.udDispenses) {
      const boxes = d.boxes.filter((b) => b.status === 'verified' && !b.receivedAt && udBoxWard(b) === ward)
      if (!boxes.length) continue
      carts.push({
        dispenseId: d.id, no: d.no, kind: d.kind,
        sentAt: boxes.map((b) => b.verifiedAt ?? '').sort().at(-1)!,
        boxes: boxes
          .map((b) => ({ admissionId: b.admissionId, bedNo: bedNoOf(b.admissionId), patientName: nameOf.patient(find.admission(b.admissionId)?.patientId), verifiedByName: nameOf.user(b.verifiedBy), items: boxItems(d, b.admissionId) }))
          .sort((x, y) => x.bedNo.localeCompare(y.bedNo)),
      })
    }
    return { carts: carts.sort((x, y) => x.sentAt.localeCompare(y.sentAt)), issues: issueRows(ward) }
  })
}

function receivableBox(dispenseId: string, admissionId: string) {
  const disp = must(db.udDispenses.find((x) => x.id === dispenseId), '調劑紀錄')
  const box = must(disp.boxes.find((b) => b.admissionId === admissionId), '藥盒')
  if (box.status !== 'verified') fail('這一盒藥局還沒核對送出', 'CONFLICT')
  if (box.receivedAt) fail(`這一盒已由 ${nameOf.user(box.receivedBy)} 點收`, 'CONFLICT')
  return { disp, box }
}

/** 點收（勾了哪幾盒就點收哪幾盒——畫面上看得到的；藥車上沒有的就不要勾，改回報不符） */
export function receiveUdBoxes(dispenseId: string, admissionIds: string[]): Promise<{ no: string; boxes: number }> {
  return mutate(() => {
    const u = requireUser('nurse')
    const ids = [...new Set(admissionIds ?? [])]
    if (!ids.length) fail('請勾選要點收的藥盒')
    const t = now()
    let disp: UdDispense | undefined
    for (const id of ids) {
      const r = receivableBox(dispenseId, id)
      disp = r.disp
      Object.assign(r.box, { receivedBy: u.id, receivedAt: t })
    }
    audit('藥車點收', `${disp!.no} ${udBoxWard(disp!.boxes.find((b) => b.admissionId === ids[0])!)}：${ids.length} 盒`)
    return { no: disp!.no, boxes: ids.length }
  })
}

/**
 * 點收時發現不符：這一盒記下原因，藥局 UD 頁出現「病房回報」。帳不動（核對時已扣）；
 * 補藥走藥局現有的流程（重新調劑），處理完填說明。這一盒算「已到病房」，但給藥列會標「藥盒不符」直到藥局處理完
 */
export function reportUdBox(dispenseId: string, admissionId: string, input: { cause: string; note?: string }): Promise<{ no: string }> {
  return mutate(() => {
    const u = requireUser('nurse')
    const { disp, box } = receivableBox(dispenseId, admissionId)
    failFields(checkUdIssue(input))
    const t = now()
    const note = input.note?.trim()
    Object.assign(box, { receivedBy: u.id, receivedAt: t, issue: { cause: input.cause, ...(note ? { note } : {}), by: u.id, at: t } })
    audit('藥盒不符', `${disp.no} ${nameOf.patient(find.admission(admissionId)?.patientId)}：${input.cause}${note ? `（${note}）` : ''}`)
    return { no: disp.no }
  })
}

/**
 * 藥局處理病房回報的不符：寫處理說明（已補發、已更換、病房找到了…），需要時逐行補發。
 * 那幾劑已經在這張調劑單上（核對時扣過），**不會**再出現在補調劑——補發在這裡扣住院藥局（同一張單號），
 * 不然實際多拿出去的藥帳上沒有，要到盤點才發現短少。不夠扣就整筆不處理
 */
export function resolveUdIssue(dispenseId: string, admissionId: string, input: { resolution: string; resupply?: Record<string, number> }): Promise<{ no: string; resupplied: number }> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const disp = must(db.udDispenses.find((x) => x.id === dispenseId), '調劑紀錄')
    const box = must(disp.boxes.find((b) => b.admissionId === admissionId), '藥盒')
    if (!box.issue) fail('這一盒沒有回報不符')
    if (box.issue!.resolvedAt) fail(`已由 ${nameOf.user(box.issue!.resolvedBy)} 處理`, 'CONFLICT')
    const text = input.resolution?.trim()
    const errors: Record<string, string> = {}
    if (!text) errors.resolution = '請寫處理說明（例：已補發 1 顆、已更換藥盒）'
    const plan: { line: UdLine; qty: number }[] = []
    for (const [lineId, qty] of Object.entries(input.resupply ?? {})) {
      const line = disp.lines.find((l) => l.id === lineId && l.admissionId === admissionId)
      if (!line) fail('補發的品項不在這一盒', 'CONFLICT')
      if (!Number.isInteger(qty) || qty < 0) errors[`resupply.${lineId}`] = '補發數量需為 0 以上的整數'
      else if (qty > 0) plan.push({ line: line!, qty })
    }
    failFields(errors)
    const t = now()
    const txnIds = plan.map((p) => postStock({ kind: 'out', type: 'dispense', drugId: p.line.drugId, locationId: disp.locationId, qty: p.qty, ref: disp.no, reason: `藥盒不符補發（${box.issue!.cause}）` }, u.id, t).id)
    Object.assign(box.issue!, { resolvedBy: u.id, resolvedAt: t, resolution: text, ...(txnIds.length ? { resupplyTxnIds: txnIds } : {}) })
    const what = plan.map((p) => `${find.drug(p.line.drugId)?.name} ${p.qty}`).join('、')
    audit('藥盒不符處理', `${disp.no} ${nameOf.patient(find.admission(admissionId)?.patientId)}：${text}${what ? `（補發 ${what}）` : ''}`)
    return { no: disp.no, resupplied: plan.reduce((n, p) => n + p.qty, 0) }
  })
}
