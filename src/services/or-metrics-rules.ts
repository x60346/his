// 手術室效率（純函式）：首台準時開刀、換台時間、各房使用率、當天取消；今天首台延誤。
// 「準時」以麻醉前查核（Sign In）時間算——系統沒有「病人進房」時間，Sign In 是最接近的時點；
// 換台＝同一間房同一天，前一台離開前查核（Sign Out）到下一台麻醉前查核。急刀不算首台、不算換台（不是排好的節奏）
import type { Surgery } from '@/types'
import { addMinutes, parseDate } from '@/utils/date'
import { OR_DAY } from './surgery-rules'

/** 麻醉前查核晚於排程開始超過這麼多分鐘＝首台延誤 */
export const OR_ONTIME_MINUTES = 15
/** 換台超過這麼久不算「連台」（中間空檔，不是換台） */
export const OR_TURNOVER_MAX = 180

const mins = (a: string, b: string) => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 60000)
const dayOf = (s: Pick<Surgery, 'schedule'>) => s.schedule!.start.slice(0, 10)
const inRange = (d: string, from: string, to: string) => d >= from && d <= to

type S = Pick<Surgery, 'id' | 'no' | 'status' | 'schedule' | 'checks' | 'urgency' | 'cancelled' | 'estMinutes'>

/**
 * 每間房每天第一台（擇期、沒取消的）：麻醉前查核在排程開始 15 分鐘內＝準時。
 * 還沒做麻醉前查核、但已經過了 15 分鐘的也算延誤（晚到現在）；還沒到時間的不算
 */
export function firstCaseStats(list: S[], from: string, to: string, now: string): { total: number; ontime: number; pct: number | null; late: { no: string; room: string; date: string; minutes: number; open?: boolean }[] } {
  const firsts = new Map<string, S>()
  const t = now.slice(0, 16)
  for (const s of list.filter((x) => x.schedule && !x.urgency && x.status !== 'cancelled' && inRange(dayOf(x), from, to))) {
    const k = `${dayOf(s)} ${s.schedule!.room}`
    const cur = firsts.get(k)
    if (!cur || s.schedule!.start < cur.schedule!.start) firsts.set(k, s)
  }
  const xs = [...firsts.values()]
    .filter((s) => s.checks.signIn || mins(s.schedule!.start, t) > OR_ONTIME_MINUTES)
    .map((s) => ({ s, minutes: mins(s.schedule!.start, s.checks.signIn ? s.checks.signIn.at.slice(0, 16) : t) }))
  const late = xs.filter((x) => x.minutes > OR_ONTIME_MINUTES).map((x) => ({ no: x.s.no, room: x.s.schedule!.room, date: dayOf(x.s), minutes: x.minutes, ...(x.s.checks.signIn ? {} : { open: true }) }))
  return { total: xs.length, ontime: xs.length - late.length, pct: xs.length ? Math.round(((xs.length - late.length) / xs.length) * 100) : null, late }
}

/** 換台：同房同天、相鄰兩台（都擇期、前一台做完）的 Sign Out → 下一台 Sign In；回傳平均與每間房 */
export function turnoverStats(list: S[], from: string, to: string): { count: number; avg: number | null; byRoom: Record<string, { count: number; avg: number }> } {
  const done = list.filter((x) => x.schedule && !x.urgency && x.checks.signIn && inRange(dayOf(x), from, to) && x.status !== 'cancelled').sort((a, b) => a.schedule!.start.localeCompare(b.schedule!.start))
  const gaps: { room: string; minutes: number }[] = []
  const groups = new Map<string, S[]>()
  for (const s of done) groups.set(`${dayOf(s)} ${s.schedule!.room}`, [...(groups.get(`${dayOf(s)} ${s.schedule!.room}`) ?? []), s])
  for (const xs of groups.values()) {
    for (let i = 1; i < xs.length; i++) {
      const out = xs[i - 1].checks.signOut?.at
      if (!out) continue
      const m = mins(out.slice(0, 16), xs[i].checks.signIn!.at.slice(0, 16))
      if (m >= 0 && m <= OR_TURNOVER_MAX) gaps.push({ room: xs[i].schedule!.room, minutes: m })
    }
  }
  const avg = (ys: { minutes: number }[]) => Math.round(ys.reduce((a, b) => a + b.minutes, 0) / ys.length)
  const byRoom: Record<string, { count: number; avg: number }> = {}
  for (const r of new Set(gaps.map((g) => g.room))) {
    const ys = gaps.filter((g) => g.room === r)
    byRoom[r] = { count: ys.length, avg: avg(ys) }
  }
  return { count: gaps.length, avg: gaps.length ? avg(gaps) : null, byRoom }
}

