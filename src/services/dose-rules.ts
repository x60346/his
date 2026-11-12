// 劑量合理性（純函式）：門診處方、住院醫囑、頁面即時提示、測試共用。
//
// 各藥的劑量刻度差很多（1 顆錠劑 vs 10 U Insulin），不能用一個固定上限，
// 所以用「該藥預設劑量的倍數」判斷：
//   ok     正常
//   high   偏高——可能是刻意的（加量），需醫師確認後才能開立
//   absurd 不合理——幾乎一定是打錯（例：每次 100 支），直接擋下
// 這不是臨床上的最大劑量（那要依每種藥的仿單設定），而是攔住「多打一個 0」的防線。
import type { Drug } from '@/types'
import { autoQty, doseUnitOf } from './billing'

export const DOSE_HIGH_RATIO = 3
/** 高警訊藥品更嚴格 */
export const DOSE_HIGH_RATIO_HIGH_ALERT = 2
export const DOSE_ABSURD_RATIO = 20

export type DoseLevel = 'ok' | 'high' | 'absurd'

export function doseLevel(drug: Pick<Drug, 'defaultDose' | 'highAlert'>, dose: number): DoseLevel {
  if (!(dose > 0) || !(drug.defaultDose > 0)) return 'ok' // 0 或負數由「必須大於 0」的檢查處理
  const ratio = dose / drug.defaultDose
  if (ratio > DOSE_ABSURD_RATIO) return 'absurd'
  return ratio > (drug.highAlert ? DOSE_HIGH_RATIO_HIGH_ALERT : DOSE_HIGH_RATIO) ? 'high' : 'ok'
}

/** 給人看的說明，例：「每次 100 VIAL，是常用劑量 1 VIAL 的 100 倍」 */
export function doseNote(drug: Drug, dose: number): string {
  const u = doseUnitOf(drug)
  const ratio = Math.round((dose / drug.defaultDose) * 10) / 10
  return `每次 ${dose} ${u}，是常用劑量 ${drug.defaultDose} ${u} 的 ${ratio} 倍`
}

/** 單張處方天數上限：慢性病連續處方也是每次 30 天以內，超過幾乎一定是打錯（999 天 → 2997 顆） */
export const MAX_RX_DAYS = 30

/** 處方天數檢查：有問題回傳訊息，沒問題回傳 null */
export function checkDays(days: number | undefined): string | null {
  if (days === undefined || days === null || !Number.isInteger(days) || days < 1) return '天數需為 1 以上的整數'
  if (days > MAX_RX_DAYS) return `天數最多 ${MAX_RX_DAYS} 天`
  return null
}

// ---------- 處方天數一次改完 ----------
export interface DaysRow {
  drugId: string
  dose: number
  freq: string
  days: number
  qty: number
  /** 總量是醫師手動填的（不自動重算） */
  _manual?: boolean
  /** 天數改了、總量沒有跟著改，請醫師確認 */
  _qtyStale?: boolean
}

/**
 * 把處方的天數全部改成 days（醫師「這次開 7 天」，以前要一筆一筆改，漏改一種病人就提早吃完）。
 * 回傳新的列，不改動傳入的資料：
 *   - 可換算、沒手動改過的：總量自動重算
 *   - 總量手動改過、或無法換算（Insulin 筆、眼藥水）：總量保留，標 _qtyStale，請醫師確認——以前改天數這些總量默默不變
 * 天數不合法（checkDays）時一筆都不改，回傳錯誤。
 */
export function applyDaysToAll<T extends DaysRow>(
  rows: readonly T[],
  days: number,
  drugOf: (drugId: string) => Pick<Drug, 'unit' | 'doseUnit'> | undefined,
  timesOf: (freq: string) => number,
): { error: string } | { rows: T[]; stale: string[] } {
  const err = checkDays(days)
  if (err) return { error: err }
  const stale: string[] = []
  const out = rows.map((r) => {
    if (r.days === days) return { ...r }
    const d = drugOf(r.drugId)
    const q = d && !r._manual ? autoQty(d, r.dose || 0, timesOf(r.freq), days) : null
    if (q !== null) return { ...r, days, qty: q, _qtyStale: false }
    stale.push(r.drugId)
    return { ...r, days, _qtyStale: true }
  })
  return { rows: out, stale }
}

/** 處方裡出現的天數（由小到大、不重複）；超過一種就是「天數不一致」 */
export const distinctDays = (rows: readonly Pick<DaysRow, 'days'>[]) => [...new Set(rows.map((r) => r.days))].sort((a, b) => a - b)
