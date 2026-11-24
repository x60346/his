// 輸血備血：醫師開備血單 → 血庫驗血型、交叉試驗配血、發血 → 護理師床邊掃腕帶與血袋、第二人核對、開始輸血
// → 15 分鐘量生命徵象 → 結束（或輸血反應立刻停止、通知醫師）。
// 規則在 blood-rules（純函式）、畫面資料與待辦在 blood-work（內部）。血袋是血庫自己的存量，不進藥品庫存帳
import type { Abo, BloodProduct, BloodRequest, BloodUnit, Rh, ScanSkipReason, TransfusionVitals, VitalRecord } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { addMinutes, now, today } from '@/utils/date'
import { audit, fail, failField, failFields, fieldErrors, must, mutate, query, requireUser } from './http'
import {
  ABO_TYPES, activeMatches, BLOOD_DEFAULTS, BLOOD_PRODUCT_LABEL, BLOOD_PRODUCTS, BLOOD_RETURN_MIN, BLOOD_CHECK_MIN, BLOOD_THRESHOLD, bloodCompatible, bloodTypeText, checkBloodInput,
  issueState, latestIssue, REACTION_SYMPTOMS, requestStatus, thresholdProblem, unitExpired,
} from './blood-rules'
import {
  checkUnitScan, latestLabValue, latestTyping, releaseAll, requestOf, requestView, unitOf, unitView, type BloodRequestView, type BloodUnitView,
} from './blood-work'
import { checkPatientScan, SCAN_SKIP_LABEL, type ScanResult } from './scan-rules'
import { allScanAdmissions, scanAdmission, scanDemoAssist, scanRequired } from './scan-work'
import { transfusionConsentOk } from './consent-rules'
import { consumeWitness, transfusionRef, witnessFor } from './witness-core'
import { vitalInputProblem } from './nursing-rules'
import { careRoleOf, requireCare } from './care-team'
import { find, nameOf } from './views'

// ---------- 病人的輸血（醫師住院醫囑、護理站分頁共用） ----------

export interface PatientBlood {
  admissionId: string
  patientName: string
  admitted: boolean
  /** 本院血庫驗過的血型（最近一次） */
  typingText?: string
  typingAt?: string
  /** 病人資料上的（自述）血型：不能拿來配血 */
  selfReported?: string
  /** 最近的 Hb、PLT（開備血單參考） */
  labs: { code: string; name: string; value: string; at: string; unit: string; over: boolean }[]
  requests: BloodRequestView[]
  /** 醫師：可以開備血單（本科主治、同科代理；會診醫師不行） */
  canOrder: boolean
  /** 有輸血反應還沒有醫師確認 */
  reactionsUnacked: number
}

export function patientBlood(admissionId: string): Promise<PatientBlood> {
  return query(() => {
    const u = requireUser('doctor', 'nurse', 'admin')
    const a = must(find.admission(admissionId), '住院紀錄')
    const p = find.patient(a.patientId)
    const t = now()
    const typing = latestTyping(p)
    const labs = (['rbc', 'plt'] as const).flatMap((k) => {
      const th = BLOOD_THRESHOLD[k]!
      const v = latestLabValue(a.patientId, th.code)
      return v ? [{ code: th.code, name: th.name, value: v.value, at: v.at, unit: th.unit, over: Number(v.value) > th.max }] : []
    })
    const requests = db.bloodRequests.filter((r) => r.admissionId === a.id).sort((x, y) => y.orderedAt.localeCompare(x.orderedAt)).map((r) => requestView(r, t))
    return {
      admissionId: a.id, patientName: p?.name ?? '', admitted: a.status === 'admitted',
      ...(typing ? { typingText: bloodTypeText(typing), typingAt: typing.at } : {}),
      ...(p?.bloodType ? { selfReported: p.bloodType } : {}),
      labs, requests,
      canOrder: u.role === 'doctor' && a.status === 'admitted' && careRoleOf(u.doctorId, a)?.kind === 'team',
      reactionsUnacked: requests.reduce((n, r) => n + r.rows.filter((x) => x.reactionUnacked).length, 0),
    }
  })
}

// ---------- 醫師：開立、取消、確認輸血反應 ----------

export interface BloodOrderInput {
  admissionId: string
  product: BloodProduct
  units: number
  indication: string
  urgent?: boolean
  /** 高於輸血門檻（或沒有近期檢驗）的理由 */
  overReason?: string
}