/** 一段時間裡和開放時段（08:00–20:00）重疊的分鐘數 */
export function openMinutesOf(start: string, end: string): number {
  let total = 0
  for (let d = start.slice(0, 10); d <= end.slice(0, 10); d = addMinutes(`${d} 00:00`, 24 * 60).slice(0, 10)) {
    const a = [start, `${d} ${OR_DAY.start}`].sort().at(-1)!
    const b = [end, `${d} ${OR_DAY.end}`].sort()[0]
    if (b > a) total += mins(a, b)
  }
  return total
}

/**
 * 各房使用率：在房時間（Sign In → Sign Out，只算開放時段內的部分）÷ 開放時間（天數 × 12 小時）。
 * 急刀也算在房時間（房間確實被用了）
 */
export function utilization(list: S[], rooms: string[], from: string, to: string): { room: string; usedMinutes: number; openMinutes: number; pct: number }[] {
  const days = mins(`${from} 00:00`, `${to} 00:00`) / (24 * 60) + 1
  const open = days * mins(`${from} ${OR_DAY.start}`, `${from} ${OR_DAY.end}`)
  return rooms.map((room) => {
    const used = list
      .filter((x) => x.schedule?.room === room && x.checks.signIn && x.checks.signOut && inRange(x.checks.signIn.at.slice(0, 10), from, to))
      .reduce((a, x) => a + openMinutesOf(x.checks.signIn!.at.slice(0, 16), x.checks.signOut!.at.slice(0, 16)), 0)
    return { room, usedMinutes: used, openMinutes: open, pct: Math.round((used / open) * 1000) / 10 }
  })
}

/** 當天取消：排了程、在手術那天才取消的（含原因）；取消率＝當天取消 ÷ 排程台數 */
export function cancelStats(list: S[], from: string, to: string): { scheduled: number; sameDay: number; pct: number | null; reasons: { no: string; date: string; reason: string }[] } {
  const xs = list.filter((x) => x.schedule && inRange(dayOf(x), from, to))
  const same = xs.filter((x) => x.status === 'cancelled' && x.cancelled && x.cancelled.at.slice(0, 10) === dayOf(x))
  return { scheduled: xs.length, sameDay: same.length, pct: xs.length ? Math.round((same.length / xs.length) * 1000) / 10 : null, reasons: same.map((x) => ({ no: x.no, date: dayOf(x), reason: x.cancelled!.reason })) }
}

/** 今天的首台：排程開始過了 15 分鐘還沒做麻醉前查核（每間房只看第一台、擇期） */
export function lateFirstCases(list: S[], date: string, now: string): { id: string; room: string; start: string; minutes: number }[] {
  const firsts = new Map<string, S>()
  for (const s of list.filter((x) => x.schedule && !x.urgency && x.status !== 'cancelled' && dayOf(x) === date)) {
    const cur = firsts.get(s.schedule!.room)
    if (!cur || s.schedule!.start < cur.schedule!.start) firsts.set(s.schedule!.room, s)
  }
  return [...firsts.values()]
    .filter((s) => !s.checks.signIn && mins(s.schedule!.start, now.slice(0, 16)) > OR_ONTIME_MINUTES)
    .map((s) => ({ id: s.id, room: s.schedule!.room, start: s.schedule!.start, minutes: mins(s.schedule!.start, now.slice(0, 16)) }))
    .sort((a, b) => a.room.localeCompare(b.room))
}
