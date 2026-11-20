// 健保申報的內部工具（index 不匯出、不會被包成 API）：從收據算出每一筆現在的申報內容與檢核、送出過的合計、補報。
// API 在 claim.ts、規則在 claim-rules
import type { Admission, ClaimItem, ClaimKind, Visit } from '@/types'
import { db } from '@/mock/db'
import { ipdCategories, ipdClaimProblems, linePoints, monthOf, opdClaimProblems, supplementDelta, supplementMonth } from './claim-rules'
import { ipdDays } from './billing'
import { find } from './views'


export interface ClaimRow extends ClaimItem {
  problems: string[]
}

// ---------- 門診 ----------

/** 一次就醫有效的收據（主收據＋補收；作廢、退費的不算）；病歷影本、住院的不算 */
const visitCharges = (visitId: string) => db.charges.filter((c) => c.visitId === visitId && !c.voided && !c.admissionId && !c.copyRequestId)

/** 主診斷：這次的病歷（慢箋領藥用原處方那次） */
function opdDiagnosis(v: Visit) {
  const e = v.refillOf ? db.encounters.find((x) => x.id === v.refillOf) : db.encounters.find((x) => x.visitId === v.id)
  return e?.diagnoses.find((d) => d.primary) ?? e?.diagnoses[0]
}

/** 這次就醫現在的申報內容（沒有有效收據、或是自費身分＝不申報） */
export function opdItemOf(v: Visit): ClaimItem | undefined {
  const cs = visitCharges(v.id)
  if (!cs.length) return undefined
  if (db.identities.find((i) => i.code === v.identityCode)?.selfPay) return undefined
  const d = opdDiagnosis(v)
  return { refId: v.id, patientId: v.patientId, doctorId: v.doctorId, deptId: v.deptId, date: v.date, caseType: v.caseType, diagnosis: d ? `${d.icd} ${d.name}` : '', ...linePoints(cs.flatMap((c) => c.lines)) }
}

export function opdRowOf(v: Visit, item: ClaimItem): ClaimRow {
  const d = opdDiagnosis(v)
  const dup = db.visits.filter((x) => x.id !== v.id && x.patientId === v.patientId && x.date === v.date && x.deptId === v.deptId && x.createdAt < v.createdAt && opdItemOf(x)).at(-1)
  return { ...item, problems: opdClaimProblems({ diagnosis: d?.icd, diagnosisActive: d ? db.icdCodes.find((c) => c.code === d.icd)?.active !== false : undefined, points: item.points, ...(dup ? { duplicateOf: `${dup.date} 第 ${dup.seqNo} 號` } : {}) }) }
}

// ---------- 住院 ----------

const ipdCharge = (a: Admission) => db.charges.find((c) => c.admissionId === a.id && !c.voided)
const dayAdm = (a: Admission) => !!a.day && !a.day.converted

/** 這次住院現在的申報內容（出院、已結帳；自費身分不申報） */
export function ipdItemOf(a: Admission): ClaimItem | undefined {
  const c = ipdCharge(a)
  if (!c || a.status !== 'discharged' || !a.dischargedAt) return undefined
  const p = find.patient(a.patientId)
  if (db.identities.find((i) => i.code === p?.defaultIdentity)?.selfPay) return undefined
  const categories = ipdCategories(c.lines, (n) => db.procedures.find((x) => x.name === n))
  const lp = linePoints(c.lines)
  const day = dayAdm(a)
  const diag = day ? a.diagnosis : a.dischargeSummary?.diagnosis
  return {
    refId: a.id, patientId: a.patientId, doctorId: a.doctorId, deptId: a.deptId, date: a.dischargedAt.slice(0, 10), caseType: day ? 'DAY' : 'IPD', diagnosis: diag?.trim() ?? '',
    ...lp, categories, days: c.ipd?.days ?? ipdDays(a.admittedAt ?? a.dischargedAt, a.dischargedAt),
  }
}

export function ipdRowOf(a: Admission, item: ClaimItem): ClaimRow {
  const c = ipdCharge(a)
  const implantMissing = db.surgeries.filter((s) => s.admissionId === a.id && s.status === 'done' && find.procedure(s.procId)?.surgery?.implant && !s.implants?.length).map((s) => s.no)
  return {
    ...item,
    problems: ipdClaimProblems({ day: dayAdm(a), diagnosis: item.diagnosis, signed: !!a.dischargeSummary?.signedAt, implantMissing, ...(c?.ipd ? { daysBill: c.ipd.days } : {}), daysActual: ipdDays(a.admittedAt ?? a.dischargedAt!, a.dischargedAt!), points: item.points }),
  }
}

// ---------- 月份：這個月的申報清單（還沒送：現在算的＋補報；送了：送出的那份） ----------

const submissionOf = (kind: ClaimKind, month: string) => db.claimSubmissions.find((s) => s.kind === kind && s.month === month)
const submittedFor = (kind: ClaimKind, refId: string) => db.claimSubmissions.filter((s) => s.kind === kind).flatMap((s) => s.items.filter((x) => x.refId === refId))
const excludedEver = (kind: ClaimKind, refId: string) => db.claimSubmissions.some((s) => s.kind === kind && s.excluded.some((x) => x.refId === refId))

/** 所有申報對象（門診：就醫；住院：出院的住院）與它所屬的月份、現在的內容 */
function allRefs(kind: ClaimKind): { refId: string; month: string; item?: ClaimItem; row: (it: ClaimItem) => ClaimRow }[] {
  if (kind === 'opd') return db.visits.map((v) => ({ refId: v.id, month: monthOf(v.date), item: opdItemOf(v), row: (it: ClaimItem) => opdRowOf(v, it) }))
  return db.admissions.filter((a) => a.status === 'discharged' && a.dischargedAt).map((a) => ({ refId: a.id, month: monthOf(a.dischargedAt!), item: ipdItemOf(a), row: (it: ClaimItem) => ipdRowOf(a, it) }))
}

/** 還沒送的月份的清單：這個月的＋之前已送月份改過的（補報差額，不用檢核） */
export function openMonthRows(kind: ClaimKind, month: string, current: string): ClaimRow[] {
  const out: ClaimRow[] = []
  const done = (m: string) => !!submissionOf(kind, m)
  for (const r of allRefs(kind)) {
    if (r.month === month && !done(r.month)) {
      if (r.item) out.push(r.row(r.item))
    } else if (done(r.month) && !excludedEver(kind, r.refId) && supplementMonth(r.month, done, current) === month) {
      const prev = submittedFor(kind, r.refId)
      const delta = supplementDelta(r.item, prev)
      if (!delta) continue
      const base = r.item ?? prev[0]
      const dp = Math.round(((r.item?.points ?? 0) - prev.reduce((n, x) => n + x.points, 0)) * 100) / 100
      const dc = Math.round(((r.item?.copay ?? 0) - prev.reduce((n, x) => n + x.copay, 0)) * 100) / 100
      out.push({ ...base, points: dp, copay: dc, claim: delta, categories: undefined, supplementOf: r.month, problems: [] })
    }
  }
  return out.sort((a, b) => Number(!!a.supplementOf) - Number(!!b.supplementOf) || a.date.localeCompare(b.date))
}

/** 有申報資料的月份（新到舊）：有就醫／出院的、送過的 */
export function claimMonthsOf(kind: ClaimKind, current: string): string[] {
  const ms = new Set([...allRefs(kind).map((r) => r.month), ...db.claimSubmissions.filter((s) => s.kind === kind).map((s) => s.month)])
  return [...ms].filter((m) => m <= current).sort().reverse()
}

export { submissionOf }
