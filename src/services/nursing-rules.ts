// 護理站的共用規則（純函式）：服務層用來把關，頁面用來即時顯示，測試用來驗證。
// 「時間」是護理站的核心維度——同一筆給藥，十點看是「待給」，十一點看就是「逾時」。
import { addMinutes } from '@/utils/date'

/** 給藥時間窗：預定時間前 60 分鐘起可給，超過預定時間 30 分鐘算逾時 */
export const MAR_EARLY_MIN = 60
export const MAR_LATE_MIN = 30

export type MarUrgency = 'upcoming' | 'due' | 'overdue'

/** 依「現在時間」判斷一筆未執行給藥的急迫程度 */
export function marUrgency(scheduledAt: string, nowStr: string): MarUrgency {
  if (nowStr > addMinutes(scheduledAt, MAR_LATE_MIN)) return 'overdue'
  if (nowStr >= addMinutes(scheduledAt, -MAR_EARLY_MIN)) return 'due'
  return 'upcoming'
}

/**
 * 補登給藥時間：忙的時候 09:00 給藥、09:40 才登打，紀錄要寫實際的 09:00（以前固定記「按下的那一刻」）。
 *   不能晚於現在（還沒給的不能先登）
 *   不能早於可給藥時間（預定前 60 分鐘）——和「太早不能給」同一條 marUrgency，補登不能繞過
 *   最多往前 2 小時——更早的請寫在護理紀錄（展示用的上限，真實系統由院方訂）
 * 頁面即時提示與服務層共用。
 */
export const MAR_BACKDATE_MAX_MIN = 120
export function checkGivenAt(scheduledAt: string, givenAt: string, nowStr: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(givenAt)) return '請輸入實際給藥時間'
  if (givenAt > nowStr) return '給藥時間不能晚於現在'
  if (marUrgency(scheduledAt, givenAt) === 'upcoming') return `早於可給藥時間（預定 ${scheduledAt.slice(11)}，最早可提前 ${MAR_EARLY_MIN} 分鐘）`
  if (givenAt < addMinutes(nowStr, -MAR_BACKDATE_MAX_MIN)) return `補登最多往前 ${MAR_BACKDATE_MAX_MIN / 60} 小時，更早的請寫在護理紀錄`
  return null
}

export type Shift = '白班' | '小夜' | '大夜'
/** 班別：白班 08–16、小夜 16–24、大夜 00–08 */
export function shiftOf(dateTime: string): Shift {
  const h = Number(dateTime.slice(11, 13))
  return h >= 8 && h < 16 ? '白班' : h >= 16 ? '小夜' : '大夜'
}

/**
 * 交班預設班別：交班是「要下班的人」寫的，常在換班前後半小時內。
 * 08:10 寫交班的是剛下大夜的人，不是剛上白班的人——所以往回推 30 分鐘再判斷。
 */
export function handoverShiftOf(dateTime: string): Shift {
  return shiftOf(addMinutes(dateTime, -30))
}

/**
 * 醫囑的「最近異動」：接班的人最需要知道「上一班之後改了什麼」。
 * 24 小時內新開的標「新」；24 小時內停止或完成的仍列出（劃掉），超過就只留在醫師端的歷史裡。
 */
export const ORDER_RECENT_HOURS = 24
export type OrderChange = 'new' | 'stopped' | 'done'
export function orderChange(o: { status: 'active' | 'stopped' | 'done'; startAt: string; stopAt?: string }, nowStr: string): OrderChange | null {
  const since = addMinutes(nowStr, -ORDER_RECENT_HOURS * 60)
  if (o.status !== 'active') return o.stopAt && o.stopAt >= since ? (o.status === 'done' ? 'done' : 'stopped') : null
  return o.startAt >= since ? 'new' : null
}

/**
 * 這筆醫囑是否還等著護理師核對：新開的沒簽收、停止的沒確認。沒有時間限制——沒人核對就一直標著。
 * 已完成（done）的不用：那是護理師自己執行完的，執行本身就代表看過了。
 */
export function needsAck(o: { status: 'active' | 'stopped' | 'done'; ackAt?: string; stopAckAt?: string }): boolean {
  return (o.status === 'active' && !o.ackAt) || (o.status === 'stopped' && !o.stopAckAt)
}

/** 待醫師回覆的疑問（最後一筆還沒回覆）；沒有回傳 undefined */
export function openQuery<Q extends { replyAt?: string }>(o: { queries?: Q[] }): Q | undefined {
  const last = o.queries?.at(-1)
  return last && !last.replyAt ? last : undefined
}

/**
 * 「哪一班」＝班別＋這一班開始的日期。交班屬於班，不屬於日曆上的某一天：
 * 11/10 的小夜（16–24 點）常在 11/11 00:10 才寫完交班，它仍是「11/10 小夜」。
 * 以前用寫的那一天當日期，小夜 23:45 寫的交班，大夜 00:15 打開就看不到（查的是新的一天）。
 */
export interface ShiftInstance {
  date: string
  shift: Shift
}

/** 一天之內的班別順序 */
export const SHIFT_ORDER: Shift[] = ['大夜', '白班', '小夜']

