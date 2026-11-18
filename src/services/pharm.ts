// 藥師住院醫囑審核：給藥醫囑開立、修改後待藥師審核；藥師看系統列的問題（過敏、交互作用、重複、劑量、腎功能）後
// 「通過」或「疑義」（寫內容）。疑義期間給藥暫停（比照護理師疑問）；醫師停止或修改＝結案，或寫理由「維持原醫囑」回到待審。
// 長期排程的藥審核通過才能每日調劑；臨時、需要時先給後審。規則在 pharm-rules，問題清單在 pharm-work
import type { IpdOrder, PharmQuery } from '@/types'
import { db } from '@/mock/db'
import { addMinutes, ageOf, now } from '@/utils/date'
import { audit, fail, failFields, must, mutate, query, requireUser } from './http'
import { checkPharmText, openPharmQuery } from './pharm-rules'
import { pharmIssuesOf, pharmPending, pharmQueried, type PharmIssue } from './pharm-work'
import { renalOf } from './renal-work'
import { orderView, type OrderView } from './ipd'
import { requireCare } from './care-team'
import { find, nameOf } from './views'

export interface PharmItem {
  order: OrderView
  admissionId: string
  admitNo: string
  bedNo: string
  patientName: string
  age: string
  diagnosis: string
  attendingName: string
  allergies: string[]
  renal: string
  issues: PharmIssue[]
  /** 臨時、需要時的醫囑先給後審：已經給了幾劑 */
  givenBeforeReview: number
  queries: (PharmQuery & { byName: string; replyByName?: string })[]
  approvedByName?: string
}

function itemOf(o: IpdOrder): PharmItem {
  const a = must(find.admission(o.admissionId), '住院紀錄')
  const p = find.patient(a.patientId)
  return {
    order: orderView(o), admissionId: a.id, admitNo: a.admitNo, bedNo: find.bed(a.bedId ?? '')?.bedNo ?? '', patientName: p?.name ?? '',
    age: p ? `${ageOf(p.birthDate)} 歲` : '', diagnosis: a.diagnosis, attendingName: nameOf.doctor(a.doctorId), allergies: p?.allergies ?? [],
    renal: renalOf(a.id).text, issues: pharmIssuesOf(o),
    givenBeforeReview: db.mar.filter((m) => m.orderId === o.id && m.status === 'given').length,
    queries: (o.pharm?.queries ?? []).map((q) => ({ ...q, byName: nameOf.user(q.by), ...(q.replyBy ? { replyByName: nameOf.user(q.replyBy) } : {}) })),
    ...(o.pharm?.by ? { approvedByName: nameOf.user(o.pharm.by) } : {}),
  }
}

/** 審核頁：待審（臨時、有嚴重問題的在前，再依送審時間）、疑義待醫師回覆、最近 24 小時通過的 */
export function listPharmReview(): Promise<{ pending: PharmItem[]; queried: PharmItem[]; recent: PharmItem[] }> {
  return query(() => {
    requireUser('pharmacist')
    const t = now()
    const since = addMinutes(t, -24 * 60)
    const pending = pharmPending()
      .map(itemOf)
      .sort((x, y) => Number(y.order.type === 'stat') - Number(x.order.type === 'stat') || Number(y.issues.some((i) => i.level === 'severe')) - Number(x.issues.some((i) => i.level === 'severe')) || x.order.pharm!.at.localeCompare(y.order.pharm!.at))
    const recent = db.ipdOrders
      .filter((o) => o.pharm?.status === 'approved' && (o.pharm.doneAt ?? '') >= since)
      .sort((x, y) => (y.pharm!.doneAt ?? '').localeCompare(x.pharm!.doneAt ?? ''))
      .map(itemOf)
    return { pending, queried: pharmQueried().map(itemOf), recent }
  })
}

function reviewable(orderId: string) {
  const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
  if (!o.pharm) fail('這筆醫囑不用藥師審核')
  // 臨時醫囑給完就「完成」，仍要補審；停止的才不用
  if (o.status === 'stopped' || (o.status === 'done' && o.type !== 'stat')) fail('醫囑已停止，不用再審', 'CONFLICT')
  return o as IpdOrder & { pharm: NonNullable<IpdOrder['pharm']> }
}

/** 藥師通過（可寫備註）。疑義還沒回覆的不能通過（等醫師回覆，或醫師修改、停止） */
export function approvePharm(orderId: string, note?: string): Promise<OrderView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const o = reviewable(orderId)
    if (o.pharm.status === 'approved') fail('這筆已經審核通過', 'CONFLICT')
    if (openPharmQuery(o.pharm)) fail('疑義還沒回覆：等醫師回覆或修改、停止這筆醫囑', 'CONFLICT')
    Object.assign(o.pharm, { status: 'approved', by: u.id, doneAt: now(), ...(note?.trim() ? { note: note.trim() } : {}) })
    audit('藥師審核通過', `${find.admission(o.admissionId)?.admitNo} ${o.content}${note?.trim() ? `：${note.trim()}` : ''}`)
    return orderView(o)
  })
}

/** 藥師疑義：寫內容，主治首頁「藥師疑義待回覆」，回覆前給藥暫停 */
export function queryPharm(orderId: string, text: string): Promise<OrderView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const o = reviewable(orderId)
    if (o.pharm.status !== 'pending') fail(o.pharm.status === 'query' ? '已經有疑義在等醫師回覆' : '這筆已經審核通過', 'CONFLICT')
    failFields(checkPharmText(text, 'query'))
    o.pharm.status = 'query'
    o.pharm.queries = [...(o.pharm.queries ?? []), { by: u.id, at: now(), text: text.trim() }]
    audit('藥師疑義', `${find.admission(o.admissionId)?.admitNo} ${o.content}：${text.trim()}`)
    return orderView(o)
  })
}

/** 醫師回覆「維持原醫囑」（要寫理由）：回到待審，藥師看了理由再通過。要改就直接修改或停止（自動結案） */
export function replyPharmQuery(orderId: string, reply: string): Promise<OrderView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const o = reviewable(orderId)
    const q = openPharmQuery(o.pharm)
    if (!q) fail('這筆醫囑沒有待回覆的藥師疑義', 'CONFLICT')
    requireCare(u.doctorId, must(find.admission(o.admissionId), '住院紀錄'), '回覆藥師疑義', { consult: true })
    failFields(checkPharmText(reply, 'reply'))
    Object.assign(q!, { replyBy: u.id, replyAt: now(), reply: reply.trim(), resolution: 'kept' })
    o.pharm.status = 'pending'
    audit('回覆藥師疑義', `${find.admission(o.admissionId)?.admitNo} ${o.content}：維持原醫囑（${reply.trim()}）`)
    return orderView(o)
  })
}
