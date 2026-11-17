// 呼吸器與鎮靜（純函式）：呼吸器模式與設定的檢查、設定文字、RASS 量表與目標範圍、每 4 小時的到期判斷、
// 每日脫離評估（SAT → SBT）的檢查、DNR 擋插管與呼吸器、CAM-ICU 要 RASS ≥ −3 才評。
// 呼吸器分頁、流程表、本班待辦、首頁、服務層、測試都用這一份
import type { DnrItem, VentMode, VentSetting, WeanResult } from '@/types'
import { addMinutes } from '@/utils/date'

type Field = 'vt' | 'pinsp' | 'rr' | 'ps'
export const VENT_MODES: { mode: VentMode; label: string; needs: Field[]; optional?: Field[] }[] = [
  { mode: 'AC/VC', label: '輔助控制－容積', needs: ['vt', 'rr'] },
  { mode: 'AC/PC', label: '輔助控制－壓力', needs: ['pinsp', 'rr'] },
  { mode: 'SIMV', label: '同步間歇強制換氣', needs: ['vt', 'rr'], optional: ['ps'] },
  { mode: 'PSV', label: '壓力支持（脫離）', needs: ['ps'] },
  { mode: 'CPAP', label: '持續正壓（脫離）', needs: [] },
]
export const VENT_FIELD: Record<Field | 'fio2' | 'peep', { label: string; unit: string; range: [number, number] }> = {
  fio2: { label: 'FiO2', unit: '%', range: [21, 100] },
  peep: { label: 'PEEP', unit: 'cmH2O', range: [0, 24] },
  vt: { label: '潮氣量', unit: 'ml', range: [200, 1000] },
  pinsp: { label: '吸氣壓力', unit: 'cmH2O', range: [5, 40] },
  rr: { label: '呼吸次數', unit: '次/分', range: [4, 40] },
  ps: { label: '壓力支持', unit: 'cmH2O', range: [0, 30] },
}
export const VENT_CHANGE_REASONS = ['血氧偏低，加氧', '血氧穩定，降氧（脫離）', '高碳酸血症，調整換氣', '尖峰壓過高（肺保護）', '改脫離模式', '其他']

/** 設定的檢查：模式要的欄位必填、所有數字在範圍內（不要的欄位不收） */
export function checkVentSetting(x: Partial<VentSetting>): Record<string, string> {
  const e: Record<string, string> = {}
  const m = VENT_MODES.find((v) => v.mode === x.mode)
  if (!m) return { mode: '請選模式' }
  for (const k of ['fio2', 'peep', ...m.needs] as const) if (x[k] === undefined || x[k] === null || Number.isNaN(x[k])) e[k] = `請填${VENT_FIELD[k].label}`
  for (const k of ['fio2', 'peep', ...m.needs, ...(m.optional ?? [])] as const) {
    const v = x[k]
    if (v === undefined || v === null || Number.isNaN(v) || e[k]) continue
    const [lo, hi] = VENT_FIELD[k].range
    if (!Number.isInteger(v) || v < lo || v > hi) e[k] = `${lo}–${hi} 的整數`
  }
  return e
}

/** 只留這個模式用得到的欄位 */
export function cleanVentSetting(x: VentSetting): VentSetting {
  const m = VENT_MODES.find((v) => v.mode === x.mode)!
  const keep = new Set<string>(['mode', 'fio2', 'peep', ...m.needs, ...(m.optional ?? [])])
  const out = Object.fromEntries(Object.entries(x).filter(([k, v]) => keep.has(k) && v !== undefined && v !== null && v !== '')) as unknown as VentSetting
  return out
}

/** 設定文字：AC/VC FiO2 40% PEEP 8 VT 420 RR 16 */
export const ventText = (v: VentSetting) =>
  [v.mode, `FiO2 ${v.fio2}%`, `PEEP ${v.peep}`, v.vt !== undefined && `VT ${v.vt}`, v.pinsp !== undefined && `Pinsp ${v.pinsp}`, v.rr !== undefined && `RR ${v.rr}`, v.ps !== undefined && `PS ${v.ps}`].filter(Boolean).join(' ')

/** 呼吸器實測的檢查（流程表）：尖峰壓、實際潮氣量、實際呼吸次數 */
export function checkVentMeasure(x: { ppeak?: number; vt?: number; rr?: number }): Record<string, string> {
  const e: Record<string, string> = {}
  const r = { ppeak: [5, 80, '尖峰壓'], vt: [50, 1500, '實際潮氣量'], rr: [0, 60, '實際呼吸次數'] } as const
  for (const k of ['ppeak', 'vt', 'rr'] as const) {
    const v = x[k]
    const key = `vent${k[0].toUpperCase()}${k.slice(1)}`
    if (v === undefined || v === null || Number.isNaN(v)) e[key] = '呼吸器三項要一起記'
    else if (v < r[k][0] || v > r[k][1]) e[key] = `${r[k][2]} ${r[k][0]}–${r[k][1]}`
  }
  return e
}
/** 尖峰壓 >35 cmH2O：小心氣壓傷（肺保護） */
export const PPEAK_HIGH = 35

