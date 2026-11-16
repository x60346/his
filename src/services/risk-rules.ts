// 跌倒（Morse）、壓傷（Braden）風險評估（純函式）：題目與分數、加總、風險等級、預防措施、什麼時候該評。
// 評估畫面（即時算分數）、服務層（存檔時重算，不相信畫面送來的分數）、護理站待辦都用這一份
import type { RiskLevel, RiskReason, RiskScale, RiskSettings } from '@/types'
import { addMinutes } from '@/utils/date'

export interface RiskItem {
  key: string
  label: string
  options: { score: number; text: string }[]
}

/** Morse 跌倒量表：6 題，0–125 分，越高越危險 */
export const MORSE_ITEMS: RiskItem[] = [
  { key: 'history', label: '跌倒史（3 個月內，或這次入院時跌倒）', options: [{ score: 0, text: '無' }, { score: 25, text: '有' }] },
  { key: 'secondary', label: '次要診斷（兩個以上診斷）', options: [{ score: 0, text: '無' }, { score: 15, text: '有' }] },
  { key: 'aid', label: '行動輔具', options: [{ score: 0, text: '不需要、臥床、由護理人員協助' }, { score: 15, text: '拐杖、助行器' }, { score: 30, text: '扶著家具行走' }] },
  { key: 'iv', label: '靜脈輸液或留置針', options: [{ score: 0, text: '無' }, { score: 20, text: '有' }] },
  { key: 'gait', label: '步態', options: [{ score: 0, text: '正常、臥床、坐輪椅' }, { score: 10, text: '虛弱' }, { score: 20, text: '障礙（起身困難、步伐不穩）' }] },
  { key: 'mental', label: '認知狀態', options: [{ score: 0, text: '了解自己的活動能力' }, { score: 15, text: '高估自己或忘記限制' }] },
]

/** Braden 壓傷量表：6 題，6–23 分，越低越危險 */
export const BRADEN_ITEMS: RiskItem[] = [
  { key: 'sensory', label: '感覺知覺（對壓迫不適的反應）', options: [{ score: 1, text: '完全受限' }, { score: 2, text: '非常受限' }, { score: 3, text: '輕微受限' }, { score: 4, text: '沒有受損' }] },
  { key: 'moisture', label: '皮膚潮濕', options: [{ score: 1, text: '持續潮濕' }, { score: 2, text: '經常潮濕' }, { score: 3, text: '偶爾潮濕' }, { score: 4, text: '很少潮濕' }] },
  { key: 'activity', label: '活動力', options: [{ score: 1, text: '臥床' }, { score: 2, text: '限坐椅子' }, { score: 3, text: '偶爾行走' }, { score: 4, text: '經常行走' }] },
  { key: 'mobility', label: '移動力（自己改變姿勢）', options: [{ score: 1, text: '完全無法' }, { score: 2, text: '非常受限' }, { score: 3, text: '輕微受限' }, { score: 4, text: '不受限' }] },
  { key: 'nutrition', label: '營養', options: [{ score: 1, text: '非常差' }, { score: 2, text: '可能不足' }, { score: 3, text: '足夠' }, { score: 4, text: '極佳' }] },
  { key: 'friction', label: '摩擦力與剪力', options: [{ score: 1, text: '有問題（需大量協助移動）' }, { score: 2, text: '潛在問題' }, { score: 3, text: '無明顯問題' }] },
]

export const RISK_ITEMS: Record<RiskScale, RiskItem[]> = { fall: MORSE_ITEMS, pressure: BRADEN_ITEMS }
export const RISK_SCALE_LABEL: Record<RiskScale, string> = { fall: '跌倒', pressure: '壓傷' }
export const RISK_SCALE_NAME: Record<RiskScale, string> = { fall: 'Morse 跌倒量表', pressure: 'Braden 壓傷量表' }
export const RISK_LEVEL_LABEL: Record<RiskLevel, string> = { high: '高風險', moderate: '中度風險', low: '低風險' }
export const RISK_REASON_LABEL: Record<RiskReason, string> = { admission: '入院評估', routine: '例行重評', transfer: '轉床／轉科後重評', change: '病情變化加評' }

/** 預防措施（高風險時至少勾一項） */
export const RISK_MEASURES: Record<RiskScale, { key: string; label: string }[]> = {
  fall: [
    { key: 'rails', label: '床欄拉起' },
    { key: 'bell', label: '呼叫鈴放手邊' },
    { key: 'shoes', label: '穿防滑鞋' },
    { key: 'escort', label: '下床需有人陪同' },
    { key: 'teach', label: '病人與家屬衛教' },
    { key: 'sign', label: '床邊放跌倒警示牌' },
  ],
  pressure: [
    { key: 'turn', label: '每 2 小時翻身' },
    { key: 'mattress', label: '使用氣墊床' },
    { key: 'dry', label: '保持皮膚乾爽' },
    { key: 'nutrition', label: '營養評估' },
    { key: 'offload', label: '骨突處減壓' },
  ],
}
/** 寫護理紀錄時的焦點 */
export const RISK_NOTE_FOCUS: Record<RiskScale, string> = { fall: '跌倒高危險群', pressure: '皮膚完整性受損的危險' }

