// 傷口與壓傷（純函式）：分級、面積、院內壓傷（入院 24 小時後才發現）、連續 2 週沒變小、欄位檢查。
// 畫面即時算、服務層把關、品質指標、測試都用這一份
import type { PressureStage, Wound, WoundCare } from '@/types'
import { addDays, addMinutes } from '@/utils/date'

export const WOUND_KINDS: { kind: Wound['kind']; label: string }[] = [
  { kind: 'pressure', label: '壓傷' },
  { kind: 'surgical', label: '手術傷口' },
  { kind: 'other', label: '其他傷口' },
]
export const woundKindLabel = (k: Wound['kind']) => WOUND_KINDS.find((x) => x.kind === k)?.label ?? k
export const PRESSURE_STAGES: { stage: PressureStage; label: string; hint: string }[] = [
  { stage: '1', label: '第 1 級', hint: '皮膚完整、壓了不會變白的紅斑' },
  { stage: '2', label: '第 2 級', hint: '部分皮層缺損，粉紅色淺傷口或水泡' },
  { stage: '3', label: '第 3 級', hint: '全皮層缺損，看得到脂肪' },
  { stage: '4', label: '第 4 級', hint: '全層組織缺損，看得到肌肉、肌腱或骨頭' },
  { stage: 'unstageable', label: '無法分級', hint: '被焦痂或腐肉覆蓋，看不到底部' },
  { stage: 'dti', label: '深部組織損傷', hint: '皮膚完整但深紫色或暗紅，或血泡' },
]
export const stageLabel = (s?: PressureStage) => PRESSURE_STAGES.find((x) => x.stage === s)?.label ?? ''
export const EXUDATE: { key: WoundCare['exudate']; label: string }[] = [
  { key: 'none', label: '無' }, { key: 'small', label: '少量' }, { key: 'moderate', label: '中量' }, { key: 'large', label: '大量' },
]
export const DRESSINGS = ['生理食鹽水濕敷', '人工皮（親水性敷料）', '泡棉敷料', '銀離子敷料', '藻膠敷料', '紗布乾敷', '透明薄膜']
export const PRESSURE_SITES = ['薦骨', '尾骨', '左髖', '右髖', '左足跟', '右足跟', '枕骨', '左肩胛', '右肩胛']
/** 入院幾小時後才發現的壓傷算院內壓傷 */
export const HAPI_HOURS = 24
/** 幾天沒變小提醒主治 */
export const WOUND_STALL_DAYS = 14

export const areaOf = (c: Pick<WoundCare, 'lengthCm' | 'widthCm'>) => Math.round(c.lengthCm * c.widthCm * 10) / 10
export const hospitalAcquired = (kind: Wound['kind'], foundAt: string, admittedAt: string) => kind === 'pressure' && foundAt > addMinutes(admittedAt, HAPI_HOURS * 60)

/**
 * 連續 2 週沒變小：最新一次的面積 ≥ 14 天前（含）最近那一次的面積。紀錄不到 14 天回 undefined。
 * 回傳比較的兩次（給畫面顯示）
 */
export function stalled(cares: Pick<WoundCare, 'at' | 'lengthCm' | 'widthCm'>[], now: string): { from: { at: string; area: number }; to: { at: string; area: number } } | undefined {
  const xs = [...cares].sort((a, b) => a.at.localeCompare(b.at))
  const last = xs.at(-1)
  if (!last) return undefined
  const cut = addDays(now.slice(0, 10), -WOUND_STALL_DAYS)
  const base = [...xs].reverse().find((c) => c.at.slice(0, 10) <= cut)
  if (!base || base === last) return undefined
  return areaOf(last) >= areaOf(base) ? { from: { at: base.at, area: areaOf(base) }, to: { at: last.at, area: areaOf(last) } } : undefined
}

export function checkWoundCare(x: Partial<WoundCare>, kind?: Wound['kind']): Record<string, string> {
  const e: Record<string, string> = {}
  const cm = (v: unknown, lo: number) => typeof v === 'number' && !Number.isNaN(v) && v >= lo && v <= 50
  if (!x.dressing?.trim()) e.dressing = '請寫敷料'
  if (!EXUDATE.some((y) => y.key === x.exudate)) e.exudate = '請選滲液量'
  if (!cm(x.lengthCm, 0.1)) e.lengthCm = '長 0.1–50 cm'
  if (!cm(x.widthCm, 0.1)) e.widthCm = '寬 0.1–50 cm'
  if (!cm(x.depthCm, 0)) e.depthCm = '深 0–50 cm（表淺填 0）'
  if (kind === 'pressure' && !PRESSURE_STAGES.some((s) => s.stage === x.stage)) e.stage = '壓傷請選分級'
  return e
}
