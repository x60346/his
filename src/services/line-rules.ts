// 疼痛與管路（純函式）：疼痛 ≥4 要處置、1 小時重評；每班要評一次疼痛；管路的天數、每天「還需要嗎」、滿 7 天提醒主治、
// 周邊留置針滿 96 小時提醒更換、管路日統計。護理站清單、本班待辦、首頁、畫面、服務層都用這一份
import type { LineDevice, LineKind } from '@/types'
import { addMinutes } from '@/utils/date'

// ---------- 疼痛 ----------
/** 幾分以上算疼痛要處置 */
export const PAIN_ACT_FROM = 4
/** 處置後幾分鐘內要重評 */
export const PAIN_REASSESS_MIN = 60
/** 常用的疼痛處置（畫面一鍵帶入） */
export const PAIN_ACTIONS = ['依醫囑給予止痛藥', '協助舒適臥位、冰敷或熱敷', '通知醫師', '分散注意力、放鬆技巧']

/** 疼痛 ≥4 沒寫處置：回錯誤訊息 */
export const painActionProblem = (pain: number | undefined, action: string | undefined) =>
  pain !== undefined && pain !== null && !Number.isNaN(pain) && pain >= PAIN_ACT_FROM && !action?.trim() ? `疼痛 ${pain} 分（≥${PAIN_ACT_FROM}）：請寫處置，1 小時內重評` : undefined

export interface PainState {
  /** 最近一次的疼痛分數與時間 */
  last?: { score: number; at: string }
  /** 最近一次 ≥4：重評期限；狀態 upcoming 還沒到、overdue 過了沒重評 */
  reassess?: { dueAt: string; status: 'upcoming' | 'overdue' }
  /** 這一班評過疼痛沒有 */
  thisShift: boolean
}

/** records：這位病人有疼痛分數的紀錄（任何順序）；shiftStart：本班開始 */
export function painState(records: { at: string; pain?: number }[], now: string, shiftStart: string): PainState {
  const list = records.filter((r) => r.pain !== undefined && r.pain !== null).sort((a, b) => a.at.localeCompare(b.at))
  const last = list.at(-1)
  if (!last) return { thisShift: false }
  const out: PainState = { last: { score: last.pain!, at: last.at }, thisShift: last.at >= shiftStart }
  // 最後一筆 ≥4 才要重評（之後再有一筆就是重評過了，不論分數）
  if (last.pain! >= PAIN_ACT_FROM) {
    const dueAt = addMinutes(last.at, PAIN_REASSESS_MIN)
    out.reassess = { dueAt, status: now > dueAt ? 'overdue' : 'upcoming' }
  }
  return out
}

// ---------- 管路 ----------
export const LINE_KINDS: { kind: LineKind; label: string; short: string; dailyNeed: boolean; sites: string[]; sizes: string[]; bedsideOnly?: true }[] = [
  { kind: 'foley', label: '導尿管', short: 'Foley', dailyNeed: true, sites: ['尿道'], sizes: ['14Fr', '16Fr', '18Fr'] },
  { kind: 'cvc', label: '中心靜脈導管', short: 'CVC', dailyNeed: true, sites: ['右內頸靜脈', '左內頸靜脈', '右鎖骨下靜脈', '股靜脈'], sizes: ['7Fr 三腔', '7Fr 雙腔'] },
  { kind: 'pivc', label: '周邊靜脈留置針', short: 'IV', dailyNeed: false, sites: ['右手背', '左手背', '右前臂', '左前臂', '右肘前', '左肘前'], sizes: ['18G', '20G', '22G', '24G'] },
  { kind: 'ngt', label: '鼻胃管', short: 'NG', dailyNeed: false, sites: ['右鼻孔', '左鼻孔'], sizes: ['14Fr', '16Fr', '18Fr'] },
  { kind: 'peg', label: '胃造口', short: 'PEG', dailyNeed: false, sites: ['左上腹'], sizes: ['20Fr', '24Fr'] },
  // 氣管內管（醫師插管）：每天評估改由「每日脫離評估」（SAT／SBT）；管路日＝呼吸器日（VAP 的分母）
  { kind: 'ett', label: '氣管內管', short: 'ETT', dailyNeed: false, sites: ['經口', '經鼻', '氣切'], sizes: ['7.0', '7.5', '8.0', '8.5'] },
  // 胸管：醫師在「床邊處置」登錄置放時自動建立（管路分頁不能直接登錄）；護理師每班記引流量與漏氣
  { kind: 'chest', label: '胸管', short: 'CT', dailyNeed: false, sites: ['右側胸', '左側胸'], sizes: ['20Fr', '24Fr', '28Fr', '32Fr'], bedsideOnly: true },
]
export const lineKind = (k: LineKind) => LINE_KINDS.find((x) => x.kind === k)!
/** 導尿管、CVC 放滿幾天提醒主治（感染風險：每天評估還需不需要） */
export const LINE_ATTENDING_DAYS = 7
/** 周邊留置針放滿幾小時提醒更換 */
export const PIVC_REPLACE_HOURS = 96
export const LINE_REMOVE_REASONS = ['不需要了', '到期更換', '阻塞', '疑似感染（紅腫、發燒）', '滑脫', '病人自拔', '出院', '其他']

const hoursBetween = (from: string, to: string) => Math.max(0, (Date.parse(to.replace(' ', 'T')) - Date.parse(from.replace(' ', 'T'))) / 3600000)