/** 開備血單：本科醫師（會診醫師不行）。高於門檻沒寫理由 → 欄位 overReason 錯誤（訊息講出檢驗值） */
export function orderBlood(input: BloodOrderInput): Promise<BloodRequestView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = must(find.admission(input.admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('只有住院中的病人可以開備血單', 'CONFLICT')
    requireCare(u.doctorId, a, '開備血單', { consult: false })
    const units = Number(input.units)
    const e = checkBloodInput({ product: input.product, units, indication: input.indication })
    const t = now()
    const th = BLOOD_THRESHOLD[input.product]
    const lab = th ? latestLabValue(a.patientId, th.code) : undefined
    const over = input.product in BLOOD_PRODUCT_LABEL ? thresholdProblem(input.product, lab, t) : ''
    const overReason = input.overReason?.trim() ?? ''
    if (over && !overReason) e.overReason = `${over}：請寫輸血理由`
    failFields(e)
    const d = t.slice(0, 10)
    const r: BloodRequest = {
      id: newId('BR'), no: `BR${d.replace(/-/g, '')}${String(nextCounter(`blood:${d}`)).padStart(3, '0')}`,
      admissionId: a.id, patientId: a.patientId, doctorId: u.doctorId!, product: input.product, units, indication: input.indication.trim(), urgent: !!input.urgent,
      ...(lab && th ? { lab: { code: th.code, value: lab.value, at: lab.at } } : {}),
      ...(over ? { overReason } : {}),
      orderedAt: t, crossmatch: [], issues: [],
    }
    db.bloodRequests.push(r)
    audit('開立備血單', `${r.no} ${a.admitNo} ${nameOf.patient(a.patientId)} ${BLOOD_PRODUCT_LABEL[r.product]} ${units} 單位${r.urgent ? '（急）' : ''}：${r.indication}${over ? `；${over}，理由：${overReason}` : ''}`)
    return requestView(r, t)
  })
}

/**
 * 取消備血單（不用了、開錯）：本科醫師、要原因。有血袋已發出還沒輸完（或輸血中）不能取消；
 * 配好的血袋釋出回可用（交叉試驗已做的照樣計費）
 */
export function cancelBloodRequest(requestId: string, reason: string): Promise<BloodRequestView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const r = must(requestOf(requestId), '備血單')
    requireCare(u.doctorId, must(find.admission(r.admissionId), '住院紀錄'), '取消備血單', { consult: false })
    if (r.cancelled) fail('這張備血單已經取消了', 'CONFLICT')
    const st = requestStatus(r)
    if (st === 'transfusing') fail('有血袋已發出或輸血中：輸完（或請血庫退回）才能取消', 'CONFLICT')
    if (st === 'done') fail('這張備血單已經輸完了', 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫取消原因')
    const t = now()
    releaseAll(r, u.id, `備血單取消：${reason.trim()}`, t)
    r.cancelled = { at: t, by: u.id, reason: reason.trim() }
    audit('取消備血單', `${r.no} ${nameOf.patient(r.patientId)}：${reason.trim()}`)
    return requestView(r, t)
  })
}

/** 醫師確認輸血反應（主治、同科或開單醫師）：寫處置（例：給 Diphenhydramine、送輸血反應檢查） */
export function ackTransfusionReaction(requestId: string, unitId: string, note: string): Promise<BloodRequestView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const r = must(requestOf(requestId), '備血單')
    const a = must(find.admission(r.admissionId), '住院紀錄')
    if (r.doctorId !== u.doctorId) requireCare(u.doctorId, a, '確認輸血反應', { consult: false })
    const rx = latestIssue(r, unitId)?.transfusion?.reaction
    if (!rx) fail('這袋沒有輸血反應', 'CONFLICT')
    if (rx!.ackAt) fail('已經確認過了', 'CONFLICT')
    if (!note?.trim()) failField('note', '請寫處置（例：已給抗組織胺、送輸血反應檢查、暫停輸血）')
    const t = now()
    Object.assign(rx!, { ackBy: u.id, ackAt: t, ackNote: note.trim() })
    audit('確認輸血反應', `${r.no} ${nameOf.patient(r.patientId)} 血袋 ${unitOf(unitId)?.unitNo}：${note.trim()}`)
    return requestView(r, t)
  })
}

// ---------- 血庫（醫檢師）：驗血型、配血、發血、退回、入庫、報廢 ----------

