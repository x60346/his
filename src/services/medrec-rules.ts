// 入院用藥整合（純函式）：從門診處方帶出居家用藥（最近 90 天、同一個藥取最新那次）、24 小時期限、整合狀態、
// 醫師決定的輸入檢查。住院醫囑、護理站、首頁、出院病摘、測試都用這一份
import type { HomeMed, MedicationOrder, MedRec } from '@/types'
import { addDays, addMinutes } from '@/utils/date'

/** 往前看幾天的門診處方 */
export const MEDREC_LOOKBACK_DAYS = 90
/** 入院後多久內要完成整合 */
export const MEDREC_DUE_HOURS = 24
export const HOME_MED_DECISION_LABEL: Record<NonNullable<HomeMed['decision']>, string> = { continue: '續用', hold: '暫停', change: '改藥' }

/** 門診處方 → 居家用藥建議：入院前 90 天內看完的門診，同一個藥只留最近一次（新的在前） */
export function homeMedsFromOpd(encounters: { date: string; status: string; medications: MedicationOrder[] }[], admitDate: string): { drugId: string; dose: number; freq: string; route: string; lastDate: string }[] {
  const from = addDays(admitDate.slice(0, 10), -MEDREC_LOOKBACK_DAYS)
  const out = new Map<string, { drugId: string; dose: number; freq: string; route: string; lastDate: string }>()
  for (const e of encounters.filter((x) => x.status === 'completed' && x.date >= from && x.date <= admitDate.slice(0, 10)).sort((a, b) => b.date.localeCompare(a.date))) {
    for (const m of e.medications) if (!out.has(m.drugId)) out.set(m.drugId, { drugId: m.drugId, dose: m.dose, freq: m.freq, route: m.route, lastDate: e.date })
  }
  return [...out.values()]
}

export type MedRecState = 'unbuilt' | 'pending' | 'done'
/** 狀態：還沒建清單、建了還沒決定完、完成；超過入院 24 小時還沒完成＝逾時 */
export function medRecState(m: MedRec | undefined, admittedAt: string, t: string): { state: MedRecState; dueAt: string; overdue: boolean; left: number } {
  const dueAt = addMinutes(admittedAt, MEDREC_DUE_HOURS * 60)
  const state: MedRecState = !m ? 'unbuilt' : m.completedAt ? 'done' : 'pending'
  return { state, dueAt, overdue: state !== 'done' && t > dueAt, left: m ? m.items.filter((x) => !x.decision).length : 0 }
}

/** 醫師的決定：暫停、改藥要寫原因；院外的藥沒有對應主檔，續用要寫怎麼續（例：病人自備） */
export function checkHomeMedDecision(item: Pick<HomeMed, 'drugId'>, x: { decision?: string; reason?: string }): Record<string, string> {
  if (!x.decision || !(x.decision in HOME_MED_DECISION_LABEL)) return { decision: '請選續用、暫停或改藥' }
  if ((x.decision === 'hold' || x.decision === 'change') && !x.reason?.trim()) return { reason: x.decision === 'hold' ? '暫停要寫原因（例：禁食中、血壓偏低）' : '改藥要寫改成什麼（例：改用 Insulin）' }
  if (x.decision === 'continue' && !item.drugId && !x.reason?.trim()) return { reason: '院外的藥沒有院內對應：請寫怎麼續用（例：病人自備、照原劑量）' }
  return {}
}

/** 出院時提醒：入院時暫停的居家藥（要不要恢復由醫師決定） */
export const heldHomeMeds = (m: MedRec | undefined) => (m?.items ?? []).filter((x) => x.decision === 'hold')

/**
 * 出院用藥整合：每一項居家用藥都要決定「恢復」或「停用」（停用要寫原因，例：住院改用其他藥）。
 * 回傳沒決定的、停用沒寫原因的（簽署出院病摘時擋；沒有居家用藥清單的病人不擋）
 */
export function homeMedPlanProblems(items: Pick<HomeMed, 'id' | 'name'>[], plan: Record<string, { resume: boolean; reason?: string }> | undefined): { undecided: string[]; noReason: string[] } {
  const p = plan ?? {}
  return {
    undecided: items.filter((x) => !p[x.id]).map((x) => x.name),
    noReason: items.filter((x) => p[x.id] && !p[x.id].resume && !p[x.id].reason?.trim()).map((x) => x.name),
  }
}