// ---------- RASS ----------
export const RASS_LEVELS: { score: number; label: string }[] = [
  { score: 4, label: '攻擊' },
  { score: 3, label: '非常躁動' },
  { score: 2, label: '躁動' },
  { score: 1, label: '不安' },
  { score: 0, label: '清醒平靜' },
  { score: -1, label: '嗜睡' },
  { score: -2, label: '輕度鎮靜' },
  { score: -3, label: '中度鎮靜' },
  { score: -4, label: '深度鎮靜' },
  { score: -5, label: '無法喚醒' },
]
export const rassLabel = (n: number) => `${n > 0 ? '+' : ''}${n} ${RASS_LEVELS.find((x) => x.score === n)?.label ?? ''}`
export const checkRass = (n: number | undefined) => (n === undefined || n === null || Number.isNaN(n) ? undefined : Number.isInteger(n) && n >= -5 && n <= 4 ? undefined : 'RASS −5 到 +4')
export function checkRassTarget(min: number, max: number): Record<string, string> {
  const e: Record<string, string> = {}
  if (checkRass(min) || min === undefined) e.min = 'RASS −5 到 +4'
  if (checkRass(max) || max === undefined) e.max = 'RASS −5 到 +4'
  if (!e.min && !e.max && min > max) e.max = '上限不能比下限低'
  return e
}
/** 和目標比：太深（比下限低）、太淺（比上限高）、在範圍內 */
export const rassVsTarget = (score: number, t: { min: number; max: number }): 'in' | 'deep' | 'light' => (score < t.min ? 'deep' : score > t.max ? 'light' : 'in')
/** CAM-ICU 要 RASS ≥ −3 才評（−4、−5 叫不醒，無法評估注意力） */
export const CAM_ICU_RASS_MIN = -3

// ---------- 每 4 小時 ----------
export const VENT_CHECK_HOURS = 4
export const RASS_HOURS = 4
/** 到期前 30 分鐘起「現在」、過了「逾時」 */
export function everyHours(lastAt: string | undefined, since: string, hours: number, t: string): { dueAt: string; status: 'ok' | 'due' | 'overdue' } {
  const from = lastAt && lastAt > since ? lastAt : since
  const dueAt = addMinutes(from, hours * 60)
  return { dueAt, status: t > dueAt ? 'overdue' : t >= addMinutes(dueAt, -30) ? 'due' : 'ok' }
}

// ---------- 每日脫離評估 ----------
export const WEAN_LABEL: Record<WeanResult, string> = { pass: '通過', fail: '不通過', na: '不適合做' }
/** SAT 不通過（停鎮靜後躁動、血氧掉）就不做 SBT；不通過、不適合都要寫原因 */
export function checkWean(x: { sat?: string; sbt?: string; note?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x.sat || !(x.sat in WEAN_LABEL)) e.sat = '請選 SAT 結果'
  if (!x.sbt || !(x.sbt in WEAN_LABEL)) e.sbt = '請選 SBT 結果'
  if (!e.sat && !e.sbt && x.sat === 'fail' && x.sbt !== 'na') e.sbt = 'SAT 沒通過：今天不做 SBT（選「不適合做」）'
  // 原因和上一條分開判斷：兩個錯誤一次標出（SAT 沒過、SBT 選錯、又沒寫原因）
  if (!e.sat && (x.sat !== 'pass' || x.sbt !== 'pass') && !x.note?.trim()) e.note = '沒通過或不適合：請寫原因（例：FiO2 仍 60%、血壓要升壓劑）'
  return e
}

// ---------- DNR ----------
/** DNR 不施行氣管內插管：不能放氣管內管 */
export const intubationDnrProblem = (withhold: DnrItem[] | undefined) =>
  withhold?.includes('intubation') ? 'DNR 不施行氣管內插管：病人或家屬拒絕插管（要插管請先撤回 DNR）' : undefined
/** DNR 不施行人工呼吸：不能開呼吸器 */
export const ventDnrProblem = (withhold: DnrItem[] | undefined) =>
  withhold?.includes('ventilation') ? 'DNR 不施行人工呼吸：不能開呼吸器（要使用請先撤回 DNR）' : undefined