/** 預設切點：Morse ≥45 高、≥25 中；Braden ≤16 高、≤18 中（各醫院不同，管理員可調） */
export const RISK_DEFAULT: RiskSettings = { fallHigh: 45, fallModerate: 25, pressureHigh: 16, pressureModerate: 18 }

/** 切點檢查：Morse 中度 < 高風險、都在 1–125；Braden 高風險 < 中度、都在 6–23 */
export function checkRiskSettings(s: RiskSettings): Record<string, string> {
  const e: Record<string, string> = {}
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi
  if (!int(s.fallHigh, 1, 125)) e.fallHigh = '1–125 的整數'
  if (!int(s.fallModerate, 1, 125)) e.fallModerate = '1–125 的整數'
  else if (!e.fallHigh && s.fallModerate >= s.fallHigh) e.fallModerate = '要比高風險的分數低'
  if (!int(s.pressureHigh, 6, 23)) e.pressureHigh = '6–23 的整數'
  if (!int(s.pressureModerate, 6, 23)) e.pressureModerate = '6–23 的整數'
  else if (!e.pressureHigh && s.pressureModerate <= s.pressureHigh) e.pressureModerate = '要比高風險的分數高（Braden 越低越危險）'
  return e
}

/** 加總：每一題都要答、分數要是那一題的選項之一。回傳分數或缺漏的題目 */
export function riskScore(scale: RiskScale, answers: Record<string, number>): { score: number; missing: string[] } {
  const items = RISK_ITEMS[scale]
  const missing = items.filter((it) => !it.options.some((o) => o.score === answers?.[it.key])).map((it) => it.label)
  return { score: items.reduce((n, it) => n + (it.options.some((o) => o.score === answers?.[it.key]) ? answers[it.key] : 0), 0), missing }
}

export function riskLevel(scale: RiskScale, score: number, s: RiskSettings = RISK_DEFAULT): RiskLevel {
  if (scale === 'fall') return score >= s.fallHigh ? 'high' : score >= s.fallModerate ? 'moderate' : 'low'
  return score <= s.pressureHigh ? 'high' : score <= s.pressureModerate ? 'moderate' : 'low'
}

/** 拿高分的題目（寫護理紀錄、看得出為什麼高）：Morse 有分的題、Braden 1–2 分的題 */
export function riskFactors(scale: RiskScale, answers: Record<string, number>): string[] {
  return RISK_ITEMS[scale]
    .filter((it) => (scale === 'fall' ? (answers[it.key] ?? 0) > 0 : (answers[it.key] ?? 9) <= 2))
    .map((it) => `${it.label.replace(/（.*$/, '')}：${it.options.find((o) => o.score === answers[it.key])?.text ?? ''}`)
}

/** 重評間隔：高風險 24 小時、中低風險 7 天；入院、轉床轉科後 24 小時內 */
export const RISK_INTERVAL_MIN: Record<RiskLevel, number> = { high: 24 * 60, moderate: 7 * 24 * 60, low: 7 * 24 * 60 }
export const RISK_FIRST_MIN = 24 * 60
/** 到期前多久開始列「待評估」 */
export const RISK_DUE_AHEAD_MIN = 120

export interface RiskDue {
  dueAt: string
  reason: RiskReason
  /** overdue 逾時、due 到期前 2 小時內（該評了）、ok 還沒到 */
  status: 'overdue' | 'due' | 'ok'
}

/**
 * 下一次什麼時候要評：
 *   - 沒評過：入院後 24 小時內
 *   - 評過：高風險 24 小時後、其他 7 天後
 *   - 最後一次評估之後有轉床或轉科：轉移後 24 小時內（和例行的取比較早的）
 */
export function riskDue(input: { admittedAt: string; lastAt?: string; lastLevel?: RiskLevel; movedAt?: string }, now: string): RiskDue {
  let due: { dueAt: string; reason: RiskReason }
  if (!input.lastAt || !input.lastLevel) due = { dueAt: addMinutes(input.admittedAt, RISK_FIRST_MIN), reason: 'admission' }
  else {
    due = { dueAt: addMinutes(input.lastAt, RISK_INTERVAL_MIN[input.lastLevel]), reason: 'routine' }
    // 同一分鐘評估又轉床：當作轉床在後（寧可多評一次）
    if (input.movedAt && input.movedAt >= input.lastAt) {
      const t = addMinutes(input.movedAt, RISK_FIRST_MIN)
      if (t < due.dueAt) due = { dueAt: t, reason: 'transfer' }
    }
  }
  const status = now > due.dueAt ? 'overdue' : now >= addMinutes(due.dueAt, -RISK_DUE_AHEAD_MIN) ? 'due' : 'ok'
  return { ...due, status }
}
