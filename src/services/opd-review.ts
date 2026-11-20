// 門診病歷品質抽審（病歷室，權限「疾病分類」）：選月份 → 每位醫師抽 2 份那個月完成的門診病歷（急診、慢箋領藥不抽）→
// 逐項審查（符合／不符合）、寫意見 → 有不符合的，醫師在「健保審查回覆」頁看並寫改善說明。每月各醫師平均分數。規則在 opd-review-rules
import type { OpdRecordReview } from '@/types'
import { db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, must, mutate, query, requirePermission, requireUser } from './http'
import { checkOpdReview, OPD_REVIEW_ITEMS, OPD_REVIEW_PER_DOCTOR, opdReviewFails, opdReviewScore, sampleEncounters } from './opd-review-rules'
import { find, nameOf } from './views'

export interface OpdReviewView extends OpdRecordReview {
  doctorName: string
  patientName: string
  chartNo: string
  date: string
  deptName: string
  /** 病歷內容（審查時看） */
  soap: { subjective: string; objective: string; assessment: string; plan: string }
  diagnoses: string[]
  medications: string[]
  procedures: string[]
  score?: number
  fails: string[]
  /** 有不符合、醫師還沒回覆 */
  needAck: boolean
}
function view(r: OpdRecordReview): OpdReviewView {
  const e = db.encounters.find((x) => x.id === r.encounterId)
  return {
    ...r, doctorName: nameOf.doctor(r.doctorId), patientName: nameOf.patient(r.patientId), chartNo: find.patient(r.patientId)?.chartNo ?? '', date: e?.date ?? '', deptName: e ? nameOf.dept(e.deptId) : '',
    soap: { subjective: e?.subjective ?? '', objective: e?.objective ?? '', assessment: e?.assessment ?? '', plan: e?.plan ?? '' },
    diagnoses: (e?.diagnoses ?? []).map((d) => `${d.icd} ${d.name}${d.primary ? '（主）' : ''}`),
    medications: (e?.medications ?? []).map((m) => `${find.drug(m.drugId)?.name ?? m.drugId} ${m.dose} ${m.freq} ${m.days} 天`),
    procedures: (e?.procedures ?? []).map((p) => find.procedure(p.procId)?.name ?? p.procId),
    ...(r.result ? { score: opdReviewScore(r.result.items) } : {}), fails: r.result ? opdReviewFails(r.result.items) : [],
    needAck: !!r.result && opdReviewFails(r.result.items).length > 0 && !r.ack,
  }
}

export interface OpdReviewBoard {
  month: string
  /** 這個月抽過了嗎 */
  sampled: boolean
  /** 可以抽的病歷數（醫師數） */
  candidates: { encounters: number; doctors: number }
  reviews: OpdReviewView[]
  /** 各醫師：抽幾份、審完幾份、平均分數 */
  byDoctor: { doctorName: string; count: number; done: number; avg: number | null }[]
}
/** 能抽的：那個月完成的門診病歷（不含急診、慢箋領藥） */
const candidatesOf = (month: string) => db.encounters.filter((e) => e.status === 'completed' && e.date.startsWith(month) && ((v) => !!v && !v.er && !v.refillOf)(find.visit(e.visitId)))

function boardOf(month: string): OpdReviewBoard {
    const rs = db.opdReviews.filter((r) => r.month === month)
    const cs = candidatesOf(month)
    const docs = [...new Set(rs.map((r) => r.doctorId))]
    return {
      month, sampled: rs.length > 0, candidates: { encounters: cs.length, doctors: new Set(cs.map((e) => e.doctorId)).size },
      reviews: rs.map(view).sort((a, b) => Number(!!a.result) - Number(!!b.result) || a.doctorName.localeCompare(b.doctorName) || a.date.localeCompare(b.date)),
      byDoctor: docs.map((d) => {
        const xs = rs.filter((r) => r.doctorId === d)
        const done = xs.filter((r) => r.result)
        return { doctorName: nameOf.doctor(d), count: xs.length, done: done.length, avg: done.length ? Math.round(done.reduce((n, r) => n + opdReviewScore(r.result!.items), 0) / done.length) : null }
      }).sort((a, b) => (a.avg ?? 101) - (b.avg ?? 101)),
    }
}

