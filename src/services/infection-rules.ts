// 院內感染（純函式）：種類、和管路的對應、「管路相關」要放超過 2 天、通報欄位檢查、每千管路日感染率。
// 通報畫面即時提醒、服務層把關、品質指標、測試都用這一份
import type { InfectionKind, LineKind } from '@/types'

export const INFECTION_KINDS: { kind: InfectionKind; label: string; short: string; line?: LineKind; hint: string }[] = [
  { kind: 'cauti', label: '導尿管相關泌尿道感染', short: 'CAUTI', line: 'foley', hint: '發燒、恥骨上壓痛；尿液培養 ≥10⁵ CFU/ml' },
  { kind: 'clabsi', label: '中心靜脈導管相關血流感染', short: 'CLABSI', line: 'cvc', hint: '發燒、寒顫；血液培養陽性且找不到其他感染源' },
  { kind: 'ssi', label: '手術部位感染', short: 'SSI', hint: '術後 30 天內傷口紅腫熱痛、化膿或培養陽性' },
  { kind: 'other', label: '其他院內感染', short: '其他', hint: '肺炎、腸胃道等（入院 48 小時後發生）' },
]
export const infectionLabel = (k: InfectionKind) => INFECTION_KINDS.find((x) => x.kind === k)?.label ?? k
/** 管路放超過幾天才算「管路相關」 */
export const LINE_RELATED_DAYS = 2

/** 發生時管路放了幾天（放置當天算第 1 天）；超過 2 天（第 3 天起）才算管路相關 */
export function lineDayAt(insertedAt: string, onsetAt: string): number {
  return Math.floor((Date.parse(onsetAt.slice(0, 10)) - Date.parse(insertedAt.slice(0, 10))) / 86400000) + 1
}
export const lineRelated = (insertedAt: string, onsetAt: string, removedAt?: string) =>
  lineDayAt(insertedAt, onsetAt) > LINE_RELATED_DAYS && (!removedAt || removedAt.slice(0, 10) >= onsetAt.slice(0, 10) || lineDayAt(removedAt, onsetAt) <= 2)

export function checkInfectionInput(x: { kind?: string; onsetAt?: string; symptoms?: string; culture?: string }, now: string): Record<string, string> {
  const e: Record<string, string> = {}
  if (!INFECTION_KINDS.some((k) => k.kind === x.kind)) e.kind = '請選感染種類'
  if (!x.onsetAt || !/^\d{4}-\d{2}-\d{2}$/.test(x.onsetAt)) e.onsetAt = '請填發生日期'
  else if (x.onsetAt > now.slice(0, 10)) e.onsetAt = '發生日期不能晚於今天'
  if (!x.symptoms?.trim()) e.symptoms = '請寫症狀與徵象'
  if (!x.culture?.trim()) e.culture = '請寫培養或檢查結果（還沒有結果寫「待報告」）'
  return e
}

/** 每千管路日（或每千住院人日）幾例；分母 0 回 null */
export const per1000 = (cases: number, days: number) => (days ? Math.round((cases / days) * 10000) / 10 : null)
