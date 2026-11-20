// 營養的內部工具（index 不匯出、不會被包成 API）：篩檢期限、要不要營養師評估、首頁與護理站待辦。規則在 nutrition-rules
import type { Admission, NutritionAssessment, NutritionScreen } from '@/types'
import { db } from '@/mock/db'
import { NUTRITION_RISK_FROM, screenDue } from './nutrition-rules'
import { dietOf } from './nutrition-rules'

/** 要篩檢的住院：住院中、不是留觀中（留觀不篩，轉住院後從住院起算）、不是日間手術（當天回家；轉住院後才篩） */
export const screenable = (a: Admission) => a.status === 'admitted' && !!a.admittedAt && !(a.obs && !a.obs.endAt) && !(a.day && !a.day.converted)
const startOf = (a: Admission) => (a.obs?.outcome === 'admit' && a.obs.endAt ? a.obs.endAt : a.admittedAt!)

export const latestScreen = (admissionId: string): NutritionScreen | undefined =>
  db.nutritionScreens.filter((s) => s.admissionId === admissionId).reduce<NutritionScreen | undefined>((b, s) => (!b || s.at >= b.at ? s : b), undefined)
export const latestAssessment = (admissionId: string): NutritionAssessment | undefined =>
  db.nutritionAssessments.filter((s) => s.admissionId === admissionId).reduce<NutritionAssessment | undefined>((b, s) => (!b || s.at >= b.at ? s : b), undefined)

export function screenStateOf(a: Admission, t: string) {
  const s = latestScreen(a.id)
  return { latest: s, due: screenDue(startOf(a), s?.at, t) }
}

/** 營養師待評估：最近一次篩檢 ≥3 分，之後還沒有營養評估 */
export function needsDietitian(a: Admission): boolean {
  const s = latestScreen(a.id)
  if (!s || s.score < NUTRITION_RISK_FROM) return false
  const x = latestAssessment(a.id)
  return !x || x.at < s.at
}

/** 目前的飲食（現在有效的長期飲食醫囑） */
export function currentDiet(admissionId: string, t: string) {
  const o = db.ipdOrders.filter((x) => x.admissionId === admissionId && x.category === 'diet' && x.type === 'long' && x.startAt <= t && (!x.stopAt || x.stopAt > t)).sort((p, q) => p.startAt.localeCompare(q.startAt)).at(-1)
  return o ? { ...dietOf(o), content: o.content, orderId: o.id } : undefined
}

export const nutritionCounts = (t: string, doctorId?: string) => {
  const inpt = db.admissions.filter(screenable)
  return {
    screenDue: inpt.filter((a) => ['due', 'overdue'].includes(screenStateOf(a, t).due.status)).length,
    toAssess: inpt.filter(needsDietitian).length,
    unseen: doctorId ? db.nutritionAssessments.filter((x) => !x.seenAt && db.admissions.some((a) => a.id === x.admissionId && a.status === 'admitted' && a.doctorId === doctorId)).length : 0,
  }
}