export function opdReviewBoard(month: string): Promise<OpdReviewBoard> {
  return query(() => {
    requirePermission('coding')
    if (!/^[0-9]{4}-[0-9]{2}$/.test(month ?? '')) failField('month', '請選月份')
    return boardOf(month)
  })
}

/** 抽樣（月份要結束了；同一個月只抽一次） */
export function sampleOpdReviews(month: string): Promise<OpdReviewBoard> {
  return mutate(() => {
    const u = requirePermission('coding')
    if (!/^[0-9]{4}-[0-9]{2}$/.test(month ?? '')) failField('month', '請選月份')
    if (month >= today().slice(0, 7)) fail('月份結束後才能抽（這個月的病歷還在寫）', 'CONFLICT')
    if (db.opdReviews.some((r) => r.month === month)) fail('這個月已經抽過了', 'CONFLICT')
    const picks = sampleEncounters(candidatesOf(month), OPD_REVIEW_PER_DOCTOR)
    if (!picks.length) fail('這個月沒有可以抽的門診病歷', 'CONFLICT')
    const t = now()
    for (const e of picks) db.opdReviews.push({ id: newId('OR'), month, encounterId: e.id, doctorId: e.doctorId, patientId: e.patientId, sampledAt: t, sampledBy: u.id })
    audit('門診病歷抽審', `${month}：抽 ${picks.length} 份（${new Set(picks.map((e) => e.doctorId)).size} 位醫師，每位最多 ${OPD_REVIEW_PER_DOCTOR} 份）`)
    return boardOf(month)
  })
}

/** 審查：每一項符合或不符合、意見（有不符合要寫）；審過可以再改（醫師回覆前） */
export function saveOpdReview(id: string, input: { items: Record<string, boolean>; note?: string }): Promise<OpdReviewView> {
  return mutate(() => {
    const u = requirePermission('coding')
    const r = must(db.opdReviews.find((x) => x.id === id), '抽審')
    if (r.ack) fail('醫師已經回覆了，不能再改', 'CONFLICT')
    const why = checkOpdReview(input.items ?? {})
    if (why) failField('items', why)
    const items = Object.fromEntries(OPD_REVIEW_ITEMS.map((i) => [i.key, !!input.items[i.key]]))
    if (opdReviewFails(items).length && !input.note?.trim()) failField('note', '有不符合的項目：請寫具體意見（醫師會看到）')
    r.result = { items, note: input.note?.trim() ?? '', at: now(), by: u.id }
    audit('門診病歷審查', `${r.month} ${nameOf.doctor(r.doctorId)}・${nameOf.patient(r.patientId)}：${opdReviewScore(items)} 分${opdReviewFails(items).length ? `（不符合：${opdReviewFails(items).join('、')}）` : ''}`)
    return view(r)
  })
}

/** 醫師：我被抽審的病歷（要回覆的在前） */
export function myOpdReviews(): Promise<OpdReviewView[]> {
  return query(() => {
    const u = requireUser('doctor')
    return db.opdReviews.filter((r) => r.doctorId === u.doctorId && r.result).map(view).sort((a, b) => Number(b.needAck) - Number(a.needAck) || b.month.localeCompare(a.month))
  })
}

/** 醫師回覆（有不符合的）：改善說明 */
export function ackOpdReview(id: string, note: string): Promise<OpdReviewView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const r = must(db.opdReviews.find((x) => x.id === id), '抽審')
    if (r.doctorId !== u.doctorId) fail('只有被抽審的醫師能回覆', 'FORBIDDEN')
    if (!r.result) fail('還沒審查', 'CONFLICT')
    if (!opdReviewFails(r.result.items).length) fail('全部符合，不用回覆', 'CONFLICT')
    if (r.ack) fail('已經回覆了', 'CONFLICT')
    if (!note?.trim()) failField('note', '請寫改善說明（例：之後會記載理學檢查）')
    r.ack = { at: now(), by: u.id, note: note.trim() }
    audit('門診病歷抽審回覆', `${r.month} ${nameOf.patient(r.patientId)}：${note.trim()}`)
    return view(r)
  })
}
