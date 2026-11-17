// 傷口的內部工具（index 不匯出、不會被包成 API）：還沒癒合的傷口、沒變小的、院內壓傷要不要「病情變化加評」、首頁計數。規則在 wound-rules
import type { Admission, Wound } from '@/types'
import { db } from '@/mock/db'
import { stalled } from './wound-rules'
import { careRoleOf } from './care-team'

export const openWounds = (admissionId: string): Wound[] => db.wounds.filter((w) => w.admissionId === admissionId && !w.closedAt)

/**
 * 院內壓傷登錄後，要寫一筆壓傷（Braden）「病情變化加評」：登錄之後還沒有 reason change 的壓傷評估就要提醒
 */
export function needsRiskChange(a: Admission): Wound | undefined {
  return openWounds(a.id).find((w) => w.hospitalAcquired && !db.riskAssessments.some((r) => r.admissionId === a.id && r.scale === 'pressure' && !r.voided && r.reason === 'change' && r.at >= w.foundAt))
}

export interface WoundTodo {
  woundId: string
  kind: 'stall' | 'risk'
  text: string
}

export function woundTodosOf(a: Admission, t: string): WoundTodo[] {
  const out: WoundTodo[] = []
  for (const w of openWounds(a.id)) {
    const s = stalled(w.cares, t)
    if (s) out.push({ woundId: w.id, kind: 'stall', text: `${w.site}傷口 2 週沒有變小（${s.from.area} → ${s.to.area} cm²）：請主治評估` })
  }
  const r = needsRiskChange(a)
  if (r) out.push({ woundId: r.id, kind: 'risk', text: `院內壓傷（${r.site}）：請做壓傷評估「病情變化加評」` })
  return out
}

/** 醫師首頁：本科住院病人有傷口 2 週沒變小 */
export const woundStallCount = (doctorId: string, t: string) =>
  db.admissions.filter((a) => a.status === 'admitted' && (careRoleOf(doctorId, a)?.kind ?? 'consult') !== 'consult').reduce((n, a) => n + openWounds(a.id).filter((w) => stalled(w.cares, t)).length, 0)

/** 出院：沒癒合的傷口照樣留著（帶出院），不自動結案 */
