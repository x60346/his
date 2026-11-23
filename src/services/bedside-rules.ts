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

/** 穿刺液是什麼（送檢醫囑上寫） */
export const BEDSIDE_FLUID: Record<BedsideKind, string> = { lp: '腦脊髓液', thoracentesis: '胸水', paracentesis: '腹水', chestTube: '胸水' }
/** 可以勾的送檢（體液常規、生化、細菌培養）：登錄時自動開臨時檢驗醫囑，護理師貼條碼送檢 */
export const BEDSIDE_LABS = [
  { procId: 'P072', label: '體液常規（細胞計數、分類）' },
  { procId: 'P073', label: '體液生化（蛋白、糖、LDH）' },
  { procId: 'P059', label: '細菌培養' },
]
/** 胸水（胸腔穿刺、胸管）送體液生化時，同時抽血清總蛋白、LDH（Light's criteria 要用） */
export const SERUM_PROC = 'P074'
export const PLEURAL_KINDS: BedsideKind[] = ['thoracentesis', 'chestTube']
/** 血清 LDH 參考值上限（Light's criteria 第三項：胸水 LDH > 上限的 2/3） */
export const SERUM_LDH_ULN = 280
/** 血清和胸水同一次判讀：抽血時間和穿刺相差幾小時內才算 */
export const SERUM_PAIR_HOURS = 24

export interface FluidRead {
  kind: 'exudate' | 'transudate' | 'sbp' | 'noSbp'
  label: string
  reasons: string[]
}
/** 胸水 Light's criteria：任一項成立＝滲出液（蛋白比 > 0.5、LDH 比 > 0.6、胸水 LDH > 血清上限 2/3）；缺值回 undefined */
export function lightCriteria(f: { pro?: number; ldh?: number }, s: { pro?: number; ldh?: number }, uln = SERUM_LDH_ULN): FluidRead | undefined {
  if (![f.pro, f.ldh, s.pro, s.ldh].every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)) return undefined
  const pr = f.pro! / s.pro!
  const lr = f.ldh! / s.ldh!
  const r = (x: number) => Math.round(x * 100) / 100
  const reasons = [pr > 0.5 && `蛋白比 ${r(pr)}（> 0.5）`, lr > 0.6 && `LDH 比 ${r(lr)}（> 0.6）`, f.ldh! > (uln * 2) / 3 && `胸水 LDH ${f.ldh}（> 血清上限 2/3＝${Math.round((uln * 2) / 3)}）`].filter((x): x is string => !!x)
  return reasons.length
    ? { kind: 'exudate', label: '滲出液', reasons }
    : { kind: 'transudate', label: '漏出液', reasons: [`蛋白比 ${r(pr)}、LDH 比 ${r(lr)}、胸水 LDH ${f.ldh}，三項都沒超過`] }
}
/** 腹水嗜中性球數（白血球 × 嗜中性球 %）≥ 250/µL：疑似自發性細菌性腹膜炎 */
export const SBP_PMN = 250
export function ascitesPmn(wbc?: number, pmnPct?: number): FluidRead | undefined {
  if (typeof wbc !== 'number' || typeof pmnPct !== 'number' || !Number.isFinite(wbc) || !Number.isFinite(pmnPct)) return undefined
  const n = Math.round((wbc * pmnPct) / 100)
  return n >= SBP_PMN ? { kind: 'sbp', label: '疑似自發性細菌性腹膜炎', reasons: [`嗜中性球 ${n}/µL（≥ ${SBP_PMN}）`] } : { kind: 'noSbp', label: '嗜中性球未達腹膜炎標準', reasons: [`嗜中性球 ${n}/µL（< ${SBP_PMN}）`] }
}

export const CHEST_TUBE_SIZES = ['20Fr', '24Fr', '28Fr', '32Fr']

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
  /** 送檢（BEDSIDE_LABS 的 procId） */
  labs?: string[]
  /** 胸管：尺寸、放好時水封瓶有沒有氣泡 */
  tubeSize?: string
  airLeak?: boolean
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
  if (x.kind === 'chestTube' && !x.tubeSize?.trim()) e.tubeSize = '請選胸管尺寸'
  if ((x.labs ?? []).some((p) => !BEDSIDE_LABS.some((l) => l.procId === p))) e.labs = '送檢項目不對'
  if (x.labs?.length && x.kind === 'chestTube' && Number(x.volumeMl) === 0) e.labs = '沒有引流液，不能送檢'
  if (risks.length && !x.bleedingNote?.trim()) e.bleedingNote = '有出血風險：請寫評估（例：已輸血小板、Warfarin 停 5 天 INR 1.1）'
  return e
}