export interface BloodWork {
  /** 還沒完成的備血單（病人在院、沒取消）：急件、待驗血型、交叉試驗中在前 */
  requests: BloodRequestView[]
  /** 今天完成或取消的（最近 24 小時） */
  recent: BloodRequestView[]
  /** 血庫裡的血袋（可用、已配血、已發出未輸完） */
  units: BloodUnitView[]
  /** 可用量：血品×血型 */
  stock: { product: BloodProduct; productLabel: string; abo: Abo; rh: Rh; available: number; expiringSoon: number }[]
}

const ORDER: Record<string, number> = { typing: 0, matching: 1, ready: 2, transfusing: 3 }

export function listBloodWork(): Promise<BloodWork> {
  return query(() => {
    requireUser('lab', 'admin')
    const t = now()
    const views = db.bloodRequests.map((r) => requestView(r, t))
    const open = views.filter((v) => v.admitted && v.status !== 'cancelled' && v.status !== 'done')
      .sort((x, y) => Number(y.urgent) - Number(x.urgent) || ORDER[x.status] - ORDER[y.status] || x.orderedAt.localeCompare(y.orderedAt))
    const since = addMinutes(t, -24 * 60)
    const recent = views.filter((v) => !open.includes(v) && (v.cancelled?.at ?? lastAt(requestOf(v.id)!)) >= since).sort((x, y) => y.orderedAt.localeCompare(x.orderedAt))
    const units = db.bloodUnits.filter((u) => u.status !== 'scrapped' && u.status !== 'transfused').map((u) => unitView(u, t.slice(0, 10)))
      .sort((x, y) => BLOOD_PRODUCTS.indexOf(x.product) - BLOOD_PRODUCTS.indexOf(y.product) || x.expiresOn.localeCompare(y.expiresOn))
    const stock: BloodWork['stock'] = []
    for (const product of BLOOD_PRODUCTS)
      for (const abo of ABO_TYPES)
        for (const rh of ['+', '-'] as Rh[]) {
          const list = units.filter((u) => u.product === product && u.abo === abo && u.rh === rh && u.status === 'available' && !u.expired)
          if (list.length || rh === '+') stock.push({ product, productLabel: BLOOD_PRODUCT_LABEL[product], abo, rh, available: list.length, expiringSoon: list.filter((u) => u.expiringSoon).length })
        }
    return { requests: open, recent, units, stock }
  })
}
const lastAt = (r: BloodRequest) => [r.orderedAt, ...r.issues.flatMap((i) => [i.issuedAt, i.transfusion?.endAt ?? ''])].sort().at(-1)!

/** 驗血型：每張備血單重新抽血驗。和本院上次驗的不同 → 擋下（可能抽錯人的血，請重抽）；和病人自述的不同只提醒 */
export function recordBloodTyping(requestId: string, input: { abo: Abo; rh: Rh }): Promise<BloodRequestView & { warning?: string }> {
  return mutate(() => {
    const u = requireUser('lab')
    const r = openRequest(requestId)
    if (r.typing) fail('這張單已經驗過血型了', 'CONFLICT')
    const f = fieldErrors()
    if (!ABO_TYPES.includes(input.abo)) f.add('abo', '請選 ABO 血型')
    if (input.rh !== '+' && input.rh !== '-') f.add('rh', '請選 Rh')
    f.done()
    const p = must(find.patient(r.patientId), '病人')
    const prior = latestTyping(p)
    if (prior && (prior.abo !== input.abo || prior.rh !== input.rh))
      failField('abo', `和本院 ${prior.at.slice(0, 10)} 驗的 ${bloodTypeText(prior)} 不同：可能抽錯人的血，請重新抽血再驗（這次不登錄）`, 'CONFLICT')
    const t = now()
    r.typing = { abo: input.abo, rh: input.rh, by: u.id, at: t }
    ;(p.bloodTypings ??= []).push({ abo: input.abo, rh: input.rh, by: u.id, at: t, requestId: r.id })
    const warning = p.bloodType && p.bloodType !== input.abo ? `病人資料上的血型是 ${p.bloodType} 型（自述），和檢驗結果 ${input.abo} 型不同，請通知櫃台更正` : undefined
    audit('登錄血型', `${r.no} ${p.name}：${bloodTypeText(input)}${prior ? '（與先前相符）' : '（本院第一次）'}`)
    return { ...requestView(r, t), ...(warning ? { warning } : {}) }
  })
}

