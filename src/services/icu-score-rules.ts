// 加護病房轉入轉出與嚴重度（純函式）：轉入類別與申請檢查、SOFA（每天）、APACHE II（轉入 24 小時內）、
// 加護病房住了哪幾段、48 小時內再轉回（bounce back）。分數頁、服務層、品質指標、測試都用這一份。
// 都是簡化版：SOFA 心血管用升壓劑時依當天最高劑量，沒用才看 MAP；APACHE II 沒抽的檢驗以 0 分計並列出「缺」
import { sofaCardioByVaso, type VasoMax } from './vaso-rules'
import type { IcuCategory } from '@/types'

export const ICU_CATEGORIES: { key: IcuCategory; label: string }[] = [
  { key: 'resp', label: '呼吸衰竭' },
  { key: 'shock', label: '休克' },
  { key: 'postop', label: '術後監測' },
  { key: 'other', label: '其他' },
]
export const icuCategoryLabel = (k: IcuCategory) => ICU_CATEGORIES.find((x) => x.key === k)?.label ?? k
export function checkIcuRequest(x: { category?: string; reason?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!ICU_CATEGORIES.some((c) => c.key === x.category)) e.category = '請選轉入類別'
  if (!x.reason?.trim()) e.reason = '請寫原因（例：血壓 82/45，輸液 2 L 後仍低，乳酸 4.2）'
  return e
}
/** 轉出摘要四段：診斷、經過與處置、管路、待追蹤 */
export const ICU_SUMMARY_FIELDS = [
  { key: 'diagnosis', label: '診斷' },
  { key: 'course', label: '加護病房經過與處置' },
  { key: 'lines', label: '目前管路' },
  { key: 'todo', label: '轉出後待追蹤' },
] as const
export type IcuSummaryInput = Record<(typeof ICU_SUMMARY_FIELDS)[number]['key'], string>
export function checkIcuSummary(x: Partial<IcuSummaryInput>): Record<string, string> {
  const e: Record<string, string> = {}
  for (const f of ICU_SUMMARY_FIELDS) if (f.key !== 'lines' && !x[f.key]?.trim()) e[f.key] = `請寫${f.label}`
  return e
}

// ---------- SOFA ----------
export type SofaKey = 'resp' | 'coag' | 'liver' | 'cardio' | 'cns' | 'renal'
export const SOFA_LABEL: Record<SofaKey, string> = { resp: '呼吸（PaO2/FiO2）', coag: '凝血（血小板）', liver: '肝臟（膽紅素）', cardio: '心血管（MAP）', cns: '神經（GCS）', renal: '腎臟（肌酸酐／尿量）' }
export interface SofaInput {
  /** 當天最低的 PaO2/FiO2，當時有沒有接呼吸器（沒接的最多 2 分） */
  pf?: { ratio: number; vent: boolean }
  /** 血小板 10³/µL（最低） */
  plt?: number
  /** 總膽紅素 mg/dL（最高） */
  bili?: number
  /** MAP（最低） */
  map?: number
  /** 升壓劑當天最高劑量（有用就依劑量給分，不看 MAP） */
  vaso?: VasoMax
  /** GCS（最低） */
  gcs?: number
  /** 肌酸酐 mg/dL（最高） */
  cre?: number
  /** 一整天的尿量 ml（不滿一天不算） */
  urine?: number
}
export function sofaScore(x: SofaInput): { total: number; parts: Record<SofaKey, number | null>; missing: SofaKey[] } {
  const resp = x.pf ? (() => {
    const r = x.pf.ratio
    const p = r >= 400 ? 0 : r >= 300 ? 1 : r >= 200 ? 2 : r >= 100 ? 3 : 4
    return x.pf.vent ? p : Math.min(p, 2)
  })() : null
  const coag = x.plt === undefined ? null : x.plt >= 150 ? 0 : x.plt >= 100 ? 1 : x.plt >= 50 ? 2 : x.plt >= 20 ? 3 : 4
  const liver = x.bili === undefined ? null : x.bili < 1.2 ? 0 : x.bili < 2 ? 1 : x.bili < 6 ? 2 : x.bili < 12 ? 3 : 4
  const byVaso = x.vaso ? sofaCardioByVaso(x.vaso) : undefined
  const cardio = byVaso ?? (x.map === undefined ? null : x.map >= 70 ? 0 : 1)
  const cns = x.gcs === undefined ? null : x.gcs >= 15 ? 0 : x.gcs >= 13 ? 1 : x.gcs >= 10 ? 2 : x.gcs >= 6 ? 3 : 4
  const byCre = x.cre === undefined ? null : x.cre < 1.2 ? 0 : x.cre < 2 ? 1 : x.cre < 3.5 ? 2 : x.cre < 5 ? 3 : 4
  const byUo = x.urine === undefined ? null : x.urine < 200 ? 4 : x.urine < 500 ? 3 : 0
  const renal = byCre === null && byUo === null ? null : Math.max(byCre ?? 0, byUo ?? 0)
  const parts: Record<SofaKey, number | null> = { resp, coag, liver, cardio, cns, renal }
  const missing = (Object.keys(parts) as SofaKey[]).filter((k) => parts[k] === null)
  return { total: (Object.values(parts) as (number | null)[]).reduce<number>((n, p) => n + (p ?? 0), 0), parts, missing }
}

