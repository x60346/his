// 早期預警與快速反應小組：
//   - NEWS2：一般病房的生命徵象七項都有就算分（nursing.addVitals 存檔時）；5–6 分或任一項 3 分通知主治、1 小時內再量；
//     ≥7 分自動呼叫快速反應小組（已經在等、或已經申請轉加護病房的不重複叫）
//   - 護理師（或照顧的醫師）覺得不對勁也可以手動呼叫（寫原因）
//   - 快速反應小組（權限 rrt，醫師）到場評估：發現、處置、去向；申請轉加護病房就直接建一筆轉入申請（由加護病房主治同意）
// 規則在 news-rules，內部工具在 news-work
import type { IcuCategory, IcuRequest, RrtCall } from '@/types'
import { db, newId } from '@/mock/db'
import { addMinutes, now } from '@/utils/date'
import { audit, fail, failFields, must, mutate, permissionsOf, query, requirePermission, requireUser, sessionRole, sessionUser } from './http'
import { find, nameOf } from './views'
import { inIcu } from './icu-work'
import { openRequest } from './icu-move-work'
import { checkIcuRequest, icuCategoryLabel } from './icu-score-rules'
import { checkRrtAssessment, checkRrtCall, isNews, newsScore, type NewsLevel, type NewsResult } from './news-rules'
import { minutesBetween, newsStateOf, openRrt, palliativeEnrolled, pushManualRrt, rrtStats, scoredVitals } from './news-work'