/** 交叉試驗可以用的血袋：同血品、相容、沒過期、可用；同型的在前，再依效期（先到期的先用） */
export function bloodCandidates(requestId: string): Promise<BloodUnitView[]> {
  return query(() => {
    requireUser('lab')
    const r = must(requestOf(requestId), '備血單')
    if (!r.typing) return []
    const d = today()
    return db.bloodUnits
      .filter((u) => u.product === r.product && u.status === 'available' && !unitExpired(u, d) && bloodCompatible(r.product, r.typing!, u).ok)
      .sort((x, y) => Number(y.abo === r.typing!.abo && y.rh === r.typing!.rh) - Number(x.abo === r.typing!.abo && x.rh === r.typing!.rh) || x.expiresOn.localeCompare(y.expiresOn))
      .map((u) => unitView(u, d))
  })
}

/** 交叉試驗配血：選的血袋要可用、相容、沒過期，最多配到單上的單位數 */
export function crossmatchBlood(requestId: string, unitIds: string[]): Promise<BloodRequestView> {
  return mutate(() => {
    const u = requireUser('lab')
    const r = openRequest(requestId)
    if (!r.typing) fail('請先驗血型', 'CONFLICT')
    const ids = [...new Set(unitIds ?? [])]
    if (!ids.length) failField('units', '請選要配的血袋')
    const left = r.units - activeMatches(r).length
    if (ids.length > left) failField('units', left ? `這張單還差 ${left} 單位，選了 ${ids.length} 袋` : '這張單已經配滿了')
    const t = now()
    for (const id of ids) {
      const unit = must(unitOf(id), '血袋')
      if (unit.product !== r.product) fail(`${unit.unitNo} 是${BLOOD_PRODUCT_LABEL[unit.product]}，這張單要的是${BLOOD_PRODUCT_LABEL[r.product]}`)
      if (unit.status !== 'available') fail(`${unit.unitNo} 不是可用的血袋（${unit.status === 'reserved' ? '已配給別人' : '已發出或用掉'}）`, 'CONFLICT')
      if (unitExpired(unit, t.slice(0, 10))) fail(`${unit.unitNo} 已過期（${unit.expiresOn}）`)
      const c = bloodCompatible(r.product, r.typing!, unit)
      if (!c.ok) fail(`${unit.unitNo}：${c.message}`)
      unit.status = 'reserved'
      unit.requestId = r.id
      r.crossmatch.push({ unitId: unit.id, by: u.id, at: t })
    }
    audit('交叉試驗配血', `${r.no} ${nameOf.patient(r.patientId)}：${ids.map((id) => unitOf(id)!.unitNo).join('、')}`)
    return requestView(r, t)
  })
}

