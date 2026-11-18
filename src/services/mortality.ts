// 死亡病例審查與品質指標（權限 mortality.review，示範 dr02）：
//   - 最近 N 天的院內死亡：宣告時間、住院幾天、預期或非預期、觸發條件（非預期、入院 48 小時內、術後 30 天內、急救後、加護病房轉出 48 小時內）
//   - 有觸發條件的要審：結論（無可避免、可能可避免、可避免、需提病例討論）、檢討、改善事項；需提病例討論的排日期與報告人
//   - 品質指標：院內死亡率（期間內出院的病人中死亡的比例）、48 小時內死亡、非預期死亡、加護病房死亡率、SMR（實際 ÷ APACHE II 預估）
// 規則在 mortality-rules
import type { Admission } from '@/types'
import { db } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failFields, must, mutate, permissionsOf, query, requirePermission, sessionRole, sessionUser } from './http'
import { find, nameOf } from './views'
import { staysOf } from './icu-move-work'
import { icuPredictedOf, needsMortalityReview, triggersOf } from './mortality-work'
import { minutesBetween } from './news-work'
import { checkMortalityReview, ratePct, reviewGradeLabel, smrOf, TRIGGER_LABEL, type MortalityTrigger, type ReviewGrade } from './mortality-rules'

export interface MortalityCase {
  admissionId: string
  patientName: string
  chartNo: string
  deptName: string
  doctorName: string
  diagnosis: string
  declaredAt: string
  hoursInHospital: number
  expected: boolean
  causes: string[]
  triggers: { key: MortalityTrigger; label: string }[]
  needsReview: boolean
  review?: Admission['mortalityReview'] & { gradeLabel: string; byName: string }
  /** 住過加護病房：轉入時的 APACHE II 預估死亡率 */
  icuPredicted?: number
}
export interface MortalityWork {
  days: number
  cases: MortalityCase[]
  toReview: number
  conferences: { admissionId: string; patientName: string; date: string; presenter: string }[]
  stats: {
    discharges: number
    deaths: number
    mortalityRate: number | null
    early: number
    unexpected: number
    icuStays: number
    icuDeaths: number
    icuMortality: number | null
    /** 預估死亡加總（APACHE II）與 SMR */
    icuExpected: number
    smr: number | null
  }
  canReview: boolean
}

function caseOf(a: Admission): MortalityCase {
  const d = a.death!
  const p = find.patient(a.patientId)
  const trig = triggersOf(a)
  const r = a.mortalityReview
  const pred = icuPredictedOf(a)
  return {
    admissionId: a.id, patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', deptName: nameOf.dept(a.deptId), doctorName: nameOf.doctor(a.doctorId), diagnosis: a.diagnosis,
    declaredAt: d.declaredAt, hoursInHospital: a.admittedAt ? Math.round(minutesBetween(a.admittedAt, d.declaredAt) / 60) : 0, expected: d.expected, causes: d.causes,
    triggers: trig.map((k) => ({ key: k, label: TRIGGER_LABEL[k] })), needsReview: trig.length > 0,
    ...(r ? { review: { ...r, gradeLabel: reviewGradeLabel(r.grade), byName: nameOf.user(r.by) } } : {}),
    ...(pred !== undefined ? { icuPredicted: pred } : {}),
  }
}

export function listMortality(days = 30): Promise<MortalityWork> {
  return query(() => {
    requirePermission('mortality.review')
    const from = addDays(today(), -(days - 1))
    const inRange = (s?: string) => !!s && s.slice(0, 10) >= from
    const dead = db.admissions.filter((a) => a.death && inRange(a.death.declaredAt))
    const cases = dead.map(caseOf).sort((x, y) => Number(!!x.review || !x.needsReview) - Number(!!y.review || !y.needsReview) || y.declaredAt.localeCompare(x.declaredAt))
    // 分母：期間內出院（含死亡出院）、或期間內宣告死亡還沒送太平間的
    const discharged = db.admissions.filter((a) => (a.status === 'discharged' && inRange(a.dischargedAt)) || (a.status === 'admitted' && a.death && inRange(a.death.declaredAt)))
    // 加護病房：期間內出院、住過加護病房的；死亡＝這次住院死亡；預估＝第一次轉入的 APACHE II
    const icu = discharged.filter((a) => staysOf(a).length > 0)
    const icuDeaths = icu.filter((a) => a.death).length
    const icuExpected = Math.round(icu.reduce((n, a) => n + (icuPredictedOf(a) ?? 0) / 100, 0) * 100) / 100
    const u = sessionUser()
    const role = sessionRole()
    return {
      days, cases,
      toReview: cases.filter((c) => c.needsReview && !c.review).length,
      conferences: dead.filter((a) => a.mortalityReview?.conference && a.mortalityReview.conference.date >= today()).map((a) => ({ admissionId: a.id, patientName: nameOf.patient(a.patientId), ...a.mortalityReview!.conference! })).sort((x, y) => x.date.localeCompare(y.date)),
      stats: {
        discharges: discharged.length, deaths: dead.length, mortalityRate: ratePct(dead.length, discharged.length),
        early: cases.filter((c) => c.triggers.some((t) => t.key === 'early')).length,
        unexpected: cases.filter((c) => !c.expected).length,
        icuStays: icu.length, icuDeaths, icuMortality: ratePct(icuDeaths, icu.length), icuExpected, smr: smrOf(icuDeaths, icuExpected),
      },
      canReview: !!u && role === 'doctor' && permissionsOf({ ...u, role }).includes('mortality.review'),
    }
  })
}

export function reviewDeath(admissionId: string, input: { grade: ReviewGrade; findings: string; improvement?: string; conferenceDate?: string; presenter?: string }): Promise<MortalityCase> {
  return mutate(() => {
    const u = requirePermission('mortality.review')
    if (u.role !== 'doctor') fail('死亡病例審查要由醫師處理', 'FORBIDDEN')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (!a.death) fail('病人沒有死亡紀錄', 'CONFLICT')
    if (!needsMortalityReview(a)) fail('預期死亡（有 DNR 或安寧收案、沒有其他觸發條件）：不用審查', 'CONFLICT')
    if (a.mortalityReview) fail('已經審查過了', 'CONFLICT')
    failFields(checkMortalityReview(input, today()))
    a.mortalityReview = {
      grade: input.grade, findings: input.findings.trim(), ...(input.improvement?.trim() ? { improvement: input.improvement.trim() } : {}),
      ...(input.grade === 'discuss' ? { conference: { date: input.conferenceDate!, presenter: input.presenter!.trim() } } : {}),
      by: u.id, at: now(),
    }
    audit('死亡病例審查', `${a.admitNo} ${nameOf.patient(a.patientId)}：${reviewGradeLabel(input.grade)}`)
    return caseOf(a)
  })
}