// ---------- APACHE II ----------
export type ApacheKey = 'temp' | 'map' | 'hr' | 'rr' | 'oxy' | 'ph' | 'na' | 'k' | 'cre' | 'hct' | 'wbc' | 'gcs'
export const APACHE_LABEL: Record<ApacheKey, string> = { temp: '體溫', map: 'MAP', hr: '心跳', rr: '呼吸', oxy: '氧合', ph: '動脈 pH', na: '鈉', k: '鉀', cre: '肌酸酐', hct: '血比容', wbc: '白血球', gcs: 'GCS' }
const T = (v: number) => (v >= 41 ? 4 : v >= 39 ? 3 : v >= 38.5 ? 1 : v >= 36 ? 0 : v >= 34 ? 1 : v >= 32 ? 2 : v >= 30 ? 3 : 4)
const MAPP = (v: number) => (v >= 160 ? 4 : v >= 130 ? 3 : v >= 110 ? 2 : v >= 70 ? 0 : v >= 50 ? 2 : 4)
const HR = (v: number) => (v >= 180 ? 4 : v >= 140 ? 3 : v >= 110 ? 2 : v >= 70 ? 0 : v >= 55 ? 2 : v >= 40 ? 3 : 4)
const RR = (v: number) => (v >= 50 ? 4 : v >= 35 ? 3 : v >= 25 ? 1 : v >= 12 ? 0 : v >= 10 ? 1 : v >= 6 ? 2 : 4)
const PH = (v: number) => (v >= 7.7 ? 4 : v >= 7.6 ? 3 : v >= 7.5 ? 1 : v >= 7.33 ? 0 : v >= 7.25 ? 2 : v >= 7.15 ? 3 : 4)
const NA = (v: number) => (v >= 180 ? 4 : v >= 160 ? 3 : v >= 155 ? 2 : v >= 150 ? 1 : v >= 130 ? 0 : v >= 120 ? 2 : v >= 111 ? 3 : 4)
const K = (v: number) => (v >= 7 ? 4 : v >= 6 ? 3 : v >= 5.5 ? 1 : v >= 3.5 ? 0 : v >= 3 ? 1 : v >= 2.5 ? 2 : 4)
const CRE = (v: number) => (v >= 3.5 ? 4 : v >= 2 ? 3 : v >= 1.5 ? 2 : v >= 0.6 ? 0 : 2)
const HCT = (v: number) => (v >= 60 ? 4 : v >= 50 ? 2 : v >= 46 ? 1 : v >= 30 ? 0 : v >= 20 ? 2 : 4)
const WBC = (v: number) => (v >= 40 ? 4 : v >= 20 ? 2 : v >= 15 ? 1 : v >= 3 ? 0 : v >= 1 ? 2 : 4)
/** 肺泡－動脈氧分壓差 A-a = FiO2 ×（760−47）− PaCO2 ÷ 0.8 − PaO2（FiO2 用小數） */
export const aaGradient = (fio2: number, pao2: number, paco2: number) => Math.round(fio2 * 713 - paco2 / 0.8 - pao2)
/** 氧合：FiO2 ≥ 0.5 看 A-a、< 0.5 看 PaO2 */
export const oxyPoints = (o: { fio2: number; pao2: number; paco2: number }) => {
  if (o.fio2 >= 0.5) {
    const aa = aaGradient(o.fio2, o.pao2, o.paco2)
    return aa >= 500 ? 4 : aa >= 350 ? 3 : aa >= 200 ? 2 : 0
  }
  return o.pao2 > 70 ? 0 : o.pao2 >= 61 ? 1 : o.pao2 >= 55 ? 3 : 4
}
export const agePoints = (age: number) => (age >= 75 ? 6 : age >= 65 ? 5 : age >= 55 ? 3 : age >= 45 ? 2 : 0)
export const chronicPoints = (chronic: boolean, surgery: 'none' | 'emergency' | 'elective') => (!chronic ? 0 : surgery === 'elective' ? 2 : 5)

