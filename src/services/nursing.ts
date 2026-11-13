// 護理站：病房病人總覽、給藥執行（MAR）、生命徵象、護理紀錄（Focus DAR）、交班、執行臨時醫囑。
// 「現在幾點」決定一筆給藥是待給、逾時還是太早——判斷集中在 nursing-rules 的純函式，
// 服務層用它把關（太早不能給），頁面用它上色，兩邊不會各算各的。
import type { HandoverNote, IpdOrder, MarRecord, NursingNote, VitalRecord } from '@/types'
import { commitIfPossible, db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, fieldErrors, must, mutate, query, requireUser, requirePermission } from './http'
import { ensureMar, marViews, orderView, type MarView, type OrderView } from './ipd'
import { doseUnitOf } from './billing'
import { wardStockOut } from './stock-ledger'
import { udStage } from './ud-work'
import { checkGivenAt, isAbnormal, MAR_EARLY_MIN, marUrgency, measuredThisShift, needsAck, openQuery, orderChange, recentShifts, shiftRange, type OrderChange, shiftInstanceOf, vitalInputProblem, vitalSpecs, type Shift, type ShiftInstance, type VitalKey } from './nursing-rules'
import { admissionView, find, nameOf, type AdmissionView } from './views'

export interface WardPatient extends AdmissionView {
  latestVitals?: VitalRecord
  /** 最新生命徵象中超出正常範圍的項目 */
  abnormal: string[]
  /** 已逾時未執行的給藥數 */
  overdueCount: number
  /** 目前在給藥時間窗內（可以給了）的給藥數 */
  dueCount: number
  /** 尚未執行的臨時醫囑數（檢驗、處置） */
  pendingStatCount: number
  /** 等著護理師核對的醫囑異動數（新開未簽收＋停止未確認） */
  unackedCount: number
  /** 這一班量過生命徵象沒有（沒量的在清單上標「本班未量」） */
  measuredThisShift: boolean
}

/** 最新一筆生命徵象：時間只到分鐘，同一分鐘量了兩次時取「後寫入」的那筆（以前排序取到先寫入的舊值） */
function latestVitalOf(admissionId: string): VitalRecord | undefined {
  return db.vitals.filter((v) => v.admissionId === admissionId).reduce<VitalRecord | undefined>((best, v) => (!best || v.at >= best.at ? v : best), undefined)
}

