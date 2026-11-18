// 加護病房轉入轉出與嚴重度：
//   - 轉入：主治（本科醫師）申請（類別、原因）→ 加護病房主治（權限「加護病房主治」，醫師）同意並選床（直接轉床）、
//     或同意先候床、或不同意（寫原因）；候床的有床再排。住院中轉床進加護病房一定要有同意的申請（住院中心轉床也一樣）
//   - 轉出：醫師寫轉出摘要（診斷、經過、管路、待追蹤）後住院中心才能轉床出去；還接著呼吸器不能轉出；
//     轉出 48 小時內的交班帶出摘要；48 小時內又轉回算「再轉回」（品質指標）
//   - 嚴重度：SOFA 每天（各項取當天最差，缺的不硬算）、APACHE II 轉入 24 小時內（慢性病、手術醫師手動填）
// 規則在 icu-score-rules
import type { IcuCategory, IcuRequest } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, addMinutes, diffDays, now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, permissionsOf, query, requirePermission, requireUser, sessionRole, sessionUser } from './http'
import { find, nameOf } from './views'
import { careRoleOf, requireCare } from './care-team'
import { isIcuBed, releaseBed, takeBed } from './bed-work'
import { icuSince, inIcu } from './icu-work'
import { icuWard } from '@/mock/codes'
import { addChartNote } from './order-ops'
import { apacheScore, bounceBacks, checkIcuRequest, checkIcuSummary, ICU_SUMMARY_FIELDS, icuCategoryLabel, sofaScore, type IcuSummaryInput } from './icu-score-rules'
import { APACHE_CATEGORIES, apacheMortality } from './mortality-rules'
import { afterIcuMove, apacheInputOf, icuMoveProblem, icuSummaryOf, openRequest, sofaInputOf, staysOf } from './icu-move-work'

const admittedOf = (id: string) => {
  const a = must(find.admission(id), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return a
}
const canIcuAttend = () => {
  const u = sessionUser()
  const role = sessionRole()
  return !!u && !!role && role === 'doctor' && permissionsOf({ ...u, role }).includes('icu.attending')
}
/** 加護病房主治（要醫師；管理員有權限也只能看） */
function requireIcuAttending() {
  const u = requirePermission('icu.attending')
  if (u.role !== 'doctor') fail('同意轉入、排加護病房的床要由加護病房主治醫師處理', 'FORBIDDEN')
  return u
}

export interface IcuRequestView extends IcuRequest {
  patientName: string
  bedNo: string
  ward: string
  diagnosis: string
  deptName: string
  categoryLabel: string
  requestedByName: string
  decidedByName?: string
}
const rView = (r: IcuRequest): IcuRequestView => {
  const a = find.admission(r.admissionId)
  const bed = find.bed(a?.bedId ?? '')
  return {
    ...r, patientName: nameOf.patient(a?.patientId), bedNo: bed?.bedNo ?? '', ward: bed?.ward ?? '', diagnosis: a?.diagnosis ?? '', deptName: nameOf.dept(a?.deptId ?? ''),
    categoryLabel: icuCategoryLabel(r.category), requestedByName: nameOf.user(r.requestedBy), ...(r.decidedBy ? { decidedByName: nameOf.user(r.decidedBy) } : {}),
  }
}

/** 轉床（進出加護病房共用）：和住院中心轉床同一套（保留、隔離、加護病房把關） */
function moveInto(a: ReturnType<typeof admittedOf>, bedId: string, t: string) {
  const to = must(find.bed(bedId), '病床')
  const p = icuMoveProblem(a, to)
  if (p) fail(p, 'CONFLICT')
  const from = find.bed(a.bedId ?? '')
  releaseBed(a.bedId)
  const bed = takeBed(bedId, a.id)
  a.bedId = bed.id
  ;(a.bedHistory ??= []).push({ bedId: bed.id, from: t })
  afterIcuMove(a, from, bed, t)
  audit('轉床', `${a.admitNo} ${from?.bedNo ?? ''} → ${bed.bedNo}（轉入加護病房）`)
}

// ---------- 轉入申請 ----------
export function requestIcu(admissionId: string, input: { category: IcuCategory; reason: string }): Promise<IcuRequestView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = admittedOf(admissionId)
    requireCare(u.doctorId, a, '申請轉入加護病房', { consult: false })
    if (inIcu(a)) fail('病人已經在加護病房', 'CONFLICT')
    if (openRequest(a.id)) fail('已經有一筆轉入申請（待同意或候床中）', 'CONFLICT')
    failFields(checkIcuRequest(input))
    const r: IcuRequest = { id: newId('ICR'), admissionId: a.id, category: input.category, reason: input.reason.trim(), requestedBy: u.id, requestedAt: now(), status: 'pending' }
    db.icuRequests.push(r)
    audit('申請轉入加護病房', `${a.admitNo} ${nameOf.patient(a.patientId)}：${icuCategoryLabel(r.category)}（${r.reason}）`)
    return rView(r)
  })
}

