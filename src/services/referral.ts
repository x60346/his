// 轉診：
//   - 轉入：病人持外院轉診單，櫃台掛號時登錄（booking.register 的 referralIn，或掛號後在這裡補登／更正）——
//     基本部分負擔收經轉診的金額；同一療程醫師約的回診沿用（booking.bookFollowUp）。看完診醫師開「轉診回覆單」給原院所
//   - 轉出：醫師看完診開轉診單（病摘快照：診斷、用藥、檢驗檢查、過敏），印給病人帶到別家醫院
// 規則（有效期、目的選項）在 referral-rules；外院不在系統裡，所以轉出的單沒有「外院回覆」可追蹤
import type { ReferralIn, ReferralOut, Visit } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failFields, must, mutate, query, requirePermission, requireUser, sessionUser } from './http'
import { find, nameOf } from './views'
import { REFERRAL_PURPOSES, type ReferralInInput } from './referral-rules'
import { buildReferralIn, pendingReplyVisits } from './referral-work'

/** 還沒批價的掛號才能補登／更正轉診單（批價後部分負擔已收） */
const OPEN: Visit['status'][] = ['registered', 'in-consult', 'consulted']

const patientOf = (patientId: string) => {
  const p = must(find.patient(patientId), '病患')
  return { name: p.name, gender: p.gender === 'M' ? '男' : '女', birthDate: p.birthDate, idNo: p.idNo, chartNo: p.chartNo, allergies: p.allergies }
}
const doctorOf = (doctorId: string) => {
  const d = find.doctor(doctorId)
  return { doctorName: d?.name ?? doctorId, doctorLicenseNo: d?.licenseNo ?? '' }
}

// ---------- 轉入 ----------

/** 補登、更正或取消掛號上的轉診單（input＝null 取消）：還沒批價才行；醫師已回覆的不能取消 */
export function setReferralIn(visitId: string, input: ReferralInInput | null): Promise<{ visitId: string; referralIn?: ReferralIn }> {
  return mutate(() => {
    const u = requirePermission('visit.register')
    const v = must(find.visit(visitId), '掛號紀錄')
    if (v.refillOf) fail('慢箋領藥不看診，沒有轉診', 'CONFLICT')
    if (!OPEN.includes(v.status)) fail(v.status === 'cancelled' ? '這筆掛號已退掛' : '已經批價：請先作廢收據再更正轉診單', 'CONFLICT')
    const before = v.referralIn
    if (!input) {
      if (!before) fail('這筆掛號沒有轉診單')
      if (before.reply) fail('醫師已開轉診回覆單，不能取消轉診', 'CONFLICT')
      delete v.referralIn
      audit('取消轉診單', `${nameOf.patient(v.patientId)} ${v.date} #${v.seqNo}（${before.fromHospital}）`)
      return { visitId: v.id }
    }
    v.referralIn = { ...buildReferralIn(input, v.date, u.id), ...(before?.inheritedFrom ? { inheritedFrom: before.inheritedFrom } : {}), ...(before?.reply ? { reply: before.reply } : {}) }
    audit(before ? '更正轉診單' : '補登轉診單', `${nameOf.patient(v.patientId)} ${v.date} #${v.seqNo}：${v.referralIn.fromHospital}（${v.referralIn.issuedOn} 開單）`)
    return { visitId: v.id, referralIn: v.referralIn }
  })
}

export interface ReferralReplyInput {
  diagnosis: string
  treatment: string
  advice: string
}

export interface ReferralInView {
  visitId: string
  date: string
  deptName: string
  doctorName: string
  doctorLicenseNo: string
  patient: ReturnType<typeof patientOf>
  referral: ReferralIn
  /** 沿用自哪一次（同一療程的回診）：「11/02 持單就診」 */
  inheritedText?: string
  /** 醫師現在可以開回覆單（看完診、是持單那次、自己的病人） */
  canReply: boolean
}

function inView(v: Visit): ReferralInView {
  const r = must(v.referralIn, '轉診單')
  const u = sessionUser()
  const enc = find.encounterOfVisit(v.id)
  const src = r.inheritedFrom ? find.visit(r.inheritedFrom) : undefined
  return {
    visitId: v.id, date: v.date, deptName: nameOf.dept(v.deptId), ...doctorOf(v.doctorId), patient: patientOf(v.patientId), referral: r,
    ...(src ? { inheritedText: `${src.date.slice(5).replace('-', '/')} 持單就診的回診（同一療程）` } : {}),
    canReply: !r.inheritedFrom && enc?.status === 'completed' && u?.doctorId === v.doctorId,
  }
}