/**
 * 在 dateTime 寫的、屬於 shift 班別的交班，是哪一班。
 * 只有一種情況會跨日：小夜（16–24）在午夜後才寫（例：00:10），屬於前一天的小夜。
 */
export function shiftInstanceOf(shift: Shift, dateTime: string): ShiftInstance {
  const d = dateTime.slice(0, 10)
  const h = Number(dateTime.slice(11, 13))
  return { date: shift === '小夜' && h < 16 ? addMinutes(`${d} 00:00`, -1).slice(0, 10) : d, shift }
}

/** 班別開始的鐘點 */
const SHIFT_START_HOUR: Record<Shift, number> = { 大夜: 0, 白班: 8, 小夜: 16 }

/** dateTime 所在這一班的起訖（訖不含）：例 10:30 → 08:00 ~ 16:00 */
export function shiftRange(dateTime: string): { start: string; end: string } {
  const shift = shiftOf(dateTime)
  const start = `${dateTime.slice(0, 10)} ${String(SHIFT_START_HOUR[shift]).padStart(2, '0')}:00`
  return { start, end: addMinutes(start, 8 * 60) }
}

/** 這一班量過生命徵象沒有：最新一筆在本班開始之後。病人清單的「本班未量」與本班待辦共用 */
export function measuredThisShift(latestAt: string | undefined, nowStr: string): boolean {
  return !!latestAt && latestAt >= shiftRange(nowStr).start
}

/** 從 dateTime 所在的班往回數 n 班（含目前這班），最新的在前：00:15 → 11/11 大夜、11/10 小夜、11/10 白班 */
export function recentShifts(dateTime: string, n: number): ShiftInstance[] {
  const out: ShiftInstance[] = []
  let date = dateTime.slice(0, 10)
  let i = SHIFT_ORDER.indexOf(shiftOf(dateTime))
  while (out.length < n) {
    out.push({ date, shift: SHIFT_ORDER[i] })
    if (--i < 0) {
      i = SHIFT_ORDER.length - 1
      date = addMinutes(`${date} 00:00`, -1).slice(0, 10)
    }
  }
  return out
}

export type VitalKey = 'temp' | 'pulse' | 'resp' | 'sbp' | 'dbp' | 'spo2' | 'pain' | 'intake' | 'output'

export interface VitalSpec {
  label: string
  unit: string
  /** 可輸入的合理範圍：超出就是打錯字（體溫 52 度），服務層直接擋下 */
  limit: [number, number]
  /** 臨床正常範圍：超出是「異常」，要提醒但允許記錄 */
  normal?: [number, number]
}

export const vitalSpecs: Record<VitalKey, VitalSpec> = {
  temp: { label: '體溫', unit: '°C', limit: [30, 45], normal: [36, 37.5] },
  pulse: { label: '脈搏', unit: '次/分', limit: [20, 250], normal: [60, 100] },
  resp: { label: '呼吸', unit: '次/分', limit: [4, 60], normal: [12, 20] },
  sbp: { label: '收縮壓', unit: 'mmHg', limit: [40, 280], normal: [90, 140] },
  dbp: { label: '舒張壓', unit: 'mmHg', limit: [20, 180], normal: [60, 90] },
  // 一般病房血氧以 94% 為警示線：門檻定太嚴，人人都「異常」，警示就沒人看了（警示疲勞）
  spo2: { label: '血氧', unit: '%', limit: [50, 100], normal: [94, 100] },
  pain: { label: '疼痛', unit: '分', limit: [0, 10], normal: [0, 3] },
  intake: { label: '輸入量', unit: 'ml', limit: [0, 10000] },
  output: { label: '輸出量', unit: 'ml', limit: [0, 10000] },
}

/** 數值是否超出臨床正常範圍（沒有正常範圍的項目一律視為正常） */
export function isAbnormal(key: VitalKey, value: number | undefined): boolean {
  const n = vitalSpecs[key].normal
  return value !== undefined && value !== null && !!n && (value < n[0] || value > n[1])
}

/**
 * 輸入檢查：超出「可輸入範圍」就是打錯字，存不進去。頁面即時提示與服務層共用，兩邊說法一致。
 * 以前頁面只看「正常範圍」，體溫打 98.6（華氏）時先顯示「超出正常範圍」（像是發燒），
 * 存檔才被服務層說「數值不合理」，前後矛盾。
 */
export function vitalInputProblem(key: VitalKey, value: number | undefined): string | null {
  if (value === undefined || value === null || Number.isNaN(value)) return null
  const { label, limit } = vitalSpecs[key]
  if (value >= limit[0] && value <= limit[1]) return null
  // 華氏 86–113 °F 約等於攝氏 30–45 °C：很可能是單位打錯
  if (key === 'temp' && value >= 86 && value <= 113) {
    const c = Math.round(((value - 32) * 5) / 9 * 10) / 10
    return `體溫請以攝氏輸入：${value} 看起來是華氏，約 ${c} °C`
  }
  return `${label}數值不合理（可輸入 ${limit[0]}–${limit[1]}）`
}
