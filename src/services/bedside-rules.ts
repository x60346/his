// 床邊侵入性處置（純函式）：種類、要不要側別、要記哪些結果、出血風險、欄位檢查。服務層（bedside.ts、consent.ts）、畫面、種子、測試共用
import type { BedsideKind, BedsideProcedure, Consent } from '@/types'
import { consentValid } from './consent-rules'

export interface BedsideMeta {
  kind: BedsideKind
  label: string
  /** 計費醫令 */
  procId: string
  /** 要選左右側 */
  sided: boolean
  /** 要記引流量（mL） */
  volume: boolean
  /** 要記開口壓（cmH2O） */
  pressure: boolean
  /** 外觀常用選項 */
  appearances: string[]
  /** 單次引流量的建議上限（超過要寫原因，例：胸腔穿刺 1500 mL 有復張性肺水腫風險） */
  maxVolumeMl?: number
}
export const BEDSIDE_KINDS: BedsideMeta[] = [
  { kind: 'lp', label: '腰椎穿刺', procId: 'P068', sided: false, volume: false, pressure: true, appearances: ['清澈無色', '混濁', '血性', '黃色（xanthochromia）'] },
  { kind: 'thoracentesis', label: '胸腔穿刺', procId: 'P069', sided: true, volume: true, pressure: false, appearances: ['淡黃清澈', '混濁', '血性', '膿性'], maxVolumeMl: 1500 },
  { kind: 'paracentesis', label: '腹腔穿刺', procId: 'P070', sided: false, volume: true, pressure: false, appearances: ['淡黃清澈', '混濁', '血性', '乳糜狀'], maxVolumeMl: 5000 },
  { kind: 'chestTube', label: '胸管置放', procId: 'P071', sided: true, volume: true, pressure: false, appearances: ['淡黃清澈', '血性', '膿性', '氣體（無液體）'] },
]
export const bedsideKind = (k: BedsideKind) => BEDSIDE_KINDS.find((x) => x.kind === k)!
export const SIDE_TEXT: Record<'left' | 'right', string> = { left: '左側', right: '右側' }
export const bedsideTitle = (k: BedsideKind, side?: 'left' | 'right') => `${bedsideKind(k).label}${side ? `（${SIDE_TEXT[side]}）` : ''}`

/** 沒有同意書也能執行的原因（張力性氣胸這類來不及） */
export const BEDSIDE_CONSENT_WAIVERS = ['緊急狀況，來不及事先取得同意（醫療法第 63 條但書，事後補說明）']

/** 血小板低於多少（10³/µL）算出血風險 */
export const BEDSIDE_PLT_MIN = 50
/** 算出血風險的抗凝血、抗血小板藥（學名關鍵字） */
export const BLEEDING_DRUGS = ['warfarin', 'clopidogrel', 'heparin', 'enoxaparin', 'rivaroxaban', 'apixaban', 'dabigatran', 'edoxaban']

/** 出血風險：最近的血小板、使用中的抗凝血／抗血小板藥 → 一句一句 */
export function bleedingRisks(plt: { value: string; at: string } | undefined, drugs: { name: string; generic: string }[]): string[] {
  const out: string[] = []
  const v = plt ? Number(plt.value) : NaN
  if (plt && Number.isFinite(v) && v < BEDSIDE_PLT_MIN) out.push(`血小板 ${plt.value}（${plt.at.slice(5, 16)}，< ${BEDSIDE_PLT_MIN}）`)
  for (const d of drugs) if (BLEEDING_DRUGS.some((k) => d.generic.toLowerCase().includes(k))) out.push(`使用中：${d.name}`)
  return out
}

/** 這次住院、這種處置（有側別的同側）還沒用掉的有效同意書 */
export const unusedBedsideConsent = <C extends Pick<Consent, 'id' | 'kind' | 'admissionId' | 'bedsideKind' | 'side' | 'revoked'>>(cs: C[], done: Pick<BedsideProcedure, 'consentId'>[], admissionId: string, kind: BedsideKind, side?: 'left' | 'right') =>
  cs.find((c) => c.kind === 'procedure' && c.admissionId === admissionId && c.bedsideKind === kind && consentValid(c) && (!bedsideKind(kind).sided || c.side === side) && !done.some((p) => p.consentId === c.id))

export interface BedsideInput {
  kind?: string
  side?: string
  indication?: string
  /** 處置前暫停：病人身分、部位與側別 */
  timeOut?: { identity?: boolean; site?: boolean }
  performedAt?: string
  appearance?: string
  volumeMl?: number | string
  openingPressure?: number | string
  complication?: string
  bleedingNote?: string
  volumeNote?: string
}

/** 欄位檢查（risks：這位病人現在的出血風險；有就要寫評估） */
export function checkBedsideInput(x: BedsideInput, now: string, risks: string[] = []): Record<string, string> {
  const e: Record<string, string> = {}
  const m = BEDSIDE_KINDS.find((k) => k.kind === x.kind)
  if (!m) return { kind: '請選處置' }
  if (m.sided && x.side !== 'left' && x.side !== 'right') e.side = '請選左側或右側'
  if (!x.indication?.trim()) e.indication = '請寫適應症（例：肋膜積液待診斷）'
  if (!x.timeOut?.identity || !x.timeOut?.site) e.timeOut = '處置前暫停：病人身分、部位與側別都要確認'
  if (!x.performedAt || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x.performedAt)) e.performedAt = '請填執行時間'
  else if (x.performedAt > now) e.performedAt = '執行時間不能在未來'
  if (!x.appearance?.trim()) e.appearance = '請寫外觀'
  if (m.volume) {
    const v = Number(x.volumeMl)
    if (x.volumeMl === '' || x.volumeMl === undefined || !Number.isFinite(v) || v < 0 || v > 10000) e.volumeMl = '請填引流量（mL）'
    else if (m.maxVolumeMl && v > m.maxVolumeMl && !x.volumeNote?.trim()) e.volumeNote = `單次超過 ${m.maxVolumeMl} mL：請寫原因與病人狀況`
  }
  if (m.pressure && x.openingPressure !== '' && x.openingPressure !== undefined) {
    const p = Number(x.openingPressure)
    if (!Number.isFinite(p) || p < 0 || p > 60) e.openingPressure = '開口壓 0–60 cmH2O（沒量可以空白）'
  }
  if (!x.complication?.trim()) e.complication = '請寫併發症（沒有寫「無」）'
  if (risks.length && !x.bleedingNote?.trim()) e.bleedingNote = '有出血風險：請寫評估（例：已輸血小板、Warfarin 停 5 天 INR 1.1）'
  return e
}
