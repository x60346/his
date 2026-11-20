// 健保申報的內部工具（index 不匯出、不會被包成 API）：從收據算出每一筆現在的申報內容與檢核、送出過的合計、補報。
// API 在 claim.ts、規則在 claim-rules
import type { Admission, ClaimItem, ClaimKind, Visit } from '@/types'
import { db } from '@/mock/db'
import { INTERIM_DAYS, interimDaysOf, ipdCategories, ipdClaimPoints, ipdClaimProblems, linePoints, monthEnd, monthOf, opdClaimProblems, supplementDelta, supplementMonth } from './claim-rules'
import { ipdBillOf } from './ipd-bill'
import { ipdDays } from './billing'
import { find } from './views'
import { preAuthUnapproved } from './preauth-work'
import { drgExemptOf, drgOfAdmission } from './drg-work'


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
  const diag = a.coding?.mainDiagnosis ?? (day ? a.diagnosis : a.dischargeSummary?.diagnosis)
  return {
    refId: a.id, patientId: a.patientId, doctorId: a.doctorId, deptId: a.deptId, date: a.dischargedAt.slice(0, 10), caseType: day ? 'DAY' : 'IPD', diagnosis: diag?.trim() ?? '',
    ...lp, ...ipdClaimPoints(lp, drgOfAdmission(a), drgExemptOf(a, a.dischargedAt)), categories, days: c.ipd?.days ?? ipdDays(a.admittedAt ?? a.dischargedAt, a.dischargedAt),
  }
}

export function ipdRowOf(a: Admission, item: ClaimItem): ClaimRow {
  const c = ipdCharge(a)
  const implantMissing = db.surgeries.filter((s) => s.admissionId === a.id && s.status === 'done' && find.procedure(s.procId)?.surgery?.implant && !s.implants?.length).map((s) => s.no)
  return {
    ...item,
    problems: ipdClaimProblems({ coded: !!a.coding, day: dayAdm(a), diagnosis: item.diagnosis, signed: !!a.dischargeSummary?.signedAt, implantMissing, preAuth: preAuthUnapproved(a.id), ...(c?.ipd ? { daysBill: c.ipd.days } : {}), daysActual: ipdDays(a.admittedAt ?? a.dischargedAt!, a.dischargedAt!), points: item.points }),
  }
}

// ---------- 住院期中申報 ----------

/** m 月要期中申報的住院：到月底住滿 30 天、還沒出院（日間手術、急診留觀中的不算）；點數＝帳單算到月底的累計 − 之前報過的 */
function interimRows(m: string): ClaimRow[] {
  const end = monthEnd(m)
  const out: ClaimRow[] = []
  for (const a of db.admissions) {
    if (a.status === 'cancelled' || a.status === 'reserved' || (a.day && !a.day.converted) || (a.obs && !a.obs.endAt)) continue
    const days = interimDaysOf(a, m)
    if (days === undefined || days < INTERIM_DAYS) continue
    const lp = linePoints(ipdBillOf(a, end).lines)
    const prev = submittedFor('ipd', a.id)
    const r2 = (n: number) => Math.round(n * 100) / 100
    const claim = lp.claim - prev.reduce((n, x) => n + x.claim, 0)
    if (claim <= 0) continue
    const diag = a.diagnosis?.trim() ?? ''
    out.push({
      refId: a.id, patientId: a.patientId, doctorId: a.doctorId, deptId: a.deptId, date: end, caseType: 'IPD', diagnosis: diag,
      points: r2(lp.points - prev.reduce((n, x) => n + x.points, 0)), copay: r2(lp.copay - prev.reduce((n, x) => n + x.copay, 0)), claim, days, interim: { through: end },
      problems: diag ? [] : ['沒有入院診斷'],
    })
  }
  return out
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
      // 出院那筆：之前期中申報過的，只報差額（DRG 照整次住院算，申請點數扣掉期中報過的）
      const prior = kind === 'ipd' ? submittedFor(kind, r.refId).filter((x) => x.interim) : []
      if (r.item && prior.length) {
        const row = r.row(r.item)
        const p = (k: 'points' | 'copay' | 'claim') => Math.round((row[k] - prior.reduce((n, x) => n + x[k], 0)) * 100) / 100
        out.push({ ...row, points: p('points'), copay: p('copay'), claim: p('claim'), interimPrior: prior.reduce((n, x) => n + x.claim, 0) })
      } else if (r.item) out.push(r.row(r.item))
    } else if (done(r.month) && !excludedEver(kind, r.refId) && supplementMonth(r.month, done, current) === month) {
      const prev = submittedFor(kind, r.refId)
      const delta = supplementDelta(r.item, prev)
      if (!delta) continue
      const base = r.item ?? prev[0]
      const dp = Math.round(((r.item?.points ?? 0) - prev.reduce((n, x) => n + x.points, 0)) * 100) / 100
      const dc = Math.round(((r.item?.copay ?? 0) - prev.reduce((n, x) => n + x.copay, 0)) * 100) / 100
      const note = supplementNoteOf(prev, r.item)
      out.push({ ...base, points: dp, copay: dc, claim: delta, categories: undefined, supplementOf: r.month, ...(note ? { supplementNote: note } : {}), problems: [] })
    }
  }
  if (kind === 'ipd' && month < current && !done(month)) out.push(...interimRows(month))
  return out.sort((a, b) => Number(!!a.supplementOf) - Number(!!b.supplementOf) || Number(!!a.interim) - Number(!!b.interim) || a.date.localeCompare(b.date))
}

/** 補報的原因：和最後一次送出的比，DRG 或主診斷變了（改碼）；其他（補收、作廢）不寫 */
export function supplementNoteOf(prev: ClaimItem[], cur: ClaimItem | undefined): string | undefined {
  const last = prev.at(-1)
  if (!last || !cur) return undefined
  const lastDrg = [...prev].reverse().find((x) => x.drg || x.drgExempt)
  const parts: string[] = []
  if (lastDrg?.drg && cur.drg && lastDrg.drg.code !== cur.drg.code) parts.push(`DRG ${lastDrg.drg.code} → ${cur.drg.code}`)
  if (last.diagnosis && cur.diagnosis && last.diagnosis.split(' ')[0] !== cur.diagnosis.split(' ')[0]) parts.push(`主診斷 ${last.diagnosis.split(' ')[0]} → ${cur.diagnosis.split(' ')[0]}`)
  return parts.length ? `改碼：${parts.join('、')}` : undefined
}

/**
 * 這一筆送過了嗎（給編碼更正看）：原本那個月送出了（不是排除）→ 現在算的和送過的差多少、會列在哪個月補報
 */
export function claimedState(kind: ClaimKind, refId: string, month: string, item: ClaimItem | undefined, current: string): { month: string; delta: number; supplementMonth?: string } | undefined {
  if (!submissionOf(kind, month) || excludedEver(kind, refId)) return undefined
  const prev = submittedFor(kind, refId)
  if (!prev.length) return undefined
  const sm = supplementMonth(month, (m) => !!submissionOf(kind, m), current)
  return { month, delta: supplementDelta(item, prev), ...(sm ? { supplementMonth: sm } : {}) }
}

/** 有申報資料的月份（新到舊）：有就醫／出院的、送過的 */
export function claimMonthsOf(kind: ClaimKind, current: string): string[] {
  const ms = new Set([...allRefs(kind).map((r) => r.month), ...db.claimSubmissions.filter((s) => s.kind === kind).map((s) => s.month)])
  return [...ms].filter((m) => m <= current).sort().reverse()
}

export { submissionOf }