/** 釋出一袋已配的血（交叉試驗不合、病人不需要了）：回到可用、要原因 */
export function releaseBloodUnit(requestId: string, unitId: string, reason: string): Promise<BloodRequestView> {
  return mutate(() => {
    const u = requireUser('lab')
    const r = must(requestOf(requestId), '備血單')
    const c = activeMatches(r).find((x) => x.unitId === unitId)
    if (!c) fail('這袋沒有配給這張單', 'CONFLICT')
    const i = latestIssue(r, unitId)
    const s = i ? issueState(i) : 'reserved'
    if (s !== 'reserved' && s !== 'returned') fail('這袋已經發出，不能釋出（30 分鐘內請先退回）', 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫釋出原因')
    const t = now()
    c!.released = { at: t, by: u.id, reason: reason.trim() }
    const unit = must(unitOf(unitId), '血袋')
    unit.status = 'available'
    delete unit.requestId
    audit('釋出配血', `${r.no} 血袋 ${unit.unitNo}：${reason.trim()}`)
    return requestView(r, t)
  })
}

/** 發血：配給這張單、還在血庫（沒發過或退回的）、沒過期；病人要在院 */
export function issueBlood(requestId: string, unitId: string): Promise<BloodRequestView> {
  return mutate(() => {
    const u = requireUser('lab')
    const r = openRequest(requestId)
    if (!activeMatches(r).some((c) => c.unitId === unitId)) fail('這袋沒有配給這張單', 'CONFLICT')
    const i = latestIssue(r, unitId)
    if (i && !i.returned) fail('這袋已經發出了', 'CONFLICT')
    const unit = must(unitOf(unitId), '血袋')
    const t = now()
    if (unitExpired(unit, t.slice(0, 10))) fail(`${unit.unitNo} 已過期（${unit.expiresOn}），請報廢後重新配血`)
    unit.status = 'issued'
    r.issues.push({ unitId, issuedAt: t, issuedBy: u.id })
    audit('發血', `${r.no} ${nameOf.patient(r.patientId)} 血袋 ${unit.unitNo} ${BLOOD_PRODUCT_LABEL[unit.product]} ${bloodTypeText(unit)}`)
    return requestView(r, t)
  })
}

/** 退回血庫：發血後 30 分鐘內、還沒開始輸；超過時間血袋不能再給別人用，只能報廢 */
export function returnBlood(requestId: string, unitId: string, reason: string): Promise<BloodRequestView> {
  return mutate(() => {
    const u = requireUser('lab')
    const r = must(requestOf(requestId), '備血單')
    const i = latestIssue(r, unitId)
    if (!i || issueState(i) !== 'issued') fail('這袋不是「已發血、待輸血」，不能退回', 'CONFLICT')
    const t = now()
    if (t > addMinutes(i!.issuedAt, BLOOD_RETURN_MIN)) fail(`發血超過 ${BLOOD_RETURN_MIN} 分鐘，不能退回血庫再用：請報廢`, 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫退回原因')
    i!.returned = { at: t, by: u.id, reason: reason.trim() }
    const unit = must(unitOf(unitId), '血袋')
    unit.status = 'reserved'
    audit('退回血庫', `${r.no} 血袋 ${unit.unitNo}：${reason.trim()}`)
    return requestView(r, t)
  })
}

export interface BloodReceiveInput {
  product: BloodProduct
  abo: Abo
  rh: Rh
  count: number
  expiresOn: string
  volume?: number
}

/** 血袋入庫（捐血中心送來的）：一次同血品同血型多袋，各給一個血袋號 */
export function receiveBloodUnits(input: BloodReceiveInput): Promise<BloodUnitView[]> {
  return mutate(() => {
    const u = requireUser('lab')
    const f = fieldErrors()
    if (!(input.product in BLOOD_PRODUCT_LABEL)) f.add('product', '請選血品')
    if (!ABO_TYPES.includes(input.abo)) f.add('abo', '請選 ABO 血型')
    if (input.rh !== '+' && input.rh !== '-') f.add('rh', '請選 Rh')
    const count = Number(input.count)
    if (!Number.isInteger(count) || count < 1 || count > 50) f.add('count', '袋數是 1–50')
    const d = today()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiresOn ?? '')) f.add('expiresOn', '請填效期')
    else if (input.expiresOn < d) f.add('expiresOn', '已經過期的血袋不能入庫')
    const volume = input.volume === undefined ? BLOOD_DEFAULTS[input.product]?.volume : Number(input.volume)
    if (!Number.isFinite(volume) || volume! < 20 || volume! > 600) f.add('volume', '容量是 20–600 ml')
    f.done()
    const t = now()
    const made: BloodUnit[] = []
    for (let k = 0; k < count; k++) {
      const unit: BloodUnit = {
        id: newId('BU'), unitNo: `TB${d.slice(2).replace(/-/g, '')}${String(nextCounter(`bloodunit:${d}`)).padStart(4, '0')}`,
        product: input.product, abo: input.abo, rh: input.rh, volume: volume!, expiresOn: input.expiresOn, receivedAt: t, receivedBy: u.id, status: 'available',
      }
      db.bloodUnits.push(unit)
      made.push(unit)
    }
    audit('血袋入庫', `${BLOOD_PRODUCT_LABEL[input.product]} ${bloodTypeText(input)} ${count} 袋（效期 ${input.expiresOn}）：${made[0].unitNo}～${made.at(-1)!.unitNo}`)
    return made.map((x) => unitView(x, d))
  })
}

