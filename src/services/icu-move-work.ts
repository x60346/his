// 加護病房轉入轉出的內部工具（index 不匯出、不會被包成 API）：轉床進出加護病房的把關（要有同意的申請、轉出要摘要、
// 還接著呼吸器不能轉出）、轉床之後的收尾、住了哪幾段、轉出摘要、SOFA／APACHE II 要的數值。規則在 icu-score-rules
import type { Admission, Bed, ProgressNote } from '@/types'
import { db } from '@/mock/db'
import { addMinutes, ageOf } from '@/utils/date'
import { find } from './views'
import { isIcuBed } from './bed-work'
import { icuSince } from './icu-work'
import { activeVent } from './vent-work'
import { gcsTotal, mapOf } from './icu-rules'
import { icuStays, type ApacheInput, type SofaInput } from './icu-score-rules'

/** 同意了、還沒排床的申請 */
export const acceptedRequest = (admissionId: string) => db.icuRequests.find((r) => r.admissionId === admissionId && r.status === 'accepted')
/** 還在走的申請（待同意、候床） */
export const openRequest = (admissionId: string) => db.icuRequests.find((r) => r.admissionId === admissionId && (r.status === 'pending' || r.status === 'accepted'))
/** 這次住加護病房寫的轉出摘要（最新一份） */
export const icuSummaryOf = (a: Admission): ProgressNote | undefined => {
  const since = icuSince(a)
  if (!since) return undefined
  // 上一段轉出的那一分鐘寫的是上一段的摘要（轉出、再轉回在同一分鐘時分不出先後，算上一段的）
  const prevOut = staysOf(a).filter((s) => s.to && s.to <= since).pop()?.to
  return db.progressNotes.filter((n) => n.admissionId === a.id && n.kind === 'icuOut' && n.at >= since && (!prevOut || n.at > prevOut)).sort((x, y) => x.at.localeCompare(y.at)).pop()
}
/** 嚴重度用的 GCS：插管（言語 T）的不算——言語沒辦法評，硬算會讓分數偏重 */
const sofaGcs = (g: Parameters<typeof gcsTotal>[0]) => (g && !g.vt ? gcsTotal(g) : undefined)

/**
 * 轉床（住院中心轉床、轉科選床）進出加護病房的把關：
 *   - 進：要有加護病房主治同意的申請（急診收住院在報到時處理，不走這裡）
 *   - 出：要先寫轉出摘要；還接著呼吸器不能轉出
 */
export function icuMoveProblem(a: Admission, to: Pick<Bed, 'ward'>): string | undefined {
  const from = find.bed(a.bedId ?? '')
  if (isIcuBed(to) && !isIcuBed(from) && !acceptedRequest(a.id)) return '轉入加護病房要先由主治申請、加護病房主治同意（住院醫囑「加護病房」分頁）'
  if (!isIcuBed(to) && isIcuBed(from)) {
    if (activeVent(a.id)) return '還接著呼吸器：不能轉出加護病房（請醫師先停止呼吸器）'
    if (!icuSummaryOf(a)) return '轉出加護病房：請醫師先寫加護病房轉出摘要（住院醫囑「加護病房」分頁）'
  }
  return undefined
}
/** 轉床之後：轉進加護病房的申請標「已排床」；轉出的鎮靜目標清掉 */
export function afterIcuMove(a: Admission, fromBed: Bed | undefined, toBed: Bed, t: string): void {
  if (isIcuBed(toBed) && !isIcuBed(fromBed)) {
    const r = acceptedRequest(a.id)
    if (r) Object.assign(r, { status: 'placed', placedAt: t, bedId: toBed.id })
  }
  if (!isIcuBed(toBed) && isIcuBed(fromBed)) delete a.rassTarget
}

/** 這筆住院住加護病房的幾段 */
export function staysOf(a: Admission) {
  const hist = a.bedHistory?.length ? a.bedHistory : a.bedId && a.admittedAt ? [{ bedId: a.bedId, from: a.admittedAt }] : []
  return icuStays(hist.map((h) => ({ from: h.from, icu: isIcuBed(find.bed(h.bedId)) })), a.dischargedAt)
}

/** 剛從加護病房轉出（48 小時內）：交班帶出轉出摘要 */
export function recentIcuOut(a: Admission, t: string): { at: string; note?: ProgressNote } | undefined {
  const last = staysOf(a).filter((s) => s.to && s.to <= t && s.to >= addMinutes(t, -48 * 60) && (!a.dischargedAt || s.to < a.dischargedAt)).pop()
  if (!last) return undefined
  const note = db.progressNotes.filter((n) => n.admissionId === a.id && n.kind === 'icuOut' && n.at >= last.from && n.at <= last.to!).pop()
  return { at: last.to!, ...(note ? { note } : {}) }
}

