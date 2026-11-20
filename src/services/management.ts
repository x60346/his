// 經營月報（權限「經營報表」，預設管理員）：一個月的門診人次（科別、醫師、初診複診）、住院（入出院、佔床率、平均住院天數）、
// 收入（和日結同一份計算：buildDailyReport）、藥費占比、檢驗影像量；和上個月、去年同月比較；近 12 個月趨勢。
// 不另外存資料：全部從就醫、住院、收據、報告推算。沒有資料的月份（示範資料只有最近幾個月）值是 null，畫面顯示「—」
import { db } from '@/mock/db'
import { addDays, diffDays, today } from '@/utils/date'
import { failField, query, requirePermission } from './http'
import { buildDailyReport, type DailyReport } from './daily-report'
import { monthRange, shiftMonth } from './management-rules'
import { nameOf } from './views'
import { isObsBed } from './bed-work'
import { givenAbxDoses } from './abx-metrics-work'
import { perThousand } from './abx-metrics-rules'
import { ipdItemOf } from './claim-work'

const SEEN = new Set(['consulted', 'charged', 'dispensed'])

export interface MonthMetrics {
  month: string
  from: string
  to: string
  /** 這個月有沒有任何資料（就醫、收據、住院）：沒有的話其他值都是 null */
  hasData: boolean
  opdVisits: number | null
  opdFirst: number | null
  opdRevisit: number | null
  admissions: number | null
  discharges: number | null
  /** 住院人日（每天午夜在院的人數加總） */
  patientDays: number | null
  /** 佔床率 %＝住院人日 ÷（病床數 × 天數） */
  occupancy: number | null
  /** 平均住院天數（這個月出院的人） */
  alos: number | null
  /** 抗生素用量：這個月已給的抗生素 DDD ÷ 住院人日 × 1000（依給藥紀錄；和抗生素審核頁「指標」同一套算法，分母用本報表的住院人日） */
  abxDdd: number | null
  /** 實收（和日結同一個數） */
  collected: number | null
  /** 應收（收據金額）依來源 */
  revenueOpd: number | null
  revenueIpd: number | null
  revenueOther: number | null
  nhiPoints: number | null
  /** 藥費占比 %＝藥品申報點數 ÷ 申報點數 */
  drugShare: number | null
  labReports: number | null
  imagingReports: number | null
  /** 門診有開藥的看診數 */
  prescriptions: number | null
  byFeeType: DailyReport['byFeeType'] | null
}

const round1 = (x: number) => Math.round(x * 10) / 10
/** 病房的住院與床位：急診留觀不算住院（留觀轉住院的算；住院日從入院起算的簡化，見 README） */
const wardAdmissions = () => db.admissions.filter((a) => !a.obs || a.obs.outcome === 'admit')
const wardBeds = () => db.beds.filter((b) => !isObsBed(b)).length
const inR = (at: string | undefined, from: string, to: string) => !!at && at.slice(0, 10) >= from && at.slice(0, 10) <= to

function metricsOf(month: string, t: string): MonthMetrics {
  const { from, to } = monthRange(month, t)
  const visits = db.visits.filter((v) => v.date >= from && v.date <= to)
  const seen = visits.filter((v) => SEEN.has(v.status))
  const charges = db.charges.filter((c) => inR(c.paidAt, from, to))
  const stayed = (d: string) => wardAdmissions().filter((a) => a.admittedAt && a.admittedAt.slice(0, 10) <= d && (!a.dischargedAt || a.dischargedAt.slice(0, 10) > d) && a.status !== 'cancelled').length
  let patientDays = 0
  for (let d = from; d <= to; d = addDays(d, 1)) patientDays += stayed(d)
  const hasData = visits.length > 0 || charges.length > 0 || patientDays > 0
  const empty: MonthMetrics = {
    month, from, to, hasData, opdVisits: null, opdFirst: null, opdRevisit: null, admissions: null, discharges: null, patientDays: null, occupancy: null, alos: null, abxDdd: null,
    collected: null, revenueOpd: null, revenueIpd: null, revenueOther: null, nhiPoints: null, drugShare: null, labReports: null, imagingReports: null, prescriptions: null, byFeeType: null,
  }
  if (!hasData) return empty
  const days = diffDays(from, to) + 1
  const beds = wardBeds()
  const disc = wardAdmissions().filter((a) => a.admittedAt && inR(a.dischargedAt, from, to))
  const rep = buildDailyReport(from, to, () => 0)
  const sumDept = (pred: (n: string) => boolean) => rep.byDept.filter((d) => pred(d.deptName)).reduce((n, d) => n + d.patientTotal, 0)
  const valid = charges.filter((c) => !c.voided || c.refund)
  const drugPts = valid.reduce((n, c) => n + c.lines.filter((l) => l.kind === 'drug' && !l.patientPay).reduce((m, l) => m + l.amount, 0), 0)
  return {
    ...empty,
    opdVisits: seen.length, opdFirst: seen.filter((v) => v.firstVisit).length, opdRevisit: seen.filter((v) => !v.firstVisit).length,
    admissions: wardAdmissions().filter((a) => inR(a.admittedAt, from, to)).length, discharges: disc.length, patientDays,
    occupancy: beds ? round1((patientDays / (beds * days)) * 100) : null,
    alos: disc.length ? round1(disc.reduce((n, a) => n + Math.max(1, diffDays(a.admittedAt!.slice(0, 10), a.dischargedAt!.slice(0, 10))), 0) / disc.length) : null,
    abxDdd: perThousand(givenAbxDoses(from, to).reduce((n, d) => n + d.ddd, 0), patientDays),
    collected: rep.collected,
    revenueIpd: sumDept((n) => n.endsWith('（住院）')),
    revenueOther: sumDept((n) => n === '病歷影本'),
    revenueOpd: sumDept((n) => !n.endsWith('（住院）') && n !== '病歷影本'),
    nhiPoints: rep.nhiPoints,
    drugShare: rep.nhiPoints ? round1((drugPts / valid.reduce((n, c) => n + c.nhiPoints, 0)) * 100) : null,
    labReports: db.labReports.filter((r) => inR(r.reportedAt, from, to)).length,
    imagingReports: db.imagingReports.filter((r) => inR(r.reportedAt, from, to)).length,
    prescriptions: db.encounters.filter((e) => e.status === 'completed' && e.medications.length && e.date >= from && e.date <= to).length,
    byFeeType: rep.byFeeType,
  }
}

