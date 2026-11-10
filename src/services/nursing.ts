// 護理站：病房病人總覽、給藥執行（MAR）、生命徵象、護理紀錄（Focus DAR）、交班、執行臨時醫囑。
// 「現在幾點」決定一筆給藥是待給、逾時還是太早——判斷集中在 nursing-rules 的純函式，
// 服務層用它把關（太早不能給），頁面用它上色，兩邊不會各算各的。
import type { HandoverNote, MarRecord, NursingNote, VitalRecord } from '@/types'
import { commitIfPossible, db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, must, mutate, query, requireUser } from './http'
import { ensureMar, marViews, orderView, type MarView, type OrderView } from './ipd'
import { isAbnormal, MAR_EARLY_MIN, marUrgency, vitalInputProblem, vitalSpecs, type Shift, type VitalKey } from './nursing-rules'
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
        const latest = db.vitals.filter((v) => v.admissionId === a.id).sort((x, y) => y.at.localeCompare(x.at))[0]
        const pending = db.mar.filter((m) => m.admissionId === a.id && m.status === 'pending').map((m) => marUrgency(m.scheduledAt, t))
        return {
          ...admissionView(a),
          latestVitals: latest,
          abnormal: latest ? (Object.keys(vitalSpecs) as VitalKey[]).filter((k) => isAbnormal(k, latest[k])).map((k) => vitalSpecs[k].label) : [],
          overdueCount: pending.filter((u) => u === 'overdue').length,
          dueCount: pending.filter((u) => u === 'due').length,
          pendingStatCount: db.ipdOrders.filter((o) => o.admissionId === a.id && o.type === 'stat' && o.status === 'active' && o.category !== 'medication').length,
        }
      })
      .sort((x, y) => (x.bed?.bedNo ?? '').localeCompare(y.bed?.bedNo ?? ''))
    if (changed) commitIfPossible()
    return list
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

/** 執行給藥：given 給藥 / held 暫停 / refused 拒絕（後兩者須註明原因） */
export function executeMar(marId: string, status: Exclude<MarRecord['status'], 'pending'>, note = ''): Promise<MarRecord> {
  return mutate(() => {
    const nurse = requireUser('nurse')
    const m = must(db.mar.find((x) => x.id === marId), '給藥紀錄')
    admitted(m.admissionId)
    if (m.status !== 'pending') fail('此筆已執行', 'CONFLICT')
    if (status !== 'given' && !note.trim()) failField('note', '暫停或拒絕給藥需註明原因')
    // 提早給藥是給藥錯誤的一種；「暫停」可以提前決定（例如術前禁食），所以只擋給藥
    if (status === 'given' && marUrgency(m.scheduledAt, now()) === 'upcoming') {
      fail(`尚未到給藥時間（預定 ${m.scheduledAt.slice(11)}，最早可提前 ${MAR_EARLY_MIN} 分鐘）`)
    }
    const order = must(db.ipdOrders.find((o) => o.id === m.orderId), '醫囑')
    Object.assign(m, { status, note: note.trim() || undefined, executedAt: now(), nurseId: nurse.id })
    // 臨時給藥醫囑執行後即完成
    if (order.type === 'stat') order.status = 'done'
    audit('給藥', `${order.content} ${status}${note ? `：${note}` : ''}`)
    return m
  })
}

/** PRN（需要時）給藥：沒有排程，執行時直接新增一筆已給藥紀錄 */
export function givePrn(orderId: string, note: string): Promise<MarRecord> {
  return mutate(() => {
    const nurse = requireUser('nurse')
    const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    admitted(o.admissionId)
    if (o.status !== 'active' || o.freq !== 'PRN') fail('此醫囑不是有效的 PRN 給藥')
    if (!note.trim()) failField('note', '請註明給藥原因（例：體溫 38.5°C）')
    const t = now()
    const m: MarRecord = { id: newId('MAR'), orderId: o.id, admissionId: o.admissionId, scheduledAt: t, status: 'given', executedAt: t, nurseId: nurse.id, note: note.trim() }
    db.mar.push(m)
    audit('PRN 給藥', `${o.content}：${note}`)
    return m
  })
}

/** 執行臨時醫囑（檢驗、處置等非給藥） */
export function completeStatOrder(orderId: string): Promise<void> {
  return mutate(() => {
    requireUser('nurse')
    const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    admitted(o.admissionId)
    if (o.type !== 'stat' || o.status !== 'active') fail('此醫囑無需執行')
    if (o.category === 'medication') fail('給藥醫囑請由給藥紀錄執行')
    o.status = 'done'
    o.stopAt = now()
    audit('執行臨時醫囑', o.content)
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
    // 只收已知欄位、逐項檢查合理範圍（輸入錯誤直接擋下；「異常但合理」照常記錄）
    for (const k of Object.keys(vitalSpecs) as VitalKey[]) {
      const val = input[k]
      if (val === undefined || val === null || Number.isNaN(val)) continue
      const problem = vitalInputProblem(k, val)
      if (problem) failField(k, problem)
      v[k] = val
    }
    if (Object.keys(v).length === 4) fail('請至少輸入一項生命徵象')
    if (v.sbp !== undefined && v.dbp !== undefined && v.dbp >= v.sbp) failField('dbp', '舒張壓應小於收縮壓')
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
    if (!n.focus) failField('focus', '請輸入焦點（Focus）')
    if (!n.data && !n.action) failField('data', '資料（D）與措施（A）至少填寫一項')
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

export function listHandovers(ward: string, date: string): Promise<HandoverView[]> {
  return query(() =>
    db.handovers
      .filter((h) => h.ward === ward && h.date === date)
      .map((h) => {
        const a = find.admission(h.admissionId)
        return { ...h, nurseName: nameOf.user(h.nurseId), patientName: a ? nameOf.patient(a.patientId) : '', bedNo: a?.bedId ? find.bed(a.bedId)?.bedNo ?? '' : '' }
      })
      // 交班是沿著病房一床一床走：依床號排，同一床再依時間
      .sort((a, b) => a.bedNo.localeCompare(b.bedNo) || a.createdAt.localeCompare(b.createdAt)),
  )
}

export function addHandover(input: { ward: string; shift: Shift; admissionId: string; content: string }): Promise<HandoverNote> {
  return mutate(() => {
    const nurse = requireUser('nurse')
    const a = admitted(input.admissionId)
    if (find.bed(a.bedId ?? '')?.ward !== input.ward) fail('病人不在此病房')
    if (!input.content.trim()) failField('content', '交班內容不可空白')
    const t = now()
    const h: HandoverNote = { ward: input.ward, shift: input.shift, admissionId: a.id, content: input.content.trim(), id: newId('HO'), date: t.slice(0, 10), nurseId: nurse.id, createdAt: t }
    db.handovers.push(h)
    audit('交班', `${input.ward} ${input.shift}`)
    return h
  })
}