/** 掛號上的轉診單（看診頁上方顯示、回覆單列印用） */
export function getReferralIn(visitId: string): Promise<ReferralInView | undefined> {
  return query(() => {
    const v = must(find.visit(visitId), '掛號紀錄')
    return v.referralIn ? inView(v) : undefined
  })
}

/** 醫師開回覆單：看完診、持單那次（沿用的回診不必回覆）、這次看診的醫師 */
function replyTarget(visitId: string) {
  const u = requireUser('doctor')
  const v = must(find.visit(visitId), '掛號紀錄')
  if (!v.referralIn) fail('這次就醫沒有轉診單', 'CONFLICT')
  if (v.referralIn.inheritedFrom) fail('這是同一療程的回診，轉診回覆在持單那次開', 'CONFLICT')
  if (v.doctorId !== u.doctorId) fail('只有看診的醫師可以回覆轉診', 'FORBIDDEN')
  const e = find.encounterOfVisit(v.id)
  if (e?.status !== 'completed') fail('完成看診後才能開轉診回覆單', 'CONFLICT')
  return { u, v, e: e! }
}

/** 回覆單預設內容：本院診斷、這次的用藥與處置、計畫 */
export function referralReplyDraft(visitId: string): Promise<ReferralReplyInput> {
  return query(() => {
    const { v, e } = replyTarget(visitId)
    if (v.referralIn!.reply) return { diagnosis: v.referralIn!.reply.diagnosis, treatment: v.referralIn!.reply.treatment, advice: v.referralIn!.reply.advice }
    const meds = e.medications.map((m) => `${find.drug(m.drugId)?.name ?? m.drugId} ${m.days} 天`)
    const procs = e.procedures.map((p) => find.procedure(p.procId)?.name ?? p.procId)
    return {
      diagnosis: e.diagnoses.map((d) => `${d.icd} ${d.name}`).join('\n'),
      treatment: [meds.length ? `用藥：${meds.join('、')}` : '', procs.length ? `檢驗檢查：${procs.join('、')}` : ''].filter(Boolean).join('\n'),
      advice: e.plan,
    }
  })
}

/** 存回覆單（可再修改；改了要重印） */
export function saveReferralReply(visitId: string, input: ReferralReplyInput): Promise<ReferralInView> {
  return mutate(() => {
    const { u, v } = replyTarget(visitId)
    const e: Record<string, string> = {}
    if (!input.diagnosis?.trim()) e.diagnosis = '請寫本院診斷'
    if (!input.advice?.trim()) e.advice = '請寫建議（例：病情穩定，請回原院所繼續追蹤）'
    failFields(e)
    const first = !v.referralIn!.reply
    v.referralIn!.reply = { diagnosis: input.diagnosis.trim(), treatment: input.treatment?.trim() ?? '', advice: input.advice.trim(), doctorId: u.doctorId!, at: now() }
    audit(first ? '轉診回覆' : '修改轉診回覆', `${nameOf.patient(v.patientId)} → ${v.referralIn!.fromHospital}`)
    return inView(v)
  })
}

/** 列印回覆單（醫師、櫃台）：記下誰、何時印 */
export function printReferralReply(visitId: string): Promise<ReferralInView> {
  return mutate(() => {
    const u = requireUser('doctor', 'clerk')
    const v = must(find.visit(visitId), '掛號紀錄')
    const reply = v.referralIn?.reply
    if (!reply) fail('醫師還沒開轉診回覆單', 'CONFLICT')
    reply.printed = [...(reply.printed ?? []), { at: now(), by: u.id }]
    audit('列印轉診回覆單', `${nameOf.patient(v.patientId)} → ${v.referralIn!.fromHospital}`)
    return inView(v)
  })
}

/** 醫師待辦：我看過、持外院轉診單、還沒回覆的 */
export interface PendingReferralReply {
  visitId: string
  date: string
  patientName: string
  chartNo: string
  fromHospital: string
}
export function listPendingReferralReplies(): Promise<PendingReferralReply[]> {
  return query(() => {
    const u = requireUser('doctor')
    return pendingReplyVisits(u.doctorId!)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((v) => ({ visitId: v.id, date: v.date, patientName: nameOf.patient(v.patientId), chartNo: find.patient(v.patientId)?.chartNo ?? '', fromHospital: v.referralIn!.fromHospital }))
  })
}

// ---------- 轉出 ----------

export interface ReferralOutInput {
  toHospital: string
  toDept: string
  purpose: string
  urgent: boolean
  summary: string
}

export interface ReferralOutView extends ReferralOut {
  deptName: string
  doctorName: string
  doctorLicenseNo: string
  patient: ReturnType<typeof patientOf>
}

const outView = (r: ReferralOut): ReferralOutView => ({ ...r, deptName: nameOf.dept(r.deptId), ...doctorOf(r.doctorId), patient: patientOf(r.patientId) })

