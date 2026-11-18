// 安寧共同照護（純函式）：症狀項目、末期疾病別、照會與收案的檢查、訪視紀錄的檢查、每週訪視到期。
// 安寧頁、病人分頁、服務層、首頁待辦、測試都用這一份
import type { PalliativeCase, SymptomKey } from '@/types'
import { addMinutes } from '@/utils/date'

export const SYMPTOMS: { key: SymptomKey; label: string }[] = [
  { key: 'pain', label: '疼痛' },
  { key: 'dyspnea', label: '呼吸困難' },
  { key: 'nausea', label: '噁心嘔吐' },
  { key: 'anxiety', label: '焦慮' },
  { key: 'delirium', label: '譫妄' },
]
/** 症狀 ≥7 分：嚴重（畫面標紅、要寫處置） */
export const SYMPTOM_SEVERE = 7
/** 健保安寧共照的末期疾病別（簡化） */
export const PALLIATIVE_DISEASES = ['癌症', '末期運動神經元病', '老年期及初老期器質性精神病態（失智症）', '其他大腦變質', '心臟衰竭', '慢性阻塞性肺病', '肺部其他疾病', '慢性肝病及肝硬化', '急性腎衰竭', '慢性腎衰竭']
/** 收案後每 7 天至少訪視一次（最後一天「該訪視了」、過了「逾時」） */
export const VISIT_DAYS = 7

export const checkPalliativeRequest = (x: { reason?: string }): Record<string, string> => (x.reason?.trim() ? {} : { reason: '請寫照會原因（例：肺癌末期，呼吸困難加劇，家屬希望以舒適為主）' })

/** 收案：末期疾病別、兩位不同的專科醫師確認、照護目標；婉拒要寫原因 */
export function checkPalliativeDecision(x: { accept?: boolean; disease?: string; doctorIds?: string[]; goals?: string; declineReason?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (x.accept) {
    if (!PALLIATIVE_DISEASES.includes(x.disease ?? '')) e.disease = '請選末期疾病別'
    const ds = (x.doctorIds ?? []).filter(Boolean)
    if (ds.length < 2 || new Set(ds).size < 2) e.doctorIds = '要兩位不同的專科醫師確認為末期病人'
    if (!x.goals?.trim()) e.goals = '請寫照護目標（例：控制呼吸困難與疼痛，讓病人在家屬陪伴下舒適）'
  } else if (!x.declineReason?.trim()) e.declineReason = '請寫婉拒原因（例：目前不符末期條件，建議持續治療）'
  return e
}

/** 訪視：五項症狀都要 0–10 的整數、要寫評估與處置 */
export function checkPalliativeVisit(x: { symptoms?: Partial<Record<SymptomKey, number>>; note?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  for (const s of SYMPTOMS) {
    const v = x.symptoms?.[s.key]
    if (!(typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10)) e[s.key] = `${s.label} 0–10`
  }
  if (!x.note?.trim()) e.note = '請寫評估與處置'
  return e
}

export function checkFamilyMeeting(x: { date?: string; participants?: string; conclusion?: string }, today: string): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x.date || !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) e.date = '請選日期'
  else if (x.date > today) e.date = '家屬會議的日期不能是未來（開完再記）'
  if (!x.participants?.trim()) e.participants = '請寫參與者（例：病人、配偶、長子、主治、安寧醫師、社工）'
  if (!x.conclusion?.trim()) e.conclusion = '請寫結論'
  return e
}

/** 每週訪視：從收案或上次訪視起 7 天；最後一天 due、過了 overdue */
export function visitDueOf(c: Pick<PalliativeCase, 'status' | 'decidedAt' | 'visits'>, t: string): { dueAt: string; status: 'ok' | 'due' | 'overdue' } | undefined {
  if (c.status !== 'enrolled' || !c.decidedAt) return undefined
  const last = c.visits.map((v) => v.at).sort().pop() ?? c.decidedAt
  const dueAt = addMinutes(last, VISIT_DAYS * 24 * 60)
  return { dueAt, status: t > dueAt ? 'overdue' : t >= addMinutes(dueAt, -24 * 60) ? 'due' : 'ok' }
}