export function cancelIcuRequest(id: string): Promise<IcuRequestView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const r = must(db.icuRequests.find((x) => x.id === id), '轉入申請')
    requireCare(u.doctorId, admittedOf(r.admissionId), '取消轉入申請', { consult: false })
    if (r.status !== 'pending' && r.status !== 'accepted') fail('這筆申請已經處理完了', 'CONFLICT')
    Object.assign(r, { status: 'cancelled', decidedBy: u.id, decidedAt: now() })
    audit('取消轉入加護病房', nameOf.patient(find.admission(r.admissionId)?.patientId))
    return rView(r)
  })
}

/** 加護病房主治：同意（選床就直接轉床；沒選＝候床）或不同意（寫原因） */
export function decideIcuRequest(id: string, input: { accept: boolean; note?: string; bedId?: string }): Promise<IcuRequestView> {
  return mutate(() => {
    const u = requireIcuAttending()
    const r = must(db.icuRequests.find((x) => x.id === id), '轉入申請')
    if (r.status !== 'pending') fail('這筆申請已經處理過了', 'CONFLICT')
    const a = admittedOf(r.admissionId)
    const note = input.note?.trim()
    if (!input.accept && !note) failField('note', '不同意：請寫原因（例：目前可在病房觀察，每小時生命徵象）')
    const t = now()
    Object.assign(r, { status: input.accept ? 'accepted' : 'declined', decidedBy: u.id, decidedAt: t, ...(note ? { decideNote: note } : {}) })
    audit(input.accept ? '同意轉入加護病房' : '不同意轉入加護病房', `${nameOf.patient(a.patientId)}${note ? `（${note}）` : ''}`)
    if (input.accept && input.bedId) moveInto(a, input.bedId, t)
    return rView(r)
  })
}

/** 候床的有床了：排床（加護病房主治或住院中心） */
export function placeIcuRequest(id: string, bedId: string): Promise<IcuRequestView> {
  return mutate(() => {
    if (!canIcuAttend()) requirePermission('admission.desk')
    const r = must(db.icuRequests.find((x) => x.id === id), '轉入申請')
    if (r.status !== 'accepted') fail('只有同意、候床中的申請可以排床', 'CONFLICT')
    if (!isIcuBed(find.bed(bedId))) failField('bedId', '請選加護病房的床')
    moveInto(admittedOf(r.admissionId), bedId, now())
    return rView(r)
  })
}

export interface IcuWork {
  pending: IcuRequestView[]
  waiting: IcuRequestView[]
  recent: IcuRequestView[]
  /** 加護病房的空床 */
  emptyBeds: { id: string; bedNo: string }[]
  canDecide: boolean
}
export function listIcuWork(): Promise<IcuWork> {
  return query(() => {
    requireUser('doctor', 'nurse', 'admin', 'clerk')
    const since = addDays(today(), -7)
    return {
      pending: db.icuRequests.filter((r) => r.status === 'pending').sort((x, y) => x.requestedAt.localeCompare(y.requestedAt)).map(rView),
      waiting: db.icuRequests.filter((r) => r.status === 'accepted').sort((x, y) => (x.decidedAt ?? '').localeCompare(y.decidedAt ?? '')).map(rView),
      recent: db.icuRequests.filter((r) => ['declined', 'placed', 'cancelled'].includes(r.status) && (r.decidedAt ?? r.requestedAt) >= since).sort((x, y) => (y.placedAt ?? y.decidedAt ?? '').localeCompare(x.placedAt ?? x.decidedAt ?? '')).map(rView),
      emptyBeds: db.beds.filter((b) => b.ward === icuWard && b.status === 'empty').map((b) => ({ id: b.id, bedNo: b.bedNo })).sort((x, y) => x.bedNo.localeCompare(y.bedNo, undefined, { numeric: true })),
      canDecide: canIcuAttend(),
    }
  })
}

