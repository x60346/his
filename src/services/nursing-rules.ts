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
