// 升壓劑（純函式）：劑量 ↔ 流速換算、醫囑檢查、護理師調流速的範圍、停藥要不要寫原因、SOFA 心血管用的劑量。
// 醫師開立畫面、護理站調流速、服務層、SOFA、測試都用這一份
import type { Drug } from '@/types'

export type VasoDef = NonNullable<Drug['vaso']>
/** 預設目標 */
export const VASO_TARGET_DEFAULT = 'MAP ≥65 mmHg'
/** 升壓劑流速範圍（ml/h）：比一般點滴慢得多（一般點滴 5–500） */
export const VASO_RATE_RANGE: [number, number] = [0.5, 100]
export const WEIGHT_RANGE: [number, number] = [20, 250]

const r1 = (x: number) => Math.round(x * 10) / 10
const r3 = (x: number) => Math.round(x * 1000) / 1000
/** 劑量 → 流速 ml/h：mcg/kg/min × kg × 60 ÷ 每 ml mcg；U/min × 60 ÷ 每 ml U */
export const vasoRate = (v: VasoDef, dose: number, kg: number) => r1(v.unit === 'mcg/kg/min' ? (dose * kg * 60) / v.perMl : (dose * 60) / v.perMl)
/** 流速 → 劑量 */
export const vasoDose = (v: VasoDef, rateMlH: number, kg: number) => r3(v.unit === 'mcg/kg/min' ? (rateMlH * v.perMl) / (kg * 60) : (rateMlH * v.perMl) / 60)

/** 開立：起始劑量、上限都要在範圍內且上限 ≥ 起始；體重 20–250 kg；要寫目標；換算出的流速要在升壓劑範圍內 */
export function checkVasoOrder(v: VasoDef, x: { dose?: number; max?: number; weightKg?: number; target?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  const inRange = (n?: number) => typeof n === 'number' && n >= v.range[0] && n <= v.range[1]
  if (!inRange(x.dose)) e.dose = `起始劑量 ${v.range[0]}–${v.range[1]} ${v.unit}`
  if (!inRange(x.max)) e.max = `上限 ${v.range[0]}–${v.range[1]} ${v.unit}`
  else if (inRange(x.dose) && x.max! < x.dose!) e.max = '上限不能小於起始劑量'
  if (!(typeof x.weightKg === 'number' && x.weightKg >= WEIGHT_RANGE[0] && x.weightKg <= WEIGHT_RANGE[1])) e.weightKg = `體重 ${WEIGHT_RANGE[0]}–${WEIGHT_RANGE[1]} kg`
  if (!x.target?.trim()) e.target = '請寫目標（例：MAP ≥65 mmHg）'
  if (!e.dose && !e.weightKg) {
    const rate = vasoRate(v, x.dose!, x.weightKg!)
    if (rate < VASO_RATE_RANGE[0] || rate > VASO_RATE_RANGE[1]) e.dose = `換算流速 ${rate} ml/h 超出幫浦範圍（${VASO_RATE_RANGE[0]}–${VASO_RATE_RANGE[1]}）`
  }
  return e
}

/** 護理師調流速：換算的劑量不能超過醫囑上限、不能低於最低劑量（要停藥請醫師停醫囑） */
export function vasoRateProblem(v: VasoDef, order: { max: number; weightKg: number }, rateMlH: number): string | undefined {
  if (!(rateMlH >= VASO_RATE_RANGE[0] && rateMlH <= VASO_RATE_RANGE[1])) return `升壓劑流速 ${VASO_RATE_RANGE[0]}–${VASO_RATE_RANGE[1]} ml/小時`
  const d = vasoDose(v, rateMlH, order.weightKg)
  if (d > order.max) return `換算 ${d} ${v.unit}，超過醫囑上限 ${order.max}：請醫師改醫囑`
  if (d < v.range[0]) return `換算 ${d} ${v.unit}，低於最低劑量 ${v.range[0]}：要停藥請醫師停止醫囑`
  return undefined
}

/** 停藥：目前劑量還高於「可以直接停」的劑量，要先逐步調降，或寫直接停止的原因 */
export const vasoStopNeedsReason = (v: VasoDef, currentDose: number | undefined) => currentDose !== undefined && currentDose > v.weanTo

/** SOFA 心血管（用升壓劑時）：Dopamine >15 或 Norepinephrine >0.1 → 4；Dopamine >5、Norepinephrine ≤0.1 或用 Vasopressin → 3；Dopamine ≤5 → 2 */
export interface VasoMax { ne?: number; dopa?: number; vasopressin?: boolean }
export function sofaCardioByVaso(x: VasoMax): number | undefined {
  if ((x.dopa ?? 0) > 15 || (x.ne ?? 0) > 0.1) return 4
  if ((x.dopa ?? 0) > 5 || (x.ne ?? 0) > 0 || x.vasopressin) return 3
  if ((x.dopa ?? 0) > 0) return 2
  return undefined
}