function admitted(admissionId: string) {
  const a = must(find.admission(admissionId), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return a
}

export function listWardPatients(ward: string): Promise<WardPatient[]> {
  return query(() => {
    const t = now()
    let changed = false
    const list = db.admissions
      .filter((a) => a.status === 'admitted' && a.bedId && find.bed(a.bedId)?.ward === ward)
      .map((a) => {
        changed = ensureMar(a.id, today()) || changed
        const latest = latestVitalOf(a.id)
        const pending = db.mar.filter((m) => m.admissionId === a.id && m.status === 'pending').map((m) => marUrgency(m.scheduledAt, t))
        return {
          ...admissionView(a),
          latestVitals: latest,
          abnormal: latest ? (Object.keys(vitalSpecs) as VitalKey[]).filter((k) => isAbnormal(k, latest[k])).map((k) => vitalSpecs[k].label) : [],
          overdueCount: pending.filter((u) => u === 'overdue').length,
          dueCount: pending.filter((u) => u === 'due').length,
          pendingStatCount: db.ipdOrders.filter((o) => o.admissionId === a.id && o.type === 'stat' && o.status === 'active' && o.category !== 'medication').length,
          unackedCount: db.ipdOrders.filter((o) => o.admissionId === a.id && needsAck(o)).length,
          measuredThisShift: measuredThisShift(latest?.at, t),
        }
      })
      .sort((x, y) => (x.bed?.bedNo ?? '').localeCompare(y.bed?.bedNo ?? ''))
    if (changed) commitIfPossible()
    return list
  })
}

// ---------- 本班待辦（全病房）----------
// 以前病房層級只有「逾時給藥 N」「待執行臨時醫囑 N」兩個總數，哪一床、哪個藥、幾點要給，
// 得一床一床點進去看。這裡把整個病房該做的事依時間排成一張清單；實際執行仍回到各病人的頁面
// （給藥有高警訊雙人核對、原因填寫，清單上若也能給藥，那些把關就得寫兩份）。

export type WardTaskKind = 'mar' | 'stat' | 'ack' | 'vitals'
export type WardTaskUrgency = 'overdue' | 'due' | 'todo' | 'upcoming'
export interface WardTask {
  id: string
  admissionId: string
  bedNo: string
  patientName: string
  kind: WardTaskKind
  urgency: WardTaskUrgency
  /** 預定時間（給藥）或開立時間（臨時醫囑） */
  at?: string
  text: string
}
const URGENCY_RANK: Record<WardTaskUrgency, number> = { overdue: 0, due: 1, todo: 2, upcoming: 3 }

export function listWardTasks(ward: string): Promise<WardTask[]> {
  return query(() => {
    const t = now()
    const { end } = shiftRange(t)
    const tasks: WardTask[] = []
    let changed = false
    for (const a of db.admissions.filter((x) => x.status === 'admitted' && x.bedId && find.bed(x.bedId)?.ward === ward)) {
      changed = ensureMar(a.id, today()) || changed
      const base = { admissionId: a.id, bedNo: find.bed(a.bedId!)?.bedNo ?? '', patientName: nameOf.patient(a.patientId) }
      // 給藥：逾時、可給的一律列（不論哪一班留下的，也包括 15:30 時已可提早給的 16:10）；
      // 還沒到時間的只列到這一班結束——和病人清單的「逾時／待給」數字同一個範圍
      for (const m of db.mar.filter((x) => x.admissionId === a.id && x.status === 'pending')) {
        const urgency = marUrgency(m.scheduledAt, t)
        if (urgency === 'upcoming' && m.scheduledAt >= end) continue
        const o = db.ipdOrders.find((x) => x.id === m.orderId)
        const d = o?.drugId ? find.drug(o.drugId) : undefined
        tasks.push({ ...base, id: m.id, kind: 'mar', urgency, at: m.scheduledAt, text: `${o?.content ?? ''}${o?.dose ? ` ${o.dose} ${d ? doseUnitOf(d) : ''}` : ''}${o?.route ? `・${o.route}` : ''}` })
      }
      // 臨時醫囑（檢驗、處置）：開了就該做
      for (const o of db.ipdOrders.filter((x) => x.admissionId === a.id && x.type === 'stat' && x.status === 'active' && x.category !== 'medication')) {
        tasks.push({ ...base, id: o.id, kind: 'stat', urgency: 'due', at: o.startAt, text: `臨時醫囑：${o.content}` })
      }
      const unacked = db.ipdOrders.filter((o) => o.admissionId === a.id && needsAck(o)).length
      if (unacked) tasks.push({ ...base, id: `ack-${a.id}`, kind: 'ack', urgency: 'todo', text: `${unacked} 項醫囑異動待核對` })
      // 這一班還沒量過生命徵象：和病人清單的「本班未量」同一條規則（measuredThisShift）
      if (!measuredThisShift(latestVitalOf(a.id)?.at, t)) {
        tasks.push({ ...base, id: `vs-${a.id}`, kind: 'vitals', urgency: 'todo', text: '本班尚未測量生命徵象' })
      }
    }
    if (changed) commitIfPossible()
    return tasks.sort((x, y) => URGENCY_RANK[x.urgency] - URGENCY_RANK[y.urgency] || (x.at ?? '9').localeCompare(y.at ?? '9') || x.bedNo.localeCompare(y.bedNo))
  })
}

export interface PrnView extends OrderView {
  /** 上次給藥時間：PRN 藥品要避免短時間內重複給 */
  lastGivenAt?: string
}

/** 護理站給藥工作板（BFF）：某日排程 + PRN 藥品 + 待執行的臨時醫囑，一次取回，三塊資料不會彼此不同步 */
export interface MarBoard {
  mar: MarView[]
  prn: PrnView[]
  stat: OrderView[]
}

export function getMarBoard(admissionId: string, date: string): Promise<MarBoard> {
  return query(() => {
    if (ensureMar(admissionId, date)) commitIfPossible()
    const orders = db.ipdOrders.filter((o) => o.admissionId === admissionId && o.status === 'active')
    return {
      mar: marViews(admissionId, date),
      prn: orders
        .filter((o) => o.category === 'medication' && o.freq === 'PRN')
        .map((o) => ({
          ...orderView(o),
          lastGivenAt: db.mar.filter((m) => m.orderId === o.id && m.status === 'given').map((m) => m.executedAt ?? '').sort().pop(),
        })),
      stat: orders.filter((o) => o.type === 'stat' && o.category !== 'medication').map(orderView),
    }
  })
}

// ---------- 護理站的醫囑清單（唯讀）----------
// 以前護理站只看得到給藥排程、PRN、臨時非給藥醫囑；長期的護理醫囑（翻身 Q2H）、飲食（禁食）、處置，
// 護理師在任何頁面都看不到——醫師開了，執行的人卻不知道。

export type NursingOrderView = OrderView & {
  change: OrderChange | null
  needsAck: boolean
  /** 待醫師回覆的疑問（不能核對、給藥暫停） */
  pendingQuery?: { reason: string; byName: string; at: string }
  /** 醫師最近一次回覆（核對前要看到） */
  lastReply?: { reply: string; byName: string; at: string; resolution?: string }
}
export interface NursingOrderGroup {
  category: IpdOrder['category']
  label: string
  orders: NursingOrderView[]
}
const ORDER_GROUPS: { category: IpdOrder['category']; label: string }[] = [
  { category: 'diet', label: '飲食' },
  { category: 'nursing', label: '護理' },
  { category: 'procedure', label: '處置・檢查' },
  { category: 'medication', label: '用藥（給藥請至給藥紀錄）' },
]

/** 執行中的醫囑，加上 24 小時內停止或完成的（標示異動），依類別分組；飲食放最前面（禁食最要緊） */
export function listNursingOrders(admissionId: string): Promise<NursingOrderGroup[]> {
  return query(() => {
    const t = now()
    const shown = db.ipdOrders
      .filter((o) => o.admissionId === admissionId)
      .map((o) => {
        const q = openQuery(o)
        const answered = !q ? o.queries?.filter((x) => x.replyAt).at(-1) : undefined
        return {
          ...orderView(o),
          change: orderChange(o, t),
          needsAck: needsAck(o),
          ...(q ? { pendingQuery: { reason: q.reason, byName: nameOf.user(q.by), at: q.at } } : {}),
          ...(answered ? { lastReply: { reply: answered.reply ?? '', byName: nameOf.user(answered.replyBy), at: answered.replyAt!, resolution: answered.resolution } } : {}),
        }
      })
      // 還沒核對的停止醫囑即使超過 24 小時也要列出——沒人確認過，就還不能從清單上消失
      .filter((o) => o.status === 'active' || o.change || o.needsAck)
      // 執行中的在前；同一類裡新開的在前
      .sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active') || b.startAt.localeCompare(a.startAt))
    return ORDER_GROUPS.map((g) => ({ ...g, orders: shown.filter((o) => o.category === g.category) })).filter((g) => g.orders.length)
  })
}

/**
 * 核對醫囑：逐筆（orderIds 一筆）或整批（畫面上看得到的全部）核對「新開未簽收、停止未確認」的醫囑。
 * 只核對按下當時看得到的那幾筆：若醫師剛好又開了一筆，畫面還沒顯示，就不能一起被簽掉。
 * 有疑問、待醫師回覆的不能核對（整批核對時跳過並回報 skipped；單筆指定則擋下）。稽核記下核對了哪幾筆。
 */
export function ackOrders(admissionId: string, orderIds: string[]): Promise<{ count: number; skipped: number }> {
  return mutate(() => {
    const nurse = requireUser('nurse')
    admitted(admissionId)
    const t = now()
    const asked = db.ipdOrders.filter((o) => o.admissionId === admissionId && orderIds.includes(o.id) && needsAck(o))
    const targets = asked.filter((o) => !openQuery(o))
    if (asked.length && !targets.length) fail('這筆醫囑有疑問、待醫師回覆，回覆後才能核對', 'CONFLICT')
    if (!targets.length) fail('沒有需要核對的醫囑', 'CONFLICT')
    for (const o of targets) {
      if (o.status === 'active') Object.assign(o, { ackAt: t, ackBy: nurse.id })
      else Object.assign(o, { stopAckAt: t, stopAckBy: nurse.id })
    }
    audit('核對醫囑', targets.map((o) => `${o.status === 'active' ? '新' : '停'}：${o.content}`).join('、'))
    return { count: targets.length, skipped: asked.length - targets.length }
  })
}

/**
 * 有疑問、退回醫師：護理師對某筆執行中的醫囑提出疑問（寫原因）。醫師回覆前不能核對、給藥暫停
 * （緊急時可寫原因強制給藥）。已經核對過的也可以提（疑問可能在執行時才發現）。
 */
export function queryOrder(orderId: string, reason: string): Promise<{ ok: true }> {
  return mutate(() => {
    const nurse = requireUser('nurse')
    const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    admitted(o.admissionId)
    if (o.status !== 'active') fail('已停止或完成的醫囑不能再提疑問', 'CONFLICT')
    if (openQuery(o)) fail('這筆醫囑已有疑問、待醫師回覆', 'CONFLICT')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫疑問（例：劑量 1000mg 疑為 100mg）')
    o.queries = [...(o.queries ?? []), { by: nurse.id, at: now(), reason: why! }]
    audit('醫囑疑問', `${o.content}：${why}`)
    return { ok: true as const }
  })
}

/**
 * 執行給藥：given 給藥 / held 暫停 / refused 拒絕（後兩者須註明原因）。
 * 醫囑有疑問、待醫師回覆時，給藥要帶 force 並寫原因（例：醫師電話口頭確認、病人急需）——暫停、拒絕照常。
 * givenAt：補登實際給藥時間（只限 given）；不填就是現在。補登時 recordedAt 記下實際登打的時間。
 */
export function executeMar(marId: string, status: Exclude<MarRecord['status'], 'pending'>, note = '', givenAt?: string, force?: { reason: string }): Promise<MarRecord> {
  return mutate(() => {
    const nurse = requirePermission('mar.give')
    const m = must(db.mar.find((x) => x.id === marId), '給藥紀錄')
    admitted(m.admissionId)
    if (m.status !== 'pending') fail('此筆已執行', 'CONFLICT')
    if (status !== 'given' && !note.trim()) failField('note', '暫停或拒絕給藥需註明原因')
    const t = now()
    // 暫停、拒絕記的是「決定」，就是現在；只有給藥可以補登實際時間
    const at = status === 'given' && givenAt ? givenAt : t
    if (at !== t) {
      const problem = checkGivenAt(m.scheduledAt, at, t)
      if (problem) failField('givenAt', problem)
    }
    // 提早給藥是給藥錯誤的一種；「暫停」可以提前決定（例如術前禁食），所以只擋給藥
    if (status === 'given' && marUrgency(m.scheduledAt, at) === 'upcoming') {
      fail(`尚未到給藥時間（預定 ${m.scheduledAt.slice(11)}，最早可提前 ${MAR_EARLY_MIN} 分鐘）`)
    }
    const order = must(db.ipdOrders.find((o) => o.id === m.orderId), '醫囑')
    // 排程給藥的藥由住院藥局調劑送來（UD）：還沒調劑就是藥還沒到病房，不能記「已給」
    // 核對通過、送到病房才算（只調劑還在藥局核對中，藥也還沒到）
    if (status === 'given' && order.type === 'long' && udStage(m) !== 'verified') {
      fail(udStage(m) === 'prepared' ? `這一劑（${m.scheduledAt.slice(5)}）藥局已調劑、還在核對，核對送出後才能給` : `藥局尚未調劑這一劑（${m.scheduledAt.slice(5)}）：請聯絡住院藥局補調劑`, 'CONFLICT', 'ud')
    }
    // 暫停、拒絕本來就是「不給」，照常；只有給藥要過這一關
    const forced = status === 'given' ? holdForQuery(order, force) : undefined
    // 臨時（STAT）給藥用病房常備藥：給的時候扣住院藥局
    if (status === 'given' && order.type === 'stat') wardStockOut(order, admitted(m.admissionId).admitNo, nurse.id)
    const noteText = [note.trim(), forced ? `疑問期間仍給藥：${forced}` : ''].filter(Boolean).join('；')
    Object.assign(m, { status, note: noteText || undefined, executedAt: at, recordedAt: at !== t ? t : undefined, nurseId: nurse.id })
    // 臨時給藥醫囑執行後即完成；完成時間記在 stopAt（和非給藥的臨時醫囑一樣），護理站才看得出「已完成」與時間
    if (order.type === 'stat') {
      order.status = 'done'
      order.stopAt = at
    }
    audit(forced ? '疑問期間仍給藥' : '給藥', `${order.content} ${status}${at !== t ? `（補登 ${at.slice(11)}）` : ''}${noteText ? `：${noteText}` : ''}`)
    return m
  })
}

/** PRN（需要時）給藥：沒有排程，執行時直接新增一筆已給藥紀錄 */
export function givePrn(orderId: string, note: string, force?: { reason: string }): Promise<MarRecord> {
  return mutate(() => {
    const nurse = requirePermission('mar.give')
    const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    admitted(o.admissionId)
    if (o.status !== 'active' || o.freq !== 'PRN') fail('此醫囑不是有效的 PRN 給藥')
    if (!note.trim()) failField('note', '請註明給藥原因（例：體溫 38.5°C）')
    const forced = holdForQuery(o, force)
    // PRN 用病房常備藥：給的時候扣住院藥局
    wardStockOut(o, admitted(o.admissionId).admitNo, nurse.id)
    const t = now()
    const text = [note.trim(), forced ? `疑問期間仍給藥：${forced}` : ''].filter(Boolean).join('；')
    const m: MarRecord = { id: newId('MAR'), orderId: o.id, admissionId: o.admissionId, scheduledAt: t, status: 'given', executedAt: t, nurseId: nurse.id, note: text }
    db.mar.push(m)
    audit(forced ? '疑問期間仍給藥' : 'PRN 給藥', `${o.content}：${text}`)
    return m
  })
}

/**
 * 醫囑有疑問、待醫師回覆：執行要暫停。緊急時可帶 force（寫原因）強制執行，回傳那個原因（寫進紀錄與稽核）。
 * 沒有疑問回傳 undefined。給藥（排程、PRN）與臨時醫囑的執行共用這一條。
 */
function holdForQuery(o: IpdOrder, force?: { reason: string }): string | undefined {
  const q = openQuery(o)
  if (!q) return undefined
  const why = force?.reason?.trim()
  if (!why) fail(`這筆醫囑有疑問、待醫師回覆（${q.reason}）；執行暫停，緊急時請寫原因強制執行`, 'CONFLICT', 'query')
  return why
}

/** 執行臨時醫囑（檢驗、處置等非給藥） */
/** 回傳 { ok: true }：讓呼叫端分得出「成功」與「失敗被擋」（void 的話兩者都是 undefined） */
export function completeStatOrder(orderId: string, force?: { reason: string }): Promise<{ ok: true }> {
  return mutate(() => {
    requirePermission('mar.give')
    const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    admitted(o.admissionId)
    if (o.type !== 'stat' || o.status !== 'active') fail('此醫囑無需執行')
    if (o.category === 'medication') fail('給藥醫囑請由給藥紀錄執行')
    const forced = holdForQuery(o, force)
    o.status = 'done'
    o.stopAt = now()
    audit(forced ? '疑問期間仍執行' : '執行臨時醫囑', `${o.content}${forced ? `：${forced}` : ''}`)
    return { ok: true as const }
  })
}

// ---------- 生命徵象 ----------
export function listVitals(admissionId: string): Promise<VitalRecord[]> {
  return query(() => db.vitals.filter((v) => v.admissionId === admissionId).sort((a, b) => a.at.localeCompare(b.at)))
}

export type VitalInput = Omit<VitalRecord, 'id' | 'nurseId' | 'at'>

export function addVitals(input: VitalInput): Promise<VitalRecord> {
  return mutate(() => {
    const nurse = requireUser('nurse')
    const a = admitted(input.admissionId)
    const v: VitalRecord = { admissionId: a.id, id: newId('VS'), at: now(), nurseId: nurse.id }
    // 只收已知欄位、逐項檢查合理範圍（輸入錯誤直接擋下；「異常但合理」照常記錄）；所有錯誤一次標出
    const errs = fieldErrors()
    for (const k of Object.keys(vitalSpecs) as VitalKey[]) {
      const val = input[k]
      if (val === undefined || val === null || Number.isNaN(val)) continue
      const problem = vitalInputProblem(k, val)
      if (problem) errs.add(k, problem)
      v[k] = val
    }
    if (v.sbp !== undefined && v.dbp !== undefined && !errs.has('sbp') && v.dbp >= v.sbp) errs.add('dbp', '舒張壓應小於收縮壓')
    errs.done()
    if (Object.keys(v).length === 4) fail('請至少輸入一項生命徵象')
    db.vitals.push(v)
    audit('生命徵象', a.admitNo)
    return v
  })
}

// ---------- 護理紀錄 ----------
export function listNursingNotes(admissionId: string): Promise<(NursingNote & { nurseName: string })[]> {
  return query(() =>
    db.nursingNotes
      .filter((n) => n.admissionId === admissionId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((n) => ({ ...n, nurseName: nameOf.user(n.nurseId) })),
  )
}

export function addNursingNote(input: Pick<NursingNote, 'admissionId' | 'focus' | 'data' | 'action' | 'response'>): Promise<NursingNote> {
  return mutate(() => {
    const nurse = requireUser('nurse')
    admitted(input.admissionId)
    const n: NursingNote = {
      admissionId: input.admissionId,
      focus: input.focus.trim(),
      data: input.data.trim(),
      action: input.action.trim(),
      response: input.response.trim(),
      id: newId('NN'),
      at: now(),
      nurseId: nurse.id,
    }
    const errs = fieldErrors()
    if (!n.focus) errs.add('focus', '請輸入焦點（Focus）')
    if (!n.data && !n.action) errs.add('data', '資料（D）與措施（A）至少填寫一項')
    errs.done()
    db.nursingNotes.push(n)
    return n
  })
}

/** 補記反應（R）：只能補一次，已寫過的不能覆蓋（醫療紀錄只能增補，不能改寫） */
export function addNoteResponse(noteId: string, response: string): Promise<NursingNote> {
  return mutate(() => {
    requireUser('nurse')
    const n = must(db.nursingNotes.find((x) => x.id === noteId), '護理紀錄')
    if (n.response) fail('此紀錄已有反應（R），如需更正請另寫一筆', 'CONFLICT')
    if (!response.trim()) fail('請輸入反應內容')
    n.response = response.trim()
    n.respondedAt = now()
    return n
  })
}

// ---------- 交班 ----------
export type HandoverView = HandoverNote & { nurseName: string; patientName: string; bedNo: string }

/** 最近幾班的交班：預設 3 班（一整天），接班的人一定看得到上一班——不論中間是否跨過午夜 */
export const HANDOVER_SHIFTS = 3

export interface HandoverGroup extends ShiftInstance {
  items: HandoverView[]
}

/** 依「班」分組，最新的班在前（接班的人先看到上一班）；只回傳有紀錄的班 */
export function listHandovers(ward: string): Promise<HandoverGroup[]> {
  return query(() => {
    const shifts = recentShifts(now(), HANDOVER_SHIFTS)
    return shifts
      .map((s) => ({
        ...s,
        items: db.handovers
          .filter((h) => h.ward === ward && h.date === s.date && h.shift === s.shift)
          .map((h) => {
            const a = find.admission(h.admissionId)
            return { ...h, nurseName: nameOf.user(h.nurseId), patientName: a ? nameOf.patient(a.patientId) : '', bedNo: a?.bedId ? find.bed(a.bedId)?.bedNo ?? '' : '' }
          })
          // 交班是沿著病房一床一床走：依床號排，同一床再依時間
          .sort((a, b) => a.bedNo.localeCompare(b.bedNo) || a.createdAt.localeCompare(b.createdAt)),
      }))
      .filter((g) => g.items.length)
  })
}

export function addHandover(input: { ward: string; shift: Shift; admissionId: string; content: string }): Promise<HandoverNote> {
  return mutate(() => {
    const nurse = requireUser('nurse')
    const a = admitted(input.admissionId)
    if (find.bed(a.bedId ?? '')?.ward !== input.ward) fail('病人不在此病房')
    if (!input.content.trim()) failField('content', '交班內容不可空白')
    const t = now()
    // date 是「這一班開始的日期」：午夜後才寫的小夜交班，歸在前一天的小夜
    const h: HandoverNote = { ward: input.ward, shift: input.shift, admissionId: a.id, content: input.content.trim(), id: newId('HO'), date: shiftInstanceOf(input.shift, t).date, nurseId: nurse.id, createdAt: t }
    db.handovers.push(h)
    audit('交班', `${input.ward} ${input.shift}`)
    return h
  })
}
