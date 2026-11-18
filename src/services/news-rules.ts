// 早期預警分數 NEWS2 與快速反應小組（純函式）：一般病房的生命徵象算分、分級、再量時間、快速反應評估的欄位檢查。
// 生命徵象頁的即時預覽、護理站待辦、醫師首頁、快速反應小組頁、服務層、測試都用這一份
import type { Avpu, VitalRecord } from '@/types'
import { addMinutes } from '@/utils/date'

/** 意識 ACVPU：A 以外（新出現的混亂也算）一律 3 分 */
export const AVPU_LEVELS: { value: Avpu; label: string }[] = [
  { value: 'A', label: 'A 清醒' },
  { value: 'C', label: 'C 新出現的混亂' },
  { value: 'V', label: 'V 對聲音有反應' },
  { value: 'P', label: 'P 對痛有反應' },
  { value: 'U', label: 'U 沒反應' },
]
export const avpuLabel = (x?: Avpu) => AVPU_LEVELS.find((l) => l.value === x)?.label ?? ''
/** 給氧 0–15 L/min（0＝室內空氣） */
export const O2_RANGE: [number, number] = [0, 15]

/** NEWS2 七項（SpO2 用量表 1；慢性二氧化碳滯留病人的量表 2 沒做） */
export type NewsKey = 'resp' | 'spo2' | 'o2' | 'sbp' | 'pulse' | 'avpu' | 'temp'
export const NEWS_LABEL: Record<NewsKey, string> = { resp: '呼吸', spo2: '血氧', o2: '給氧', sbp: '收縮壓', pulse: '心跳', avpu: '意識', temp: '體溫' }
export const NEWS_KEYS = Object.keys(NEWS_LABEL) as NewsKey[]

/** 依 NEWS2 表給分（邊界照原表：呼吸 ≤8 → 3、9–11 → 1、12–20 → 0、21–24 → 2、≥25 → 3…） */
function points(k: NewsKey, v: VitalRecord): number {
  switch (k) {
    case 'resp': { const x = v.resp!; return x <= 8 ? 3 : x <= 11 ? 1 : x <= 20 ? 0 : x <= 24 ? 2 : 3 }
    case 'spo2': { const x = v.spo2!; return x <= 91 ? 3 : x <= 93 ? 2 : x <= 95 ? 1 : 0 }
    case 'o2': return v.o2! > 0 ? 2 : 0
    case 'sbp': { const x = v.sbp!; return x <= 90 ? 3 : x <= 100 ? 2 : x <= 110 ? 1 : x <= 219 ? 0 : 3 }
    case 'pulse': { const x = v.pulse!; return x <= 40 ? 3 : x <= 50 ? 1 : x <= 90 ? 0 : x <= 110 ? 1 : x <= 130 ? 2 : 3 }
    case 'avpu': return v.avpu === 'A' ? 0 : 3
    case 'temp': { const x = v.temp!; return x <= 35 ? 3 : x <= 36 ? 1 : x <= 38 ? 0 : x <= 39 ? 1 : 2 }
  }
}
const has = (v: VitalRecord, k: NewsKey) => v[k] !== undefined && v[k] !== null && (v[k] as unknown) !== ''

export type NewsLevel = 'low' | 'medium' | 'high'
export const NEWS_LEVEL_LABEL: Record<NewsLevel, string> = { low: '低', medium: '中', high: '高' }
/** 5–6 分、或任一項 3 分：通知主治、1 小時內再量 */
export const NEWS_MEDIUM = 5
/** ≥7 分：自動呼叫快速反應小組 */
export const NEWS_HIGH = 7
export const NEWS_RECHECK_MIN = 60

export interface NewsResult {
  total: number
  level: NewsLevel
  /** 有一項 3 分（分數不到 5 也要通知） */
  red: boolean
  parts: { key: NewsKey; label: string; points: number }[]
}
/** 七項都有才算（缺一項算出來的分數會偏低，不如不算）；缺的項目回傳 missing */
export function newsScore(v: VitalRecord): NewsResult | { missing: string[] } {
  const missing = NEWS_KEYS.filter((k) => !has(v, k))
  if (missing.length) return { missing: missing.map((k) => NEWS_LABEL[k]) }
  const parts = NEWS_KEYS.map((k) => ({ key: k, label: NEWS_LABEL[k], points: points(k, v) }))
  const total = parts.reduce((n, p) => n + p.points, 0)
  const red = parts.some((p) => p.points === 3)
  return { total, red, parts, level: total >= NEWS_HIGH ? 'high' : total >= NEWS_MEDIUM || red ? 'medium' : 'low' }
}
export const isNews = (x: NewsResult | { missing: string[] } | undefined): x is NewsResult => !!x && 'total' in x
/** 中、高要 1 小時內再量 */
export const newsRecheckDue = (at: string, level: NewsLevel) => (level === 'low' ? undefined : addMinutes(at, NEWS_RECHECK_MIN))
/** 畫面上的處理建議 */
export const NEWS_ADVICE: Record<NewsLevel, string> = {
  low: '依常規測量',
  medium: '通知主治醫師評估，1 小時內再量',
  high: '快速反應小組評估（≥7 分存檔時自動呼叫），持續監測（至少每小時）',
}

/** 生命徵象頁：給氧、意識的輸入檢查（欄位 o2、avpu） */
export function checkNewsExtra(x: { o2?: number; avpu?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (x.o2 !== undefined && x.o2 !== null && !Number.isNaN(x.o2) && (x.o2 < O2_RANGE[0] || x.o2 > O2_RANGE[1])) e.o2 = `給氧數值不合理（可輸入 ${O2_RANGE[0]}–${O2_RANGE[1]} L/min，0＝室內空氣）`
  if (x.avpu !== undefined && x.avpu !== null && (x.avpu as unknown) !== '' && !AVPU_LEVELS.some((l) => l.value === x.avpu)) e.avpu = '意識請選 A、C、V、P、U'
  return e
}

/** 手動呼叫（護理師擔心病人）：要寫原因 */
export const checkRrtCall = (x: { reason?: string }): Record<string, string> => (x.reason?.trim() ? {} : { reason: '請寫呼叫原因（例：病人突然躁動、說不出話，覺得不對勁）' })

/** 快速反應小組評估：發現、處置、去向都要填；轉加護病房要選類別、寫原因（和轉入申請同一套） */
export function checkRrtAssessment(x: { findings?: string; actions?: string; disposition?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x.findings?.trim()) e.findings = '請寫評估發現'
  if (!x.actions?.trim()) e.actions = '請寫處置（沒有處置請寫「持續觀察」）'
  if (x.disposition !== 'stay' && x.disposition !== 'icu') e.disposition = '請選留原病房或申請轉加護病房'
  return e
}
export const RRT_DISPOSITION_LABEL = { stay: '留原病房', icu: '申請轉加護病房' } as const
