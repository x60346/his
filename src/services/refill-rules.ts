// 慢性病連續處方箋（慢箋）的領藥規則（純函式：頁面提示、服務層、種子、測試共用）。
// 展示用的簡化版健保規則：
//   1. 「可調劑 N 次」含第一次看診當天領的那次：N = 2 → 之後還能再領 1 次；N = 3 → 2 次
//   2. 第 2 次起，要在「上次領的藥吃完前 10 天內」來領：
//        上次領藥日 + 天數 − 10 ～ 上次領藥日 + 天數 − 1（藥吃完的最後一天）
//      太早不能領（藥會囤積），過了最後一天就失效、要重新看診
//   3. 上一次的藥還沒領，就不能登記下一次（不能跳次）
//   4. 藥品照原處方，不能改（要改就得看診）
//   5. 同一科後來又開了新的慢箋，舊的就被取代（否則同一種藥可以兩張各領一次，病人手上會有雙倍的藥）
import type { MedicationOrder, VisitStatus } from '@/types'
import { addDays } from '@/utils/date'

/** 藥吃完前幾天開始可以領下一次 */
export const REFILL_WINDOW_DAYS = 10

/** 一張慢箋的其中一次調劑（第 1 次是看診當天的那次） */
export interface RefillFill {
  seq: number
  /** 這次的就醫日期 */
  date: string
  status: VisitStatus
  /** 實際發藥的日期（還沒領就沒有） */
  dispensedDate?: string
}

export interface RefillState {
  /** 總共可調劑幾次（含第一次） */
  total: number
  /** 已用掉幾次（含第一次；退掛的不算） */
  used: number
  /** 下一次是第幾次；已領完為 null */
  nextSeq: number | null
  /** 下一次可以領的期間 */
  window?: { from: string; to: string }
  /** 今天能不能登記領藥 */
  canRegister: boolean
  /** 不能登記的原因，或可以登記時的說明 */
  reason: string
  /** 已過期（藥吃完了還沒來領）：要重新看診 */
  expired: boolean
}

/** 這張處方一次給幾天的藥（取最長的那一項） */
export const supplyDays = (meds: Pick<MedicationOrder, 'days'>[]) => Math.max(0, ...meds.map((m) => m.days))

/** 上次領藥日 → 下一次可領的期間 */
export function refillWindow(lastDispensed: string, days: number): { from: string; to: string } {
  return { from: addDays(lastDispensed, days - REFILL_WINDOW_DAYS), to: addDays(lastDispensed, days - 1) }
}

const md = (d: string) => d.slice(5).replace('-', '/')

export function refillState(total: number, days: number, fills: RefillFill[], today: string): RefillState {
  const active = fills.filter((f) => f.status !== 'cancelled').sort((a, b) => a.seq - b.seq)
  const used = active.length
  const base = { total, used, expired: false }
  if (used >= total) return { ...base, nextSeq: null, canRegister: false, reason: '已領完' }
  const nextSeq = used + 1
  const last = active[active.length - 1]
  if (!last?.dispensedDate) {
    return { ...base, nextSeq, canRegister: false, reason: last && last.seq > 1 ? `第 ${last.seq} 次已登記，尚未領藥` : '上次的藥還沒領' }
  }
  const window = refillWindow(last.dispensedDate, days)
  if (today < window.from) return { ...base, nextSeq, window, canRegister: false, reason: `${md(window.from)} 起可領` }
  if (today > window.to) return { ...base, nextSeq, window, canRegister: false, expired: true, reason: `已逾期（應於 ${md(window.to)} 前領），請掛號看診` }
  return { ...base, nextSeq, window, canRegister: true, reason: `可領至 ${md(window.to)}` }
}

/** 被取代：同一位病人、同一科，之後又開了新的慢箋（看診開的，不是領藥）。回傳取代它的那張日期 */
export function supersededBy<E extends { id: string; patientId: string; deptId: string; date: string; refillTimes: number }>(e: E, all: E[]): string | undefined {
  return all.filter((x) => x.id !== e.id && x.patientId === e.patientId && x.deptId === e.deptId && x.refillTimes >= 2 && x.date > e.date).map((x) => x.date).sort()[0]
}
