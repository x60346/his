// 急刀插台順延（純函式）：同房、還沒送的擇期台照原順序往後推，保留原本的換台間隔（最多 30 分）；
// 順延到超過開放時段標紅（排程人改期或同意加班）；禁食延長提醒；效率指標的「被急刀順延」。
// 服務層（surgery.ts scheduleSurgery）、手術室看板、病房手術頁、首頁待辦、測試都用這一份
import type { Surgery } from '@/types'
import { addMinutes, parseDate } from '@/utils/date'
import { OR_DAY, overlaps } from './surgery-rules'

/** 急刀之後第一台的換台時間；後面各台保留原本的間隔，但最多這麼多 */
export const OR_GAP = 30
/** 累計順延這麼久以上、病人已經禁食：提醒病房評估補點滴 */
export const NPO_DELAY_ALERT = 120

const mins = (a: string, b: string) => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 60000)
const endOf = (start: string, est: number) => addMinutes(start, est)

export interface ShiftCase { id: string; start: string; est: number }
export interface ShiftMove { id: string; from: string; to: string; minutes: number }

/**
 * 急刀 u 插進一間房：movable＝同房同天、還沒送的擇期台；fixed＝同房其他不能動的（別的急刀）。
 * 在急刀開始前就做完的不動；其他照原順序：第一台接在急刀後 30 分，後面每台和前一台的間隔照原本（最多 30 分），
 * 原本時間比較晚、不用動的就不動。推過去會撞到 fixed 的，排到 fixed 之後（再加 30 分）
 */
export function shiftPlan(u: { start: string; est: number }, movable: ShiftCase[], fixed: ShiftCase[] = []): ShiftMove[] {
  const xs = [...movable].sort((a, b) => a.start.localeCompare(b.start))
  const blocks = [{ start: u.start, est: u.est }, ...fixed]
  let cursor = endOf(u.start, u.est)
  let prevEnd: string | undefined
  let first = true
  const out: ShiftMove[] = []
  for (const x of xs) {
    const origEnd = endOf(x.start, x.est)
    if (origEnd <= u.start) continue
    const gap = first || !prevEnd ? OR_GAP : Math.min(OR_GAP, Math.max(0, mins(prevEnd, x.start)))
    first = false
    prevEnd = origEnd
    const need = addMinutes(cursor, gap)
    let to = x.start < need ? need : x.start
    for (let hit = blocks.find((b) => overlaps(b.start, b.est, to, x.est)); hit; hit = blocks.find((b) => overlaps(b.start, b.est, to, x.est))) to = addMinutes(endOf(hit.start, hit.est), OR_GAP)
    if (to !== x.start) out.push({ id: x.id, from: x.start, to, minutes: mins(x.start, to) })
    cursor = endOf(to, x.est)
  }
  return out
}

/** 結束時間超過當天開放時段（或跨到隔天） */
export const pastDayEnd = (start: string, est: number): boolean => ((e) => e.slice(0, 10) !== start.slice(0, 10) || e.slice(11) > OR_DAY.end)(endOf(start, est))

type S = Pick<Surgery, 'status' | 'schedule' | 'estMinutes' | 'delays' | 'overtime' | 'urgency'>
/** 被順延、還沒送、超過開放時段、排程人還沒同意加班＝要處理（標紅） */
export const delayOverflow = (s: S): boolean => s.status === 'scheduled' && !!s.delays?.length && !!s.schedule && pastDayEnd(s.schedule.start, s.estMinutes) && !s.overtime
/** 累計順延分鐘 */
export const delayTotal = (s: Pick<Surgery, 'delays'>): number => (s.delays ?? []).reduce((n, d) => n + d.minutes, 0)

/**
 * 可以拉回：這台還沒送、現在的時間就是最後一次順延後的時間（之後沒再改過），而那台急刀已經取消、
 * 或不在插台時的房間與時間了。回傳要拉回的那筆順延
 */
export function pullBackOf<D extends { causeId: string; causeRoom?: string; causeStart?: string; to: string; pullBack?: boolean }>(
  s: { status: string; schedule?: { start: string }; delays?: D[] },
  cause: (id: string) => { status: string; schedule?: { room: string; start: string } } | undefined,
): D | undefined {
  const d = s.delays?.at(-1)
  if (!d || d.pullBack || s.status !== 'scheduled' || s.schedule?.start !== d.to) return undefined
  const c = cause(d.causeId)
  if (!c) return undefined
  const gone = c.status === 'cancelled' || (!!d.causeStart && (c.schedule?.room !== d.causeRoom || c.schedule?.start !== d.causeStart))
  return gone ? d : undefined
}

/** 效率：區間內（以第一次被順延那天算）被急刀順延的擇期台數（取消的也算）、平均與最多延後分鐘 */
export function delayStats(list: Pick<Surgery, 'delays'>[], from: string, to: string): { count: number; avg: number | null; max: number } {
  const xs = list.filter((s) => s.delays?.length && ((d) => d >= from && d <= to)(s.delays[0].at.slice(0, 10)))
  // 拉回的不扣（統計的是被順延了多少）
  const ms = xs.map((s) => s.delays!.filter((d) => d.minutes > 0).reduce((n, d) => n + d.minutes, 0))
  return {
    count: xs.length, avg: xs.length ? Math.round(ms.reduce((a, b) => a + b, 0) / xs.length) : null, max: ms.length ? Math.max(...ms) : 0,
  }
}
