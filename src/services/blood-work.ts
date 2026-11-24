// 輸血備血的內部工具（index 不匯出、不會被包成 API）：最近的檢驗值、本院驗過的血型、畫面資料、首頁待辦、住院帳單、血袋條碼核對。
// 規則在 blood-rules（純函式）；API 在 blood.ts
import type { Admission, BloodIssue, BloodRequest, BloodUnit, Patient, Procedure } from '@/types'
import { db } from '@/mock/db'
import { addMinutes, now, today } from '@/utils/date'
import { normalizeCode, type ScanResult } from './scan-rules'
import {
  activeMatches, BLOOD_PRODUCT_LABEL, BLOOD_STATUS_LABEL, BLOOD_THRESHOLD, bloodTypeText, ISSUE_STATE_LABEL, issueState, issueTodo, latestIssue, requestStatus, unitExpired,
  BLOOD_RETURN_MIN, type BloodRequestStatus, type IssueState, type IssueTodo,
} from './blood-rules'
import { find, nameOf } from './views'

/** 病人最近一次的某項檢驗值（Hb、PLT…）：依發報告時間 */
export function latestLabValue(patientId: string, code: string): { value: string; at: string } | undefined {
  let best: { value: string; at: string } | undefined
  for (const r of db.labReports) {
    if (r.patientId !== patientId) continue
    const v = r.values.find((x) => x.code === code)
    if (v && (!best || r.reportedAt > best.at)) best = { value: v.value, at: r.reportedAt }
  }
  return best
}

/** 本院血庫最近一次驗的血型（沒有＝本院沒驗過） */
export const latestTyping = (p?: Patient) => p?.bloodTypings?.at(-1)

export const requestOf = (id: string) => db.bloodRequests.find((r) => r.id === id)
export const unitOf = (id: string) => db.bloodUnits.find((u) => u.id === id)

export interface BloodUnitView {
  id: string
  unitNo: string
  product: BloodUnit['product']
  productLabel: string
  abo: BloodUnit['abo']
  rh: BloodUnit['rh']
  typeText: string
  volume: number
  expiresOn: string
  expired: boolean
  /** 3 天內到期 */
  expiringSoon: boolean
  status: BloodUnit['status']
  /** 配給誰（reserved、issued）：「BR20261117001 王小明」 */
  forText?: string
}

export function unitView(u: BloodUnit, t = today()): BloodUnitView {
  const r = u.requestId ? requestOf(u.requestId) : undefined
  return {
    id: u.id, unitNo: u.unitNo, product: u.product, productLabel: BLOOD_PRODUCT_LABEL[u.product], abo: u.abo, rh: u.rh, typeText: bloodTypeText(u), volume: u.volume,
    expiresOn: u.expiresOn, expired: unitExpired(u, t), expiringSoon: !unitExpired(u, t) && u.expiresOn <= addMinutes(`${t} 00:00`, 3 * 24 * 60).slice(0, 10), status: u.status,
    ...(r && (u.status === 'reserved' || u.status === 'issued') ? { forText: `${r.no} ${nameOf.patient(r.patientId)}` } : {}),
  }
}

export interface BloodIssueRow {
  unit: BloodUnitView
  /** 這袋目前：已配血待發（reserved）或最新一次發血的狀態 */
  state: IssueState | 'reserved'
  stateLabel: string
  issue?: BloodIssue & { issuedByName: string; nurseName?: string; witnessName?: string; ackByName?: string }
  todo: IssueTodo
  /** 血庫可以退回（發血後 30 分鐘內、還沒開始輸） */
  canReturn: boolean
  /** 輸血反應還沒有醫師確認 */
  reactionUnacked: boolean
}

export interface BloodRequestView {
  id: string
  no: string
  admissionId: string
  admitNo: string
  patientId: string
  patientName: string
  chartNo: string
  bedNo: string
  ward: string
  /** 這次住院的病人還在院 */
  admitted: boolean
  product: BloodRequest['product']
  productLabel: string
  units: number
  indication: string
  urgent: boolean
  /** 「Hb 6.8（11-16 07:05）」 */
  labText?: string
  overReason?: string
  orderedAt: string
  doctorName: string
  status: BloodRequestStatus
  statusLabel: string
  /** 這張單驗的血型 */
  typingText?: string
  typedByName?: string
  /** 病人本院先前驗過的血型（不含這張單驗的） */
  priorTypingText?: string
  /** 病人自述（病人資料）的血型：和本院驗的不同時提醒 */
  selfReported?: string
  rows: BloodIssueRow[]
  released: { unitNo: string; reason: string; at: string; byName: string }[]
  cancelled?: BloodRequest['cancelled'] & { byName: string }
}