// ---------- 嚴重度要的數值 ----------
const labNums = (a: Admission, code: string, from: string, to: string) =>
  db.labReports.filter((r) => r.admissionId === a.id && r.reportedAt >= from && r.reportedAt < to).flatMap((r) => r.values.filter((v) => v.code === code).map((v) => ({ at: r.reportedAt, value: Number(v.value) }))).filter((x) => !Number.isNaN(x.value))
/** 某個時間的 FiO2：接著呼吸器用設定值，沒接當作室內空氣 21% */
const fio2At = (a: Admission, at: string) => {
  const o = db.ipdOrders.find((x) => x.admissionId === a.id && x.vent && x.startAt <= at && (!x.stopAt || x.stopAt > at))
  return { fio2: (o?.vent?.fio2 ?? 21) / 100, vent: !!o }
}
const abgs = (a: Admission, from: string, to: string) =>
  db.labReports.filter((r) => r.admissionId === a.id && r.procId === 'P052' && r.reportedAt >= from && r.reportedAt < to).map((r) => {
    const n = (c: string) => Number(r.values.find((v) => v.code === c)?.value)
    return { at: r.reportedAt, pao2: n('PaO2'), paco2: n('PaCO2'), ph: n('pH'), ...fio2At(a, r.reportedAt) }
  }).filter((x) => !Number.isNaN(x.pao2))
const vitalsIn = (a: Admission, from: string, to: string) => db.vitals.filter((v) => v.admissionId === a.id && v.at >= from && v.at < to)

/** SOFA 一天（[from, to)）：各項取最差；尿量要一整天才算 */
export function sofaInputOf(a: Admission, from: string, to: string, fullDay: boolean): SofaInput {
  const vs = vitalsIn(a, from, to)
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : undefined)
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : undefined)
  const pfs = abgs(a, from, to).map((g) => ({ ratio: Math.round(g.pao2 / g.fio2), vent: g.vent }))
  const pf = pfs.length ? pfs.reduce((b, x) => (x.ratio < b.ratio ? x : b)) : undefined
  const outs = vs.filter((v) => v.output !== undefined)
  return {
    ...(pf ? { pf } : {}),
    ...(min(labNums(a, 'PLT', from, to).map((x) => x.value)) !== undefined ? { plt: min(labNums(a, 'PLT', from, to).map((x) => x.value)) } : {}),
    ...(max(labNums(a, 'T-BIL', from, to).map((x) => x.value)) !== undefined ? { bili: max(labNums(a, 'T-BIL', from, to).map((x) => x.value)) } : {}),
    ...(min(vs.map((v) => mapOf(v.sbp, v.dbp)).filter((x): x is number => x !== undefined)) !== undefined ? { map: min(vs.map((v) => mapOf(v.sbp, v.dbp)).filter((x): x is number => x !== undefined)) } : {}),
    ...(min(vs.map((v) => sofaGcs(v.gcs)).filter((x): x is number => x !== undefined)) !== undefined ? { gcs: min(vs.map((v) => sofaGcs(v.gcs)).filter((x): x is number => x !== undefined)) } : {}),
    ...(max(labNums(a, 'CRE', from, to).map((x) => x.value)) !== undefined ? { cre: max(labNums(a, 'CRE', from, to).map((x) => x.value)) } : {}),
    ...(fullDay && outs.length ? { urine: outs.reduce((n, v) => n + v.output!, 0) } : {}),
  }
}

/** APACHE II：轉入後 24 小時內的值 */
export function apacheInputOf(a: Admission, since: string): ApacheInput {
  const to = addMinutes(since, 24 * 60)
  const vs = vitalsIn(a, since, to)
  const nums = (f: (v: (typeof vs)[number]) => number | undefined) => vs.map(f).filter((x): x is number => x !== undefined && x !== null)
  const g = abgs(a, since, to)
  const p = find.patient(a.patientId)
  return {
    temp: nums((v) => v.temp), map: nums((v) => mapOf(v.sbp, v.dbp)), hr: nums((v) => v.pulse), rr: nums((v) => v.resp),
    oxy: g.filter((x) => !Number.isNaN(x.paco2)).map((x) => ({ fio2: x.fio2, pao2: x.pao2, paco2: x.paco2 })),
    ph: g.map((x) => x.ph).filter((x) => !Number.isNaN(x)),
    na: labNums(a, 'NA', since, to).map((x) => x.value), k: labNums(a, 'K', since, to).map((x) => x.value), hct: labNums(a, 'HCT', since, to).map((x) => x.value),
    cre: labNums(a, 'CRE', since, to).map((x) => x.value), wbc: labNums(a, 'WBC', since, to).map((x) => x.value),
    gcs: nums((v) => sofaGcs(v.gcs)),
    age: p ? ageOf(p.birthDate, since.slice(0, 10)) : 0,
    chronic: a.apache?.chronic ?? false, surgery: a.apache?.surgery ?? 'none',
  }
}