export interface ApacheInput {
  temp: number[]; map: number[]; hr: number[]; rr: number[]
  oxy: { fio2: number; pao2: number; paco2: number }[]
  ph: number[]; na: number[]; k: number[]; cre: number[]; hct: number[]; wbc: number[]
  /** GCS 總分（最低那次 → 15 − GCS 分） */
  gcs: number[]
  age: number
  chronic: boolean
  surgery: 'none' | 'emergency' | 'elective'
}
/** 每一項取 24 小時內「分數最高（最差）」的那個值；沒有資料的以 0 分計、列在 missing */
export function apacheScore(x: ApacheInput) {
  const worst = <V>(vs: V[], f: (v: V) => number) => (vs.length ? Math.max(...vs.map(f)) : null)
  const parts: Record<ApacheKey, number | null> = {
    temp: worst(x.temp, T), map: worst(x.map, MAPP), hr: worst(x.hr, HR), rr: worst(x.rr, RR), oxy: worst(x.oxy, oxyPoints), ph: worst(x.ph, PH),
    na: worst(x.na, NA), k: worst(x.k, K), cre: worst(x.cre, CRE), hct: worst(x.hct, HCT), wbc: worst(x.wbc, WBC), gcs: worst(x.gcs, (g) => 15 - g),
  }
  const missing = (Object.keys(parts) as ApacheKey[]).filter((k) => parts[k] === null)
  const aps = (Object.values(parts) as (number | null)[]).reduce<number>((n, p) => n + (p ?? 0), 0)
  const ag = agePoints(x.age)
  const ch = chronicPoints(x.chronic, x.surgery)
  return { total: aps + ag + ch, aps, agePts: ag, chronicPts: ch, parts, missing }
}

// ---------- 住了哪幾段、再轉回 ----------
/** 再轉回：轉出後 48 小時內又轉進加護病房 */
export const BOUNCE_HOURS = 48
/** 床位紀錄（依時間）→ 住加護病房的幾段（連續住加護病房的算一段；最後一段沒轉出 to 是 undefined） */
export function icuStays(hist: { from: string; icu: boolean }[], end?: string): { from: string; to?: string }[] {
  const out: { from: string; to?: string }[] = []
  hist.forEach((h, i) => {
    const prevIcu = i > 0 && hist[i - 1].icu
    if (h.icu && !prevIcu) out.push({ from: h.from })
    if (!h.icu && prevIcu) out[out.length - 1].to = h.from
  })
  if (end && out.length && !out[out.length - 1].to) out[out.length - 1].to = end
  return out
}
const minutes = (a: string, b: string) => (Date.parse(b.replace(' ', 'T')) - Date.parse(a.replace(' ', 'T'))) / 60000
/** 哪幾段是 48 小時內再轉回（第二段以後、離上一段轉出不到 48 小時） */
export const bounceBacks = (stays: { from: string; to?: string }[]) => stays.filter((s, i) => i > 0 && !!stays[i - 1].to && minutes(stays[i - 1].to!, s.from) <= BOUNCE_HOURS * 60)
