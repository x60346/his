// 藥物不良反應（ADR，純函式）：Naranjo 因果關係量表（10 題、是／否／不知道各有分數）、分數 → 判定、嚴重度與
// 嚴重型（SJS、過敏性休克要 24 小時內評估）、通報欄位檢查、哪些判定可以加入過敏。通報、藥師評估、測試都用這一份
import type { AdrReport, AdrSeverity } from '@/types'
import { addMinutes } from '@/utils/date'

export type NaranjoAnswer = 'yes' | 'no' | 'unknown'
/** Naranjo 量表：題目與「是／否」的分數（不知道都是 0） */
export const NARANJO: { q: string; yes: number; no: number }[] = [
  { q: '這種反應以前有確定的報告嗎？', yes: 1, no: 0 },
  { q: '反應是在給這個藥之後才出現的嗎？', yes: 2, no: -1 },
  { q: '停藥或給拮抗劑後，反應有改善嗎？', yes: 1, no: 0 },
  { q: '再給這個藥，反應又出現了嗎？', yes: 2, no: -1 },
  { q: '有其他原因（不是這個藥）可以解釋這個反應嗎？', yes: -1, no: 2 },
  { q: '給安慰劑時反應也出現嗎？', yes: -1, no: 1 },
  { q: '血中藥物濃度達到中毒範圍嗎？', yes: 1, no: 0 },
  { q: '劑量增加反應更嚴重、減少就減輕嗎？', yes: 1, no: 0 },
  { q: '病人以前對同類藥有類似反應嗎？', yes: 1, no: 0 },
  { q: '有客觀證據（檢驗、檢查）證實嗎？', yes: 1, no: 0 },
]

export const naranjoScore = (answers: NaranjoAnswer[]) => NARANJO.reduce((n, x, i) => n + (answers[i] === 'yes' ? x.yes : answers[i] === 'no' ? x.no : 0), 0)

export type Causality = 'definite' | 'probable' | 'possible' | 'doubtful'
export const CAUSALITY_LABEL: Record<Causality, string> = { definite: '確定', probable: '很可能', possible: '可能', doubtful: '存疑' }
/** ≥9 確定、5–8 很可能、1–4 可能、≤0 存疑 */
export const causalityOf = (score: number): Causality => (score >= 9 ? 'definite' : score >= 5 ? 'probable' : score >= 1 ? 'possible' : 'doubtful')
/** 很可能以上才建議加入過敏（由藥師勾選確認，不自動加） */
export const canAddAllergy = (c: Causality) => c === 'definite' || c === 'probable'

export const ADR_SEVERITY_LABEL: Record<AdrSeverity, string> = { mild: '輕度', moderate: '中度', severe: '重度' }
/** 嚴重型：要在通報後 24 小時內評估（藥師首頁標紅） */
export const ADR_SERIOUS: { key: NonNullable<AdrReport['serious']>; label: string }[] = [
  { key: 'anaphylaxis', label: '過敏性休克' },
  { key: 'sjs', label: 'SJS／TEN（史帝文生氏－強生症候群）' },
]
export const ADR_SERIOUS_HOURS = 24
export const adrDueAt = (r: Pick<AdrReport, 'serious' | 'reportedAt'>) => (r.serious ? addMinutes(r.reportedAt, ADR_SERIOUS_HOURS * 60) : undefined)

/** 通報欄位：懷疑的藥、發生時間（不能在未來）、症狀、嚴重度、處置 */
export function checkAdrInput(x: { drugId?: string; onsetAt?: string; symptoms?: string; severity?: string; action?: string }, now: string): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x.drugId) e.drugId = '請選懷疑的藥（這次住院給過的）'
  if (!x.onsetAt) e.onsetAt = '請填發生時間'
  else if (x.onsetAt > now) e.onsetAt = '發生時間不能在未來'
  if (!x.symptoms?.trim()) e.symptoms = '請寫症狀（例：全身紅疹、搔癢）'
  if (!x.severity || !(x.severity in ADR_SEVERITY_LABEL)) e.severity = '請選嚴重度'
  if (!x.action?.trim()) e.action = '請寫處置（例：停藥、給抗組織胺）'
  return e
}