function rowOf(r: BloodRequest, unitId: string, t: string): BloodIssueRow | undefined {
  const u = unitOf(unitId)
  if (!u) return undefined
  const i = latestIssue(r, unitId)
  const state = i ? issueState(i) : 'reserved'
  const tr = i?.transfusion
  return {
    unit: unitView(u, t.slice(0, 10)), state, stateLabel: ISSUE_STATE_LABEL[state],
    ...(i
      ? {
          issue: {
            ...i, issuedByName: nameOf.user(i.issuedBy),
            ...(tr ? { nurseName: nameOf.user(tr.nurseId), witnessName: nameOf.user(tr.witnessId) } : {}),
            ...(tr?.reaction?.ackBy ? { ackByName: nameOf.user(tr.reaction.ackBy) } : {}),
          },
        }
      : {}),
    todo: i ? issueTodo(i, t) : {},
    canReturn: state === 'issued' && t <= addMinutes(i!.issuedAt, BLOOD_RETURN_MIN),
    reactionUnacked: !!tr?.reaction && !tr.reaction.ackAt,
  }
}

export function requestView(r: BloodRequest, t: string = now()): BloodRequestView {
  const a = find.admission(r.admissionId)
  const p = find.patient(r.patientId)
  const bed = find.bed(a?.bedId ?? '')
  const st = requestStatus(r)
  const prior = (p?.bloodTypings ?? []).filter((x) => x.requestId !== r.id).at(-1)
  const th = BLOOD_THRESHOLD[r.product]
  return {
    id: r.id, no: r.no, admissionId: r.admissionId, admitNo: a?.admitNo ?? '', patientId: r.patientId, patientName: p?.name ?? '', chartNo: p?.chartNo ?? '',
    bedNo: bed?.bedNo ?? '', ward: bed?.ward ?? '', admitted: a?.status === 'admitted',
    product: r.product, productLabel: BLOOD_PRODUCT_LABEL[r.product], units: r.units, indication: r.indication, urgent: r.urgent,
    ...(r.lab ? { labText: `${th?.code ?? r.lab.code} ${r.lab.value}（${r.lab.at.slice(5, 16)}）` } : {}),
    ...(r.overReason ? { overReason: r.overReason } : {}),
    orderedAt: r.orderedAt, doctorName: nameOf.doctor(r.doctorId), status: st, statusLabel: BLOOD_STATUS_LABEL[st],
    ...(r.typing ? { typingText: bloodTypeText(r.typing), typedByName: nameOf.user(r.typing.by) } : {}),
    ...(prior ? { priorTypingText: `${bloodTypeText(prior)}（${prior.at.slice(0, 10)}）` } : {}),
    ...(p?.bloodType ? { selfReported: p.bloodType } : {}),
    rows: activeMatches(r).flatMap((c) => rowOf(r, c.unitId, t) ?? []),
    released: r.crossmatch.filter((c) => c.released).map((c) => ({ unitNo: unitOf(c.unitId)?.unitNo ?? c.unitId, reason: c.released!.reason, at: c.released!.at, byName: nameOf.user(c.released!.by) })),
    ...(r.cancelled ? { cancelled: { ...r.cancelled, byName: nameOf.user(r.cancelled.by) } } : {}),
  }
}

/** 住院中病人的備血單（首頁、護理站） */
const liveRequests = () => db.bloodRequests.filter((r) => find.admission(r.admissionId)?.status === 'admitted')

/** 血庫待辦：待驗血型或交叉試驗沒配滿的（沒取消、病人還在院）；急件另算 */
export function bloodLabCounts(): { work: number; urgent: number } {
  const list = liveRequests().filter((r) => ['typing', 'matching'].includes(requestStatus(r)))
  return { work: list.length, urgent: list.filter((r) => r.urgent).length }
}

/** 護理站（全院）：已發血待輸、輸血中 15 分鐘該量生命徵象（或已超過）的血袋數 */
export function transfusionTodoCount(t: string): number {
  // 和護理站病房清單、本班待辦同一個判斷（transfusionTasksOf）：輸血中但還沒到 15 分鐘的不算待處理
  const ids = new Set(liveRequests().map((r) => r.admissionId))
  return [...ids].reduce((n, id) => n + transfusionTasksOf(id, t).filter((x) => x.urgency !== 'todo').length, 0)
}

/** 輸血反應待醫師確認：主治是我、或備血單是我開的 */
export function reactionsToAck(doctorId: string): BloodRequest[] {
  return db.bloodRequests.filter((r) => {
    const a = find.admission(r.admissionId)
    if (!a || (a.doctorId !== doctorId && r.doctorId !== doctorId)) return false
    return r.issues.some((i) => i.transfusion?.reaction && !i.transfusion.reaction.ackAt)
  })
}

/** 這次住院有沒有還在發血、輸血中的血袋（出院前要處理完） */
export const transfusionOpen = (a: Admission) =>
  db.bloodRequests.some((r) => r.admissionId === a.id && activeMatches(r).some((c) => {
    const i = latestIssue(r, c.unitId)
    const s = i && issueState(i)
    return s === 'issued' || s === 'transfusing'
  }))

/**
 * 住院帳單：交叉試驗每做一袋算一次（之後釋出也算：試驗做了）；血品每發出一袋算一次（退回血庫的不算）。
 * 依試驗、發血那天的點數
 */