// ---------- 病人的加護病房分頁 ----------
export interface SofaDay { date: string; total: number; parts: ReturnType<typeof sofaScore>['parts']; missing: string[]; partial: boolean }
export interface PatientIcu {
  admissionId: string
  inIcu: boolean
  since?: string
  /** 還在走的申請、最近一筆（看結果） */
  request?: IcuRequestView
  canRequest: boolean
  summary?: { at: string; byName: string; items: { label: string; text: string }[] }
  canSummary: boolean
  sofa: SofaDay[]
  apache?: ReturnType<typeof apacheScore> & { partial: boolean; input: { chronic: boolean; surgery: 'none' | 'emergency' | 'elective'; set: boolean; category?: string }; /** 預估死亡率 %（類別沒選以 0 計） */ mortality: number }
  stays: { from: string; to?: string; days: number; bounce: boolean }[]
}

export function patientIcu(admissionId: string): Promise<PatientIcu> {
  return query(() => {
    const u = requireUser('doctor', 'nurse', 'admin')
    const a = must(find.admission(admissionId), '住院紀錄')
    const t = now()
    const since = icuSince(a)
    const req = openRequest(a.id) ?? db.icuRequests.filter((r) => r.admissionId === a.id).sort((x, y) => x.requestedAt.localeCompare(y.requestedAt)).pop()
    const care = u.role === 'doctor' ? careRoleOf(u.doctorId, a) : null
    const doc = u.role === 'doctor' && a.status === 'admitted' && ((!!care && care.kind !== 'consult') || canIcuAttend())
    const sum = since ? icuSummaryOf(a) : undefined
    const sofa: SofaDay[] = []
    if (since) {
      const first = [since.slice(0, 10), addDays(today(), -6)].sort().pop()!
      for (let d = first; d <= today(); d = addDays(d, 1)) {
        const from = [`${d} 00:00`, since].sort().pop()!
        // 一整天：從 00:00 起都在加護病房、而且這一天過完了（轉入那天只住半天，尿量不能拿來算腎臟分數）
        const full = d < today() && from === `${d} 00:00`
        // 區間的結束：過完的那天到隔天 00:00（轉入那天只住半天也一樣，不能把之後幾天的資料算進來）；今天到現在
        const s = sofaScore(sofaInputOf(a, from, d < today() ? `${addDays(d, 1)} 00:00` : addMinutes(t, 1), full))
        sofa.push({ date: d, total: s.total, parts: s.parts, missing: s.missing, partial: d === today() })
      }
    }
    const stays = staysOf(a)
    const bounce = new Set(bounceBacks(stays).map((s) => s.from))
    return {
      admissionId: a.id, inIcu: inIcu(a), ...(since ? { since } : {}),
      ...(req ? { request: rView(req) } : {}),
      canRequest: u.role === 'doctor' && a.status === 'admitted' && !!care && care.kind !== 'consult' && !inIcu(a) && !openRequest(a.id),
      ...(sum ? { summary: { at: sum.at, byName: nameOf.doctor(sum.doctorId), items: sum.items ?? [] } } : {}),
      canSummary: doc && inIcu(a),
      sofa,
      ...(since
        ? { apache: (() => { const sc = apacheScore(apacheInputOf(a, since)); return { ...sc, partial: addMinutes(since, 24 * 60) > t, input: { chronic: a.apache?.chronic ?? false, surgery: a.apache?.surgery ?? 'none', set: !!a.apache, ...(a.apache?.category ? { category: a.apache.category } : {}) }, mortality: apacheMortality(sc.total, a.apache?.category, a.apache?.surgery === 'emergency') } })() }
        : {}),
      stays: stays.map((s) => ({ ...s, days: Math.max(1, diffDays(s.from.slice(0, 10), (s.to ?? t).slice(0, 10)) + (s.to ? 0 : 1)), bounce: bounce.has(s.from) })),
    }
  })
}