export interface LineState {
  /** 放了幾小時、第幾天（放置當天算第 1 天） */
  hours: number
  day: number
  /** 今天還沒評估「還需要嗎」（導尿管、CVC） */
  needCheckDue: boolean
  /** 最近一次評估說「可以移除」還沒移除 */
  removable: boolean
  /** 導尿管、CVC 滿 7 天：提醒主治 */
  attendingAlert: boolean
  /** 周邊留置針滿 96 小時：提醒更換 */
  replaceDue: boolean
  /** 胸管：引流與漏氣 */
  chest?: ChestState
}

// ---------- 胸管 ----------
/** 每小時引流超過多少 mL 要通知醫師（術後或外傷出血） */
export const CHEST_BLEED_MLH = 200
/** 24 小時引流少於多少 mL、而且沒有漏氣，可以請醫師評估拔管 */
export const CHEST_REMOVE_ML24 = 200
/** 幾小時沒記引流要提醒（每班至少一次） */
export const CHEST_RECORD_HOURS = 8
export const CHEST_APPEARANCES = ['血性', '淡血性', '淡黃清澈', '混濁', '膿性', '無液體']
export interface ChestState {
  /** 最近 24 小時引流量 */
  ml24: number
  lastAt?: string
  /** 最近一次記錄有沒有漏氣 */
  airLeak: boolean
  /** 最近一次記錄的每小時引流量 */
  lastRate?: number
  /** 最近一次每小時 ≥200 mL：通知醫師 */
  bleeding: boolean
  /** 放滿 24 小時、最近 24 小時 < 200 mL、這段期間都沒漏氣：可以請醫師評估拔管 */
  removeHint: boolean
  /** 超過 8 小時沒記引流 */
  recordDue: boolean
}
export function chestState(l: Pick<LineDevice, 'insertedAt' | 'drainage' | 'removedAt'>, now: string): ChestState {
  const recs = [...(l.drainage ?? [])].sort((a, b) => a.at.localeCompare(b.at))
  const from = addMinutes(now, -24 * 60)
  const in24 = recs.filter((r) => r.at > from)
  const last = recs.at(-1)
  const prevAt = recs.length > 1 ? recs.at(-2)!.at : l.insertedAt
  const lastRate = last ? Math.round(last.ml / Math.max(1, hoursBetween(prevAt, last.at))) : undefined
  const ml24 = in24.reduce((n, r) => n + r.ml, 0)
  const open = !l.removedAt
  return {
    ml24, ...(last ? { lastAt: last.at, lastRate } : {}), airLeak: !!last?.airLeak,
    bleeding: open && !!last && lastRate! >= CHEST_BLEED_MLH,
    removeHint: open && hoursBetween(l.insertedAt, now) >= 24 && !!in24.length && ml24 < CHEST_REMOVE_ML24 && !in24.some((r) => r.airLeak),
    recordDue: open && hoursBetween(last?.at ?? l.insertedAt, now) >= CHEST_RECORD_HOURS,
  }
}
export function checkDrainage(x: { ml?: number | string; appearance?: string; at?: string }, insertedAt: string, now: string): Record<string, string> {
  const e: Record<string, string> = {}
  const v = Number(x.ml)
  if (x.ml === '' || x.ml === undefined || !Number.isFinite(v) || v < 0 || v > 5000) e.ml = '請填引流量（mL，0–5000）'
  if (!x.appearance?.trim()) e.appearance = '請選外觀'
  if (x.at !== undefined && (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x.at) || x.at > now || x.at < insertedAt)) e.at = '時間要在放置之後、現在以前'
  return e
}

export function lineState(l: Pick<LineDevice, 'kind' | 'insertedAt' | 'needChecks' | 'removedAt' | 'drainage'>, now: string): LineState {
  const end = l.removedAt ?? now
  const hours = hoursBetween(l.insertedAt, end)
  const day = Math.floor((Date.parse(end.slice(0, 10)) - Date.parse(l.insertedAt.slice(0, 10))) / 86400000) + 1
  const meta = lineKind(l.kind)
  const open = !l.removedAt
  const last = l.needChecks?.at(-1)
  return {
    hours: Math.floor(hours), day,
    needCheckDue: open && meta.dailyNeed && last?.date !== now.slice(0, 10),
    removable: open && !!last && !last.needed,
    attendingAlert: open && meta.dailyNeed && hours >= LINE_ATTENDING_DAYS * 24,
    replaceDue: open && l.kind === 'pivc' && hours >= PIVC_REPLACE_HOURS,
    ...(l.kind === 'chest' ? { chest: chestState(l, now) } : {}),
  }
}

/** 管路日：在 [from, to]（日期）之間，管路在身上的日數（放置與移除當天都算一天）——病房感染管制指標的分母 */
export function lineDays(l: Pick<LineDevice, 'insertedAt' | 'removedAt'>, from: string, to: string): number {
  const s = l.insertedAt.slice(0, 10) > from ? l.insertedAt.slice(0, 10) : from
  const e = l.removedAt && l.removedAt.slice(0, 10) < to ? l.removedAt.slice(0, 10) : to
  return s > e ? 0 : Math.floor((Date.parse(e) - Date.parse(s)) / 86400000) + 1
}

/** 登錄管路的欄位檢查 */
export function checkLineInput(x: { kind?: string; site?: string; size?: string; insertedAt?: string; placedBy?: string }, now: string): Record<string, string> {
  const e: Record<string, string> = {}
  if (!LINE_KINDS.some((k) => k.kind === x.kind)) e.kind = '請選管路種類'
  if (!x.site?.trim()) e.site = '請寫部位'
  if (!x.size?.trim()) e.size = '請寫尺寸'
  if (!x.placedBy?.trim()) e.placedBy = '請寫放置者'
  if (!x.insertedAt || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x.insertedAt)) e.insertedAt = '請填放置時間'
  else if (x.insertedAt > now) e.insertedAt = '放置時間不能晚於現在'
  return e
}