/** 報廢（過期、破損、發出超過 30 分鐘沒用）：可用、已配血、已發出還沒開始輸的；已配血的從備血單釋出 */
export function scrapBloodUnit(unitId: string, reason: string): Promise<BloodUnitView> {
  return mutate(() => {
    const u = requireUser('lab')
    const unit = must(unitOf(unitId), '血袋')
    if (unit.status === 'scrapped' || unit.status === 'transfused') fail('這袋已經用掉或報廢了', 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫報廢原因（例：過期、血袋破損、發出超過 30 分鐘未使用）')
    const t = now()
    const r = unit.requestId ? requestOf(unit.requestId) : undefined
    if (r) {
      const i = latestIssue(r, unit.id)
      if (i && issueState(i) !== 'issued' && issueState(i) !== 'returned') fail('這袋已經開始輸了，不能報廢', 'CONFLICT')
      if (i && issueState(i) === 'issued') i.returned = { at: t, by: u.id, reason: `報廢：${reason.trim()}` }
      const c = activeMatches(r).find((x) => x.unitId === unit.id)
      if (c) c.released = { at: t, by: u.id, reason: `報廢：${reason.trim()}` }
    }
    unit.status = 'scrapped'
    delete unit.requestId
    unit.scrapped = { at: t, by: u.id, reason: reason.trim() }
    audit('血袋報廢', `${unit.unitNo} ${BLOOD_PRODUCT_LABEL[unit.product]} ${bloodTypeText(unit)}：${reason.trim()}${r ? `（原配給 ${r.no}）` : ''}`)
    return unitView(unit, t.slice(0, 10))
  })
}

function openRequest(requestId: string) {
  const r = must(requestOf(requestId), '備血單')
  if (r.cancelled) fail('這張備血單已經取消了', 'CONFLICT')
  if (find.admission(r.admissionId)?.status !== 'admitted') fail('病人已不在院', 'CONFLICT')
  return r
}

// ---------- 護理師：床邊核對、輸血、生命徵象、輸血反應 ----------

export type TransfusionVitalsInput = { temp?: number; pulse?: number; sbp?: number; dbp?: number }

/** 生命徵象：四項都要（體溫、脈搏、血壓）；同時寫進病人的生命徵象紀錄 */
function takeVitals(admissionId: string, kind: TransfusionVitals['kind'], v: TransfusionVitalsInput | undefined, by: string, t: string, required = true): TransfusionVitals | undefined {
  const keys = ['temp', 'pulse', 'sbp', 'dbp'] as const
  if (!required && keys.every((k) => v?.[k] === undefined || v?.[k] === null || Number.isNaN(v?.[k]))) return undefined
  const f = fieldErrors()
  for (const k of keys) {
    const x = v?.[k]
    if (x === undefined || x === null || Number.isNaN(x)) f.add(k, '必填')
    else {
      const p = vitalInputProblem(k, Number(x))
      if (p) f.add(k, p)
    }
  }
  if (!f.has('sbp') && !f.has('dbp') && Number(v!.dbp) >= Number(v!.sbp)) f.add('dbp', '舒張壓應小於收縮壓')
  f.done()
  const rec: TransfusionVitals = { at: t, kind, temp: Number(v!.temp), pulse: Number(v!.pulse), sbp: Number(v!.sbp), dbp: Number(v!.dbp), by }
  const vr: VitalRecord = { id: newId('VS'), admissionId, at: t, nurseId: by, temp: rec.temp, pulse: rec.pulse, sbp: rec.sbp, dbp: rec.dbp }
  db.vitals.push(vr)
  return rec
}

function issued(requestId: string, unitId: string) {
  const r = must(requestOf(requestId), '備血單')
  const a = must(find.admission(r.admissionId), '住院紀錄')
  if (a.status !== 'admitted') fail('病人已不在院', 'CONFLICT')
  const i = latestIssue(r, unitId)
  if (!i || i.returned) fail('這袋還沒發血（或已退回血庫）', 'CONFLICT')
  return { r, a, i: i!, unit: must(unitOf(unitId), '血袋') }
}

/** 掃描逐步核對（畫面用）：腕帶或血袋，不符記稽核（差點輸錯），不丟錯 */
export function bloodScanCheck(input: { requestId: string; unitId: string; kind: 'patient' | 'unit'; code: string }): Promise<ScanResult> {
  return mutate(() => {
    const u = requireUser('nurse')
    const { a, unit, r } = issued(input.requestId, input.unitId)
    const res = input.kind === 'patient' ? checkPatientScan(input.code, scanAdmission(a), allScanAdmissions()) : checkUnitScan(input.code, unit)
    if (!res.ok && String(input.code ?? '').trim()) audit('輸血掃描不符', `${r.no} ${nameOf.patient(a.patientId)} 血袋 ${unit.unitNo}：${res.message}（${u.name}）`)
    return res
  })
}

export interface BloodScanDemo {
  options: { kind: 'patient' | 'unit'; code: string; label: string }[]
}
/** 示範用模擬掃描：這位病人的腕帶、別人的腕帶、這一袋、別袋 */
export function bloodScanDemo(requestId: string, unitId: string): Promise<BloodScanDemo | undefined> {
  return query(() => {
    requireUser('nurse')
    if (!scanDemoAssist()) return undefined
    const { a, unit } = issued(requestId, unitId)
    const other = db.admissions.find((x) => x.status === 'admitted' && x.id !== a.id)
    const otherUnit = db.bloodUnits.find((x) => x.id !== unit.id && x.product === unit.product && x.status !== 'scrapped')
    return {
      options: [
        { kind: 'patient', code: a.admitNo, label: `腕帶：${nameOf.patient(a.patientId)}（正確）` },
        ...(other ? [{ kind: 'patient' as const, code: other.admitNo, label: `腕帶：${nameOf.patient(other.patientId)}（別的病人）` }] : []),
        { kind: 'unit', code: unit.unitNo, label: `血袋：${unit.unitNo}（正確）` },
        ...(otherUnit ? [{ kind: 'unit' as const, code: otherUnit.unitNo, label: `血袋：${otherUnit.unitNo}（別袋）` }] : []),
      ],
    }
  })
}

/** 床邊掃描：腕帶＋血袋兩個條碼，或略過（原因＋說明） */
export type BloodScanInput = { patientCode: string; unitCode: string } | { skip: ScanSkipReason; note?: string }

export interface StartTransfusionInput {
  scan?: BloodScanInput
  /** 第二人核對（witness.approveWitness purpose transfusion） */
  witness?: string
  vitals: TransfusionVitalsInput
}

/**
 * 開始輸血：已發血還沒開始的那一袋。最後一關在這裡再檢查一次（不相信畫面）：
 * 掃描（腕帶＋血袋，設定關閉時免；掃不了要選原因）、第二人核對、血型相容、效期、輸血前生命徵象
 */
export function startTransfusion(requestId: string, unitId: string, input: StartTransfusionInput): Promise<BloodRequestView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const { r, a, i, unit } = issued(requestId, unitId)
    if (issueState(i) !== 'issued') fail('這袋已經開始輸了', 'CONFLICT')
    const t = now()
    if (unitExpired(unit, t.slice(0, 10))) fail(`血袋已過期（${unit.expiresOn}），不能輸：請送回血庫`, 'CONFLICT')
    const c = r.typing ? bloodCompatible(r.product, r.typing, unit) : { ok: false, message: '這張單還沒有血型' }
    if (!c.ok) fail(`血型不相容，不能輸：${c.message}`, 'CONFLICT')
    // 輸血同意書：這次住院要有有效的一張（醫師說明後在病人「同意書」記錄）
    if (!transfusionConsentOk(db.consents, a.id)) fail('這次住院還沒有輸血同意書：請醫師說明後記錄簽署（病人資料「同意書」）', 'CONFLICT')
    // 掃描
    let scan: NonNullable<BloodRequest['issues'][number]['transfusion']>['scan']
    if (scanRequired()) {
      const s = input.scan
      if (!s) fail('請先掃描病人腕帶與血袋條碼（掃不了請選略過原因）', 'CONFLICT', 'scan')
      if ('skip' in s!) {
        if (!SCAN_SKIP_LABEL[s.skip]) failField('scan', '請選擇略過掃描的原因')
        scan = { mode: 'skipped', reason: s.skip, ...(s.note?.trim() ? { note: s.note.trim() } : {}) }
      } else {
        const p = checkPatientScan(s!.patientCode, scanAdmission(a), allScanAdmissions())
        if (!p.ok) fail(p.message, 'CONFLICT', 'scan')
        const b = checkUnitScan(s!.unitCode, unit)
        if (!b.ok) fail(b.message, 'CONFLICT', 'scan')
        scan = { mode: 'scanned' }
      }
    }
    // 第二人核對：一定要（不管掃描設定）
    const w = witnessFor(input.witness, 'transfusion', transfusionRef(r.id, unit.id), u.id)
    if (w === 'expired') fail('核對已超過 10 分鐘，請重新核對', 'CONFLICT', 'witness')
    if (!w) fail('輸血要另一位護理師或醫師在床邊核對', 'CONFLICT', 'witness')
    const pre = takeVitals(a.id, 'pre', input.vitals, u.id, t)!
    i.transfusion = { startAt: t, nurseId: u.id, witnessId: (w as Exclude<typeof w, 'expired' | null>).witnessId, ...(scan ? { scan } : {}), vitals: [pre] }
    consumeWitness(input.witness)
    audit('開始輸血', `${r.no} ${nameOf.patient(a.patientId)} 血袋 ${unit.unitNo}：核對 ${(w as { witnessName: string }).witnessName}${scan?.mode === 'skipped' ? `、未掃描（${SCAN_SKIP_LABEL[scan.reason]}）` : ''}`)
    return requestView(r, t)
  })
}