/** APACHE II 要手動填的：嚴重慢性病、手術 */
export function setApacheInput(admissionId: string, input: { chronic: boolean; surgery: 'none' | 'emergency' | 'elective'; category?: string }): Promise<PatientIcu> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = admittedOf(admissionId)
    if (!canIcuAttend()) requireCare(u.doctorId, a, '填 APACHE II', { consult: false })
    if (!icuSince(a)) fail('病人不在加護病房', 'CONFLICT')
    if (!['none', 'emergency', 'elective'].includes(input.surgery)) failField('surgery', '請選手術')
    if (input.category && !APACHE_CATEGORIES.some((c) => c.key === input.category)) failField('category', '請選診斷類別')
    a.apache = { chronic: !!input.chronic, surgery: input.surgery, by: u.id, at: now(), ...(input.category ? { category: input.category } : {}) }
    audit('APACHE II', `${a.admitNo} ${nameOf.patient(a.patientId)}：慢性病 ${input.chronic ? '有' : '無'}、手術 ${input.surgery}`)
  }).then(() => patientIcu(admissionId))
}

/** 加護病房轉出摘要（主治或加護病房主治）：寫了住院中心才能轉床出去；交班帶出 */
export function writeIcuSummary(admissionId: string, input: IcuSummaryInput): Promise<PatientIcu> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = admittedOf(admissionId)
    if (!canIcuAttend()) requireCare(u.doctorId, a, '寫加護病房轉出摘要', { consult: false })
    if (!inIcu(a)) fail('病人不在加護病房', 'CONFLICT')
    failFields(checkIcuSummary(input))
    addChartNote(a.id, u.doctorId!, 'icuOut', ICU_SUMMARY_FIELDS.map((f) => ({ label: f.label, text: (input[f.key] ?? '').trim() })), now())
    audit('加護病房轉出摘要', `${a.admitNo} ${nameOf.patient(a.patientId)}`)
  }).then(() => patientIcu(admissionId))
}

// ---------- 品質指標 ----------
export interface IcuStats { from: string; to: string; stays: number; patientDays: number; avgDays: number | null; bounce: number; bounceRate: number | null }
/** 最近 N 天：轉入幾次、加護病房住院人日、平均住幾天（已轉出的）、48 小時內再轉回 */
export function icuStats(days = 30): Promise<IcuStats> {
  return query(() => {
    requireUser('nurse', 'doctor', 'admin')
    const t = now()
    const to = today()
    const from = addDays(to, -(days - 1))
    let stays = 0
    let patientDays = 0
    let bounce = 0
    const done: number[] = []
    for (const a of db.admissions.filter((x) => x.admittedAt && x.status !== 'cancelled')) {
      const ss = staysOf(a)
      const bb = new Set(bounceBacks(ss).map((s) => s.from))
      for (const s of ss) {
        const end = (s.to ?? t).slice(0, 10)
        if (end < from || s.from.slice(0, 10) > to) continue
        const lo = [s.from.slice(0, 10), from].sort().pop()!
        const hi = [end, to].sort()[0]
        patientDays += diffDays(lo, hi) + 1
        if (s.from.slice(0, 10) >= from) {
          stays++
          if (bb.has(s.from)) bounce++
        }
        if (s.to) done.push(Math.max(1, diffDays(s.from.slice(0, 10), s.to.slice(0, 10))))
      }
    }
    return { from, to, stays, patientDays, avgDays: done.length ? Math.round((done.reduce((n, x) => n + x, 0) / done.length) * 10) / 10 : null, bounce, bounceRate: stays ? Math.round((bounce / stays) * 1000) / 10 : null }
  })
}