export function bloodFeeItems(admissionId: string): { proc: Procedure; qty: number; date: string }[] {
  const procOf = (k: Procedure['blood']) => db.procedures.find((p) => p.blood === k)
  const out: { proc: Procedure; qty: number; date: string }[] = []
  for (const r of db.bloodRequests.filter((x) => x.admissionId === admissionId)) {
    const cm = procOf('crossmatch')
    if (cm) for (const c of r.crossmatch) out.push({ proc: cm, qty: 1, date: c.at })
    const prod = procOf(r.product)
    if (prod) for (const i of r.issues) if (!i.returned) out.push({ proc: prod, qty: 1, date: i.issuedAt })
  }
  return out
}

/**
 * 血袋條碼：條碼＝血袋號。要是這張單、這一次發出的那一袋；
 * 掃到別人的血袋、還在血庫的血袋、不認得的條碼都擋，訊息說清楚是哪一袋
 */
export function checkUnitScan(code: string, target: BloodUnit): ScanResult {
  const c = normalizeCode(code)
  if (!c) return { ok: false, message: '請掃描血袋條碼' }
  if (c === normalizeCode(target.unitNo)) return { ok: true, message: `血袋正確：${target.unitNo} ${BLOOD_PRODUCT_LABEL[target.product]} ${bloodTypeText(target)}，效期 ${target.expiresOn}` }
  const hit = db.bloodUnits.find((u) => normalizeCode(u.unitNo) === c)
  if (!hit) return { ok: false, message: `不認得的血袋條碼（${c}）` }
  const r = hit.requestId ? requestOf(hit.requestId) : undefined
  // 同一位病人的另一袋：說清楚不是這一袋（只寫「配給某某」會讀成這位病人的、好像沒問題）
  const tr = target.requestId ? requestOf(target.requestId) : undefined
  if (r && tr && r.patientId === tr.patientId && (hit.status === 'issued' || hit.status === 'reserved'))
    return { ok: false, message: `血袋不對！${hit.unitNo} 是這位病人的另一袋（${hit.status === 'issued' ? '已發血' : '還在血庫、沒有發'}），這次要輸的是 ${target.unitNo}` }
  if (r && (hit.status === 'issued' || hit.status === 'reserved'))
    return { ok: false, message: `血袋不對！${hit.unitNo} 是配給 ${nameOf.patient(r.patientId)}（${r.no}）的${BLOOD_PRODUCT_LABEL[hit.product]} ${bloodTypeText(hit)}` }
  return { ok: false, message: `血袋不對！${hit.unitNo} 沒有發給這位病人（${BLOOD_PRODUCT_LABEL[hit.product]} ${bloodTypeText(hit)}）` }
}

/** 還在血庫（已配血待發、退回的）的血袋全部釋出；出院、取消用 */
export function releaseAll(r: BloodRequest, by: string, reason: string, t: string): void {
  for (const c of activeMatches(r)) {
    const i = latestIssue(r, c.unitId)
    const s = i ? issueState(i) : 'reserved'
    if (s !== 'reserved' && s !== 'returned') continue
    c.released = { at: t, by, reason }
    const unit = unitOf(c.unitId)
    if (unit && unit.status === 'reserved') {
      unit.status = 'available'
      delete unit.requestId
    }
  }
}


/**
 * 護理站：這位病人現在的輸血（病房清單的標記、本班待辦共用同一個判斷）——
 * 已發血待輸（超過 30 分鐘標逾時）、輸血中（15 分鐘生命徵象到了或逾時、超過 4 小時）
 */
export function transfusionTasksOf(admissionId: string, t: string): { id: string; state: 'issued' | 'transfusing'; urgency: 'overdue' | 'due' | 'todo'; at: string; text: string }[] {
  const out: ReturnType<typeof transfusionTasksOf> = []
  for (const r of db.bloodRequests.filter((x) => x.admissionId === admissionId))
    for (const c of activeMatches(r)) {
      const i = latestIssue(r, c.unitId)
      const s = i && issueState(i)
      if (!i || (s !== 'issued' && s !== 'transfusing')) continue
      const u = unitOf(c.unitId)
      const what = `${u?.unitNo ?? ''} ${BLOOD_PRODUCT_LABEL[r.product]}`
      const todo = issueTodo(i, t)
      if (s === 'issued') out.push({ id: `bl-${r.id}-${c.unitId}`, state: s, urgency: todo.lateStart ? 'overdue' : 'due', at: i.issuedAt, text: `已發血、待床邊核對輸血：${what}${todo.lateStart ? '（發血已超過 30 分鐘）' : ''}` })
      else out.push({ id: `bl-${r.id}-${c.unitId}`, state: s, urgency: todo.check === 'overdue' || todo.long ? 'overdue' : todo.check === 'due' ? 'due' : 'todo', at: todo.checkDueAt ?? i.transfusion!.startAt, text: `輸血中：${what}${todo.check ? '・量 15 分鐘生命徵象' : ''}${todo.long ? '・已超過 4 小時' : ''}` })
    }
  return out
}