const admittedOf = (id: string) => {
  const a = must(find.admission(id), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return a
}
const canAssess = () => {
  const u = sessionUser()
  const role = sessionRole()
  return !!u && role === 'doctor' && permissionsOf({ ...u, role }).includes('rrt')
}

export interface RrtView extends RrtCall {
  patientName: string
  bedNo: string
  ward: string
  diagnosis: string
  calledByName: string
  assessedByName?: string
  /** 等了幾分鐘（還沒評估）、幾分鐘到場評估（評估完） */
  waitedMin?: number
  responseMin?: number
  /** 觸發的那筆（自動）或呼叫當時最近一筆的 NEWS2 各項 */
  news?: NewsResult & { at: string }
  /** 目前最近一次 NEWS2 */
  latest?: { total: number; level: NewsLevel; at: string }
  icuRequestStatus?: IcuRequest['status']
}
function view(c: RrtCall, t: string): RrtView {
  const a = find.admission(c.admissionId)
  const bed = find.bed(a?.bedId ?? '')
  const sv = scoredVitals(c.admissionId)
  const trig = c.vitalId ? sv.find((x) => x.v.id === c.vitalId) : sv.filter((x) => x.v.at <= c.calledAt).pop()
  const st = a ? newsStateOf(a, t) : undefined
  const req = c.icuRequestId ? db.icuRequests.find((r) => r.id === c.icuRequestId) : undefined
  return {
    ...c,
    patientName: nameOf.patient(a?.patientId), bedNo: bed?.bedNo ?? '', ward: bed?.ward ?? '', diagnosis: a?.diagnosis ?? '',
    calledByName: nameOf.user(c.calledBy),
    ...(c.assessedBy ? { assessedByName: nameOf.user(c.assessedBy) } : {}),
    ...(c.status === 'pending' ? { waitedMin: minutesBetween(c.calledAt, t) } : c.assessedAt ? { responseMin: minutesBetween(c.calledAt, c.assessedAt) } : {}),
    ...(trig ? { news: { ...trig.news, at: trig.v.at } } : {}),
    ...(st ? { latest: { total: st.last.news.total, level: st.last.news.level, at: st.last.v.at } } : {}),
    ...(req ? { icuRequestStatus: req.status } : {}),
  }
}

/** 手動呼叫：護理師、照顧的醫師覺得不對勁（NEWS2 不高也可以叫） */
export function callRrt(admissionId: string, input: { reason: string }): Promise<RrtView> {
  return mutate(() => {
    const u = requireUser('nurse', 'doctor')
    const a = admittedOf(admissionId)
    if (inIcu(a)) fail('病人在加護病房：不用呼叫快速反應小組', 'CONFLICT')
    if (openRrt(a.id)) fail('已經呼叫了，快速反應小組還沒到場評估', 'CONFLICT')
    failFields(checkRrtCall(input))
    const t = now()
    const c = pushManualRrt(a.id, input.reason.trim(), u.id, t)
    audit('呼叫快速反應小組', `${a.admitNo} ${nameOf.patient(a.patientId)}：${c.reason}`)
    return view(c, t)
  })
}

/**
 * 快速反應小組到場評估：發現、處置、去向。申請轉加護病房：已經有申請在走就接上那一筆（不重複申請），
 * 沒有就用評估的類別、原因建一筆（申請人是小組醫師）
 */
export function assessRrt(id: string, input: { findings: string; actions: string; disposition: 'stay' | 'icu'; category?: IcuCategory; reason?: string }): Promise<RrtView> {
  return mutate(() => {
    const u = requirePermission('rrt')
    if (u.role !== 'doctor') fail('快速反應評估要由小組醫師填寫', 'FORBIDDEN')
    const c = must(db.rrtCalls.find((x) => x.id === id), '快速反應呼叫')
    if (c.status !== 'pending') fail('這次呼叫已經評估過了', 'CONFLICT')
    const a = admittedOf(c.admissionId)
    const existing = input.disposition === 'icu' ? openRequest(a.id) : undefined
    failFields({ ...checkRrtAssessment(input), ...(input.disposition === 'icu' && !existing && !inIcu(a) ? checkIcuRequest(input) : {}) })
    if (input.disposition === 'icu' && inIcu(a)) fail('病人已經在加護病房', 'CONFLICT')
    const t = now()
    let reqId = existing?.id
    if (input.disposition === 'icu' && !existing) {
      const r: IcuRequest = { id: newId('ICR'), admissionId: a.id, category: input.category!, reason: input.reason!.trim(), requestedBy: u.id, requestedAt: t, status: 'pending', rrtCallId: c.id }
      db.icuRequests.push(r)
      reqId = r.id
      audit('申請轉入加護病房', `${a.admitNo} ${nameOf.patient(a.patientId)}：${icuCategoryLabel(r.category)}（${r.reason}；快速反應小組）`)
    }
    Object.assign(c, { status: 'done', assessedBy: u.id, assessedAt: t, findings: input.findings.trim(), actions: input.actions.trim(), disposition: input.disposition, ...(reqId ? { icuRequestId: reqId } : {}) })
    audit('快速反應評估', `${nameOf.patient(a.patientId)}：${input.disposition === 'icu' ? '申請轉加護病房' : '留原病房'}`)
    return view(c, t)
  })
}

export interface RrtWork {
  pending: RrtView[]
  /** 最近 7 天評估完的 */
  recent: RrtView[]
  stats: ReturnType<typeof rrtStats>
  canAssess: boolean
}
/** 快速反應小組頁：等評估的（等最久的在上面）、最近評估的、品質指標 */
export function listRrt(): Promise<RrtWork> {
  return query(() => {
    requirePermission('rrt')
    const t = now()
    const from = addMinutes(t, -7 * 24 * 60)
    return {
      pending: db.rrtCalls.filter((c) => c.status === 'pending').sort((x, y) => x.calledAt.localeCompare(y.calledAt)).map((c) => view(c, t)),
      recent: db.rrtCalls.filter((c) => c.status === 'done' && (c.assessedAt ?? '') >= from).sort((x, y) => (y.assessedAt ?? '').localeCompare(x.assessedAt ?? '')).map((c) => view(c, t)),
      stats: rrtStats(t),
      canAssess: canAssess(),
    }
  })
}

export interface PatientNews {
  admissionId: string
  inIcu: boolean
  last?: NewsResult & { at: string }
  recheck?: { dueAt: string; status: 'upcoming' | 'overdue' }
  /** 最近 8 次的分數（舊到新） */
  trend: { at: string; total: number; level: NewsLevel }[]
  /** 最近一筆生命徵象算不出分數時缺哪幾項 */
  missing?: string[]
  open?: RrtView
  calls: RrtView[]
  canCall: boolean
  /** 安寧收案：高分不自動呼叫 */
  palliative: boolean
}
/** 病人的 NEWS2 與快速反應紀錄（生命徵象頁、住院醫囑「加護病房」分頁） */
export function patientNews(admissionId: string): Promise<PatientNews> {
  return query(() => {
    requireUser()
    const a = must(find.admission(admissionId), '住院紀錄')
    const t = now()
    const st = newsStateOf(a, t)
    const sv = scoredVitals(a.id)
    const lastAny = db.vitals.filter((v) => v.admissionId === a.id && !v.hourly).reduce<(typeof db.vitals)[number] | undefined>((b, v) => (!b || v.at >= b.at ? v : b), undefined)
    const ls = lastAny ? newsScore(lastAny) : undefined
    const open = openRrt(a.id)
    const role = sessionRole()
    return {
      admissionId: a.id,
      inIcu: inIcu(a),
      ...(st ? { last: { ...st.last.news, at: st.last.v.at }, ...(st.recheck ? { recheck: st.recheck } : {}) } : {}),
      trend: inIcu(a) ? [] : sv.slice(-8).map((x) => ({ at: x.v.at, total: x.news.total, level: x.news.level })),
      ...(ls && !isNews(ls) && !inIcu(a) ? { missing: ls.missing } : {}),
      ...(open ? { open: view(open, t) } : {}),
      calls: db.rrtCalls.filter((c) => c.admissionId === a.id).sort((x, y) => y.calledAt.localeCompare(x.calledAt)).map((c) => view(c, t)),
      canCall: a.status === 'admitted' && !inIcu(a) && !open && (role === 'nurse' || role === 'doctor'),
      palliative: palliativeEnrolled(a.id),
    }
  })
}
