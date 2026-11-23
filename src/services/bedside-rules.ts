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
  { procId: 'P073', label: '體液生化（蛋白、白蛋白、糖、LDH）' },
  { procId: 'P059', label: '細菌培養' },
]
/** 送體液生化時同時抽血清（胸水 Light's criteria、腹水 SAAG、腦脊髓液血糖比值都要用） */
export const SERUM_PROC = 'P074'
export const PLEURAL_KINDS: BedsideKind[] = ['thoracentesis', 'chestTube']
/** 血清 LDH 參考值上限（Light's criteria 第三項：胸水 LDH > 上限的 2/3） */
export const SERUM_LDH_ULN = 280
/** 血清和胸水同一次判讀：抽血時間和穿刺相差幾小時內才算 */
export const SERUM_PAIR_HOURS = 24

export interface FluidRead {
  kind: 'exudate' | 'transudate' | 'sbp' | 'noSbp' | 'portalHtn' | 'nonPortal' | 'bacterial' | 'pleocytosis' | 'csfProtein' | 'csfNormal'
  label: string
  reasons: string[]
  /** 要馬上處理的（滲出液、腹膜炎、細菌性腦膜炎）：畫面標紅 */
  alert?: boolean
}
/** 胸水 Light's criteria：任一項成立＝滲出液（蛋白比 > 0.5、LDH 比 > 0.6、胸水 LDH > 血清上限 2/3）；缺值回 undefined */
export function lightCriteria(f: { pro?: number; ldh?: number }, s: { pro?: number; ldh?: number }, uln = SERUM_LDH_ULN): FluidRead | undefined {
  if (![f.pro, f.ldh, s.pro, s.ldh].every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)) return undefined
  const pr = f.pro! / s.pro!
  const lr = f.ldh! / s.ldh!
  const r = (x: number) => Math.round(x * 100) / 100
  const reasons = [pr > 0.5 && `蛋白比 ${r(pr)}（> 0.5）`, lr > 0.6 && `LDH 比 ${r(lr)}（> 0.6）`, f.ldh! > (uln * 2) / 3 && `胸水 LDH ${f.ldh}（> 血清上限 2/3＝${Math.round((uln * 2) / 3)}）`].filter((x): x is string => !!x)
  return reasons.length
    ? { kind: 'exudate', label: '滲出液', reasons, alert: true }
    : { kind: 'transudate', label: '漏出液', reasons: [`蛋白比 ${r(pr)}、LDH 比 ${r(lr)}、胸水 LDH ${f.ldh}，三項都沒超過`] }
}
/** 腹水嗜中性球數（白血球 × 嗜中性球 %）≥ 250/µL：疑似自發性細菌性腹膜炎 */
export const SBP_PMN = 250
export function ascitesPmn(wbc?: number, pmnPct?: number): FluidRead | undefined {
  if (typeof wbc !== 'number' || typeof pmnPct !== 'number' || !Number.isFinite(wbc) || !Number.isFinite(pmnPct)) return undefined
  const n = Math.round((wbc * pmnPct) / 100)
  return n >= SBP_PMN ? { kind: 'sbp', label: '疑似自發性細菌性腹膜炎', reasons: [`嗜中性球 ${n}/µL（≥ ${SBP_PMN}）`], alert: true } : { kind: 'noSbp', label: '嗜中性球未達腹膜炎標準', reasons: [`嗜中性球 ${n}/µL（< ${SBP_PMN}）`] }
}

/** 腹水 SAAG（血清白蛋白 − 腹水白蛋白）≥ 1.1 g/dL：門脈高壓（肝硬化、心衰竭）；< 1.1：非門脈高壓（腹膜轉移、結核、胰臟炎…） */
export const SAAG_CUT = 1.1
export function saagRead(serumAlb?: number, fluidAlb?: number): FluidRead | undefined {
  if (typeof serumAlb !== 'number' || typeof fluidAlb !== 'number' || !Number.isFinite(serumAlb) || !Number.isFinite(fluidAlb)) return undefined
  const g = Math.round((serumAlb - fluidAlb) * 10) / 10
  return g >= SAAG_CUT
    ? { kind: 'portalHtn', label: '門脈高壓性腹水', reasons: [`SAAG ${g}（≥ ${SAAG_CUT}，肝硬化、心衰竭等）`] }
    : { kind: 'nonPortal', label: '非門脈高壓性腹水', reasons: [`SAAG ${g}（< ${SAAG_CUT}，考慮腹膜轉移、結核、胰臟炎）`] }
}