function transfusing(requestId: string, unitId: string) {
  const x = issued(requestId, unitId)
  if (issueState(x.i) !== 'transfusing') fail('這袋不在輸血中', 'CONFLICT')
  return x as typeof x & { i: { transfusion: NonNullable<(typeof x)['i']['transfusion']> } }
}

/** 開始後 15 分鐘的生命徵象（只記一次） */
export function recordTransfusionCheck(requestId: string, unitId: string, vitals: TransfusionVitalsInput): Promise<BloodRequestView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const { r, a, i } = transfusing(requestId, unitId)
    if (i.transfusion.vitals.some((v) => v.kind === '15min')) fail('15 分鐘的生命徵象已經記過了', 'CONFLICT')
    const t = now()
    // 和「該量了」同一個時間點：開始才幾分鐘就記，抓不到輸血初期的反應，結束輸血的檢查也形同虛設
    const due = addMinutes(i.transfusion.startAt, BLOOD_CHECK_MIN)
    if (t < due) fail(`開始輸血後 ${BLOOD_CHECK_MIN} 分鐘（${due.slice(11)}）再量；這之前有不適請按「輸血反應」`, 'CONFLICT')
    i.transfusion.vitals.push(takeVitals(a.id, '15min', vitals, u.id, t)!)
    audit('輸血 15 分鐘生命徵象', `${r.no} ${nameOf.patient(a.patientId)}`)
    return requestView(r, t)
  })
}

