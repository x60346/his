// 腎功能劑量調整與 Vancomycin 血中濃度（純函式）：Cockcroft-Gault 肌酸酐清除率、藥品主檔的腎功能分級、
// 目前的頻率是否比建議的多、Vancomycin 谷濃度的範圍與「第 4 劑前抽」。住院醫囑、開醫囑對話框、每日審視、首頁待辦、測試都用這一份
import type { RenalBand } from '@/types'

/** Cockcroft-Gault 用的資料多久內算數：肌酸酐 7 天內、體重 30 天內（太舊的不拿來調劑量） */
export const CRE_VALID_DAYS = 7
export const WEIGHT_VALID_DAYS = 30

/**
 * 肌酸酐清除率（ml/min，整數）：(140 − 年齡) × 體重 ÷ (72 × 肌酸酐)，女性 × 0.85。
 * 缺任何一項回 null（不用預設體重硬算——算錯比沒算更危險）
 */
export function crclOf(x: { age?: number; female?: boolean; weightKg?: number; scr?: number }): number | null {
  if (!x.age || !x.weightKg || !x.scr || x.scr <= 0) return null
  const v = ((140 - x.age) * x.weightKg) / (72 * x.scr)
  return Math.round(x.female ? v * 0.85 : v)
}

/** 這個 CrCl 落在哪一級：門檻最低、又比 CrCl 高的那一級（CrCl 25、分級 <50 與 <26 → 取 <26） */
export function renalBandOf(bands: RenalBand[] | undefined, crcl: number | null): RenalBand | undefined {
  if (!bands?.length || crcl === null) return undefined
  return bands.filter((b) => crcl < b.below).sort((a, b) => a.below - b.below)[0]
}

/**
 * 頻率要不要調：目前每天的次數比建議的多才提醒（已經是建議的頻率或更少就不吵）。
 * perDay 傳頻率代碼 → 每天幾次（主檔頻率表）
 */
export function renalAdjust(bands: RenalBand[] | undefined, freq: string | undefined, crcl: number | null, perDay: (code: string) => number | undefined): { band: RenalBand; text: string } | undefined {
  const band = renalBandOf(bands, crcl)
  if (!band || !freq) return undefined
  // 沒有建議頻率＝建議停用：還在用就提醒
  if (!band.freq) return { band, text: `CrCl ${crcl} ml/min（< ${band.below}）：${band.text}` }
  const now = perDay(freq)
  const want = perDay(band.freq)
  if (now === undefined || want === undefined || now <= want) return undefined
  return { band, text: `CrCl ${crcl} ml/min（< ${band.below}）：${band.text}（建議 ${band.freq}，目前 ${freq}）` }
}

/** Vancomycin 谷濃度目標 10–20 µg/mL */
export const VANCO_TROUGH = { low: 10, high: 20 }
/** 給了幾劑之後就該抽谷濃度（第 4 劑前） */
export const VANCO_TROUGH_AFTER_DOSES = 3

export type TdmState =
  | { status: 'due'; text: string }
  | { status: 'pending'; text: string }
  | { status: 'high' | 'low' | 'ok'; text: string; value: number; at: string }

/**
 * Vancomycin 這一筆醫囑的谷濃度狀態（只看這筆醫囑開立之後的：改了劑量就要重抽）：
 *  - 有報告：過高（>20）、過低（<10）、在範圍內
 *  - 已開檢驗、還沒報告：待報告
 *  - 已給 3 劑以上、還沒開：該抽了（第 4 劑前）
 *  - 其他（還沒給到 3 劑）：undefined
 */
export function tdmState(x: { given: number; ordered: boolean; latest?: { value: number; at: string } }): TdmState | undefined {
  if (x.latest) {
    const v = x.latest.value
    const status = v > VANCO_TROUGH.high ? 'high' : v < VANCO_TROUGH.low ? 'low' : 'ok'
    const text = status === 'high' ? `谷濃度 ${v}（> ${VANCO_TROUGH.high}）：過高，請減量或延長間隔` : status === 'low' ? `谷濃度 ${v}（< ${VANCO_TROUGH.low}）：過低，請加量或縮短間隔` : `谷濃度 ${v}：在目標範圍（${VANCO_TROUGH.low}–${VANCO_TROUGH.high}）`
    return { status, text, value: v, at: x.latest.at }
  }
  if (x.ordered) return { status: 'pending', text: '谷濃度已開立，等報告' }
  if (x.given >= VANCO_TROUGH_AFTER_DOSES) return { status: 'due', text: `已給 ${x.given} 劑：請在下一劑前抽谷濃度` }
  return undefined
}