/**
 * 腦脊髓液（成人）：白血球 > 5/µL 算增加；腦脊髓液／血清血糖 < 0.4，或白血球 ≥ 1000 且嗜中性球 > 50%：疑似細菌性腦膜炎；
 * 蛋白 > 45 mg/dL 偏高（體液生化的蛋白單位是 g/dL，換算 ×1000）。缺血清血糖就不算比值
 */
export const CSF_WBC_MAX = 5
export const CSF_PRO_MAX = 45
export const CSF_GLU_RATIO = 0.4
/**
 * 腦脊髓液正常上限依年齡（足月新生兒、小嬰兒比較高）：0–28 天白血球 ≤19/µL、蛋白 ≤115 mg/dL；29–56 天 ≤9、≤89；之後同成人 ≤5、≤45
 */
export const CSF_LIMITS: { maxDays: number; label: string; wbc: number; pro: number }[] = [
  { maxDays: 28, label: '新生兒（0–28 天）', wbc: 19, pro: 115 },
  { maxDays: 56, label: '小嬰兒（29–56 天）', wbc: 9, pro: 89 },
  { maxDays: Infinity, label: '', wbc: CSF_WBC_MAX, pro: CSF_PRO_MAX },
]
export const csfLimitsFor = (ageDays?: number) => CSF_LIMITS.find((l) => (ageDays ?? Infinity) <= l.maxDays)!
/** 穿刺出血校正：每 700 個紅血球扣 1 個白血球（周邊血球正常時的經驗值）；紅血球 ≥ 這個數才校正 */
export const CSF_RBC_PER_WBC = 700
export function csfRead(x: { wbc?: number; pmn?: number; rbc?: number; glu?: number; proGdl?: number }, serumGlu?: number, ageDays?: number): FluidRead | undefined {
  if (typeof x.wbc !== 'number' || !Number.isFinite(x.wbc)) return undefined
  const lim = csfLimitsFor(ageDays)
  const bloody = typeof x.rbc === 'number' && x.rbc >= CSF_RBC_PER_WBC
  const wbc = bloody ? Math.max(0, Math.round(x.wbc - x.rbc! / CSF_RBC_PER_WBC)) : x.wbc
  const ratio = typeof x.glu === 'number' && typeof serumGlu === 'number' && serumGlu > 0 ? Math.round((x.glu / serumGlu) * 100) / 100 : undefined
  const proMg = typeof x.proGdl === 'number' ? Math.round(x.proGdl * 1000) : undefined
  const reasons = [
    lim.label && `依${lim.label}標準`,
    bloody ? `白血球 ${x.wbc}/µL，扣除穿刺出血（紅血球 ${x.rbc}／${CSF_RBC_PER_WBC}）校正後 ${wbc}${wbc > lim.wbc ? `（> ${lim.wbc}）` : ''}` : `白血球 ${wbc}/µL${wbc > lim.wbc ? `（> ${lim.wbc}）` : ''}`,
    typeof x.pmn === 'number' && `嗜中性球 ${x.pmn}%`,
    ratio !== undefined && `血糖比 ${ratio}${ratio < CSF_GLU_RATIO ? `（< ${CSF_GLU_RATIO}）` : ''}`,
    proMg !== undefined && `蛋白 ${proMg} mg/dL${proMg > lim.pro ? `（> ${lim.pro}）` : ''}${bloody ? '（穿刺出血也會讓蛋白偏高）' : ''}`,
  ].filter((r): r is string => !!r)
  if ((ratio !== undefined && ratio < CSF_GLU_RATIO) || (wbc >= 1000 && (x.pmn ?? 0) > 50)) return { kind: 'bacterial', label: '疑似細菌性腦膜炎（盡快給經驗性抗生素，等培養）', reasons, alert: true }
  if (wbc > lim.wbc) return { kind: 'pleocytosis', label: '白血球增加（病毒性或其他原因，配合培養與臨床）', reasons }
  if (proMg !== undefined && proMg > lim.pro) return { kind: 'csfProtein', label: '白血球正常、蛋白偏高', reasons }
  return { kind: 'csfNormal', label: bloody ? '校正穿刺出血後大致正常' : '腦脊髓液大致正常', reasons }
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