/** 開立的對象：看完診、這次看診的醫師 */
function outTarget(encounterId: string) {
  const u = requireUser('doctor')
  const e = must(db.encounters.find((x) => x.id === encounterId), '病歷')
  const v = must(find.visit(e.visitId), '掛號紀錄')
  if (v.doctorId !== u.doctorId) fail('只能替自己看的病人開轉診單', 'FORBIDDEN')
  if (e.status !== 'completed') fail('完成看診後才能開轉診單（轉診單附的是這次的診斷與用藥）', 'CONFLICT')
  return { u, e }
}

/** 轉診單預設內容：病情摘要帶這次的 S／O／A */
export function referralOutDraft(encounterId: string): Promise<ReferralOutInput> {
  return query(() => {
    const { e } = outTarget(encounterId)
    const summary = [e.subjective && `主訴：${e.subjective}`, e.objective && `檢查：${e.objective}`, e.assessment && `評估：${e.assessment}`].filter(Boolean).join('\n')
    return { toHospital: '', toDept: '', purpose: REFERRAL_PURPOSES[0], urgent: false, summary }
  })
}

/** 轉診單號：民國年＋流水號（每年重編） */
function nextNo(at: string): string {
  const roc = Number(at.slice(0, 4)) - 1911
  return `${roc} 轉字第 ${String(nextCounter(`referral:${roc}`)).padStart(6, '0')} 號`
}

export function issueReferral(encounterId: string, input: ReferralOutInput): Promise<ReferralOutView> {
  return mutate(() => {
    const { u, e } = outTarget(encounterId)
    const err: Record<string, string> = {}
    if (!input.toHospital?.trim()) err.toHospital = '請寫建議轉診的院所'
    if (!input.toDept?.trim()) err.toDept = '請寫建議的科別'
    if (!(REFERRAL_PURPOSES as readonly string[]).includes(input.purpose)) err.purpose = '請選擇轉診目的'
    if (!input.summary?.trim()) err.summary = '請寫病情摘要'
    failFields(err)
    const t = now()
    const r: ReferralOut = {
      id: newId('RF'), no: nextNo(t), patientId: e.patientId, encounterId: e.id, deptId: e.deptId, doctorId: u.doctorId!, date: e.date,
      toHospital: input.toHospital.trim(), toDept: input.toDept.trim(), purpose: input.purpose, urgent: !!input.urgent, summary: input.summary.trim(),
      diagnoses: e.diagnoses.map((d) => `${d.icd} ${d.name}`),
      meds: e.medications.map((m) => `${find.drug(m.drugId)?.name ?? m.drugId}（${m.dose} ${m.freq} ${m.days} 天）`),
      exams: e.procedures.map((p) => find.procedure(p.procId)?.name ?? p.procId),
      issuedAt: t,
    }
    db.referrals.push(r)
    audit('開立轉診單', `${r.no} ${nameOf.patient(r.patientId)} → ${r.toHospital} ${r.toDept}（${r.purpose}${r.urgent ? '，急' : ''}）`)
    return outView(r)
  })
}

export function listReferralsOut(q: { encounterId?: string; patientId?: string }): Promise<ReferralOutView[]> {
  return query(() => {
    requireUser('doctor', 'clerk', 'nurse', 'admin')
    return db.referrals
      .filter((r) => (q.encounterId ? r.encounterId === q.encounterId : r.patientId === q.patientId))
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
      .map(outView)
  })
}

/** 作廢（開錯了）：開立的醫師；作廢的不能印 */
export function voidReferral(id: string, reason: string): Promise<ReferralOutView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const r = must(db.referrals.find((x) => x.id === id), '轉診單')
    if (r.doctorId !== u.doctorId) fail('只有開立的醫師可以作廢', 'FORBIDDEN')
    if (r.voided) fail('這張已作廢', 'CONFLICT')
    const why = reason?.trim()
    failFields(why ? {} : { reason: '請寫作廢原因' })
    r.voided = { at: now(), by: u.id, reason: why! }
    audit('作廢轉診單', `${r.no} ${nameOf.patient(r.patientId)}：${why}`)
    return outView(r)
  })
}

/** 列印（醫師、櫃台，可重印）：記下誰、何時印 */
export function printReferral(id: string): Promise<ReferralOutView> {
  return mutate(() => {
    const u = requireUser('doctor', 'clerk')
    const r = must(db.referrals.find((x) => x.id === id), '轉診單')
    if (r.voided) fail('這張已作廢，不能列印', 'CONFLICT')
    r.printed = [...(r.printed ?? []), { at: now(), by: u.id }]
    audit('列印轉診單', `${r.no} ${nameOf.patient(r.patientId)}`)
    return outView(r)
  })
}
