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