/** 結束輸血：要先記過 15 分鐘的生命徵象；輸入量、結束時的生命徵象必填 */
export function endTransfusion(requestId: string, unitId: string, input: { volume: number; vitals: TransfusionVitalsInput }): Promise<BloodRequestView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const { r, a, i, unit } = transfusing(requestId, unitId)
    if (!i.transfusion.vitals.some((v) => v.kind === '15min')) fail('請先記錄開始後 15 分鐘的生命徵象', 'CONFLICT')
    const volume = Number(input.volume)
    const t = now()
    const f = fieldErrors()
    if (!Number.isFinite(volume) || volume <= 0 || volume > unit.volume + 50) f.add('volume', `輸入量是 1–${unit.volume + 50} ml（這袋 ${unit.volume} ml）`)
    f.done()
    i.transfusion.vitals.push(takeVitals(a.id, 'end', input.vitals, u.id, t)!)
    Object.assign(i.transfusion, { endAt: t, volume })
    unit.status = 'transfused'
    audit('結束輸血', `${r.no} ${nameOf.patient(a.patientId)} 血袋 ${unit.unitNo}：${volume} ml`)
    return requestView(r, t)
  })
}

/** 輸血反應：立刻停止這一袋、通知醫師（首頁、紅條）。症狀至少一項；生命徵象選填 */
export function reportTransfusionReaction(requestId: string, unitId: string, input: { symptoms: string[]; note?: string; volume?: number; vitals?: TransfusionVitalsInput }): Promise<BloodRequestView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const { r, a, i, unit } = transfusing(requestId, unitId)
    const symptoms = (input.symptoms ?? []).filter((s) => REACTION_SYMPTOMS.includes(s))
    if (!symptoms.length) failField('symptoms', '請勾選症狀')
    if (symptoms.includes('其他') && !input.note?.trim()) failField('note', '勾「其他」請寫說明')
    const t = now()
    const v = takeVitals(a.id, 'end', input.vitals, u.id, t, false)
    if (v) i.transfusion.vitals.push(v)
    const volume = input.volume === undefined || input.volume === null || Number.isNaN(input.volume) ? undefined : Number(input.volume)
    Object.assign(i.transfusion, { endAt: t, ...(volume !== undefined && volume >= 0 ? { volume } : {}), reaction: { at: t, by: u.id, symptoms, note: input.note?.trim() ?? '' } })
    unit.status = 'transfused'
    audit('輸血反應', `${r.no} ${nameOf.patient(a.patientId)} 血袋 ${unit.unitNo}：${symptoms.join('、')}${input.note?.trim() ? `；${input.note.trim()}` : ''}（已停止輸血）`)
    return requestView(r, t)
  })
}