export interface ManagementReport {
  month: string
  from: string
  to: string
  /** 本月還沒過完（只算到今天） */
  partial: boolean
  beds: number
  current: MonthMetrics
  prev: MonthMetrics
  lastYear: MonthMetrics
  opdByDept: { deptName: string; visits: number; first: number; share: number }[]
  opdByDoctor: { doctorName: string; deptName: string; visits: number }[]
  ipdByDept: { deptName: string; admissions: number; discharges: number; patientDays: number }[]
  /** DRG 盈虧（這個月出院、已結帳、適用 DRG 的）：每組幾筆、實際點數、給付點數、盈虧，賠最多的在前；不適用幾筆 */
  drg: { rows: { code: string; name: string; count: number; actual: number; pay: number; diff: number }[]; exempt: number }
  /** 近 12 個月（含本月，舊的在前） */
  trend: { month: string; hasData: boolean; opdVisits: number | null; collected: number | null; occupancy: number | null }[]
}

/** 這段期間出院、已結帳的住院：依 DRG 分組合計盈虧（和住院申報同一份算法） */
function drgByGroup(from: string, to: string): ManagementReport['drg'] {
  const items = db.admissions.filter((a) => a.status === 'discharged' && a.dischargedAt && a.dischargedAt.slice(0, 10) >= from && a.dischargedAt.slice(0, 10) <= to).map(ipdItemOf).filter((x) => !!x)
  const m = new Map<string, { code: string; name: string; count: number; actual: number; pay: number; diff: number }>()
  for (const it of items) {
    if (!it.drg) continue
    const r = m.get(it.drg.code) ?? { code: it.drg.code, name: it.drg.name, count: 0, actual: 0, pay: 0, diff: 0 }
    r.count++
    r.actual += Math.round(it.points)
    r.pay += it.drg.pay
    r.diff += it.drg.diff
    m.set(it.drg.code, r)
  }
  return { rows: [...m.values()].sort((a, b) => a.diff - b.diff), exempt: items.filter((x) => x.drgExempt).length }
}

/** 月報：月份 YYYY-MM，不能是未來 */
export function managementReport(month: string): Promise<ManagementReport> {
  return query(() => {
    requirePermission('report.management')
    const t = today()
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) failField('month', '請選擇月份')
    if (month > t.slice(0, 7)) failField('month', '還沒到這個月')
    const { from, to, partial } = monthRange(month, t)
    const current = metricsOf(month, t)
    const visits = db.visits.filter((v) => v.date >= from && v.date <= to && SEEN.has(v.status))
    const dept = new Map<string, { deptName: string; visits: number; first: number; share: number }>()
    const doc = new Map<string, { doctorName: string; deptName: string; visits: number }>()
    for (const v of visits) {
      const d = dept.get(v.deptId) ?? { deptName: nameOf.dept(v.deptId), visits: 0, first: 0, share: 0 }
      d.visits++
      if (v.firstVisit) d.first++
      dept.set(v.deptId, d)
      const k = `${v.doctorId}|${v.deptId}`
      const x = doc.get(k) ?? { doctorName: nameOf.doctor(v.doctorId), deptName: nameOf.dept(v.deptId), visits: 0 }
      x.visits++
      doc.set(k, x)
    }
    for (const d of dept.values()) d.share = visits.length ? round1((d.visits / visits.length) * 100) : 0
    const ipd = new Map<string, { deptName: string; admissions: number; discharges: number; patientDays: number }>()
    for (const a of wardAdmissions().filter((x) => x.admittedAt && x.status !== 'cancelled')) {
      const row = ipd.get(a.deptId) ?? { deptName: nameOf.dept(a.deptId), admissions: 0, discharges: 0, patientDays: 0 }
      if (inR(a.admittedAt, from, to)) row.admissions++
      if (inR(a.dischargedAt, from, to)) row.discharges++
      for (let d = from; d <= to; d = addDays(d, 1)) if (a.admittedAt!.slice(0, 10) <= d && (!a.dischargedAt || a.dischargedAt.slice(0, 10) > d)) row.patientDays++
      if (row.admissions || row.discharges || row.patientDays) ipd.set(a.deptId, row)
    }
    const trend = Array.from({ length: 12 }, (_, i) => {
      const m = shiftMonth(month, i - 11)
      const x = i === 11 ? current : metricsOf(m, t)
      return { month: m, hasData: x.hasData, opdVisits: x.opdVisits, collected: x.collected, occupancy: x.occupancy }
    })
    return {
      month, from, to, partial, beds: wardBeds(), current,
      prev: metricsOf(shiftMonth(month, -1), t), lastYear: metricsOf(shiftMonth(month, -12), t),
      opdByDept: [...dept.values()].sort((a, b) => b.visits - a.visits),
      opdByDoctor: [...doc.values()].sort((a, b) => b.visits - a.visits),
      ipdByDept: [...ipd.values()].sort((a, b) => b.patientDays - a.patientDays),
      drg: drgByGroup(from, to),
      trend,
    }
  })
}
