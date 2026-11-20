// 經營月報（純函式）：月份的期間、前後月份、指標清單與單位、和比較月份的增減。服務層、畫面、Excel 匯出共用
import { addDays } from '@/utils/date'

/** 病例組合指數（CMI）：DRG 案件的平均相對權重（兩位小數）；沒有 DRG 案件＝null */
export const cmiOf = (weights: number[]): number | null => (weights.length ? Math.round((weights.reduce((a, b) => a + b, 0) / weights.length) * 100) / 100 : null)

/** 某月的期間：月初到月底（本月只到今天，partial） */
export function monthRange(month: string, today: string): { from: string; to: string; partial: boolean } {
  const from = `${month}-01`
  const end = addDays(`${shiftMonth(month, 1)}-01`, -1)
  return end > today ? { from, to: today, partial: true } : { from, to: end, partial: false }
}

/** 往前（負數）或往後 n 個月：2026-01 往前 1 個月是 2025-12 */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  const k = y * 12 + (m - 1) + n
  return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`
}

export type MgmtKey =
  | 'opdVisits' | 'opdFirst' | 'opdRevisit' | 'admissions' | 'discharges' | 'patientDays' | 'occupancy' | 'alos' | 'abxDdd' | 'cmi'
  | 'collected' | 'revenueOpd' | 'revenueIpd' | 'revenueOther' | 'nhiPoints' | 'drugShare' | 'labReports' | 'imagingReports' | 'prescriptions'

/** 指標：名稱、單位、分組（畫面與 Excel 摘要依這個順序） */
export const MGMT_KPIS: { key: MgmtKey; label: string; unit: string; group: '門診' | '住院' | '收入' | '醫療服務量' }[] = [
  { key: 'opdVisits', label: '門診人次', unit: '人次', group: '門診' },
  { key: 'opdFirst', label: '初診', unit: '人次', group: '門診' },
  { key: 'opdRevisit', label: '複診', unit: '人次', group: '門診' },
  { key: 'admissions', label: '入院人數', unit: '人', group: '住院' },
  { key: 'discharges', label: '出院人數', unit: '人', group: '住院' },
  { key: 'patientDays', label: '住院人日', unit: '人日', group: '住院' },
  { key: 'occupancy', label: '佔床率', unit: '%', group: '住院' },
  { key: 'alos', label: '平均住院天數', unit: '天', group: '住院' },
  { key: 'abxDdd', label: '抗生素用量', unit: 'DDD/千人日', group: '住院' },
  { key: 'cmi', label: '病例組合指數（CMI）', unit: 'RW', group: '住院' },
  { key: 'collected', label: '實收（日結）', unit: '元', group: '收入' },
  { key: 'revenueOpd', label: '門診收入（應收）', unit: '元', group: '收入' },
  { key: 'revenueIpd', label: '住院收入（應收）', unit: '元', group: '收入' },
  { key: 'revenueOther', label: '其他收入（病歷影本）', unit: '元', group: '收入' },
  { key: 'nhiPoints', label: '健保申報點數', unit: '點', group: '收入' },
  { key: 'drugShare', label: '藥費占比（申報點數）', unit: '%', group: '收入' },
  { key: 'prescriptions', label: '門診處方', unit: '張', group: '醫療服務量' },
  { key: 'labReports', label: '檢驗報告', unit: '份', group: '醫療服務量' },
  { key: 'imagingReports', label: '影像報告', unit: '份', group: '醫療服務量' },
]

/** 數值顯示：沒有資料「—」；百分比、天數一位小數；其他千分位 */
export function mgmtValueText(v: number | null | undefined, unit: string): string {
  if (v === null || v === undefined) return '—'
  if (unit === '%') return `${v.toFixed(1)}%`
  if (unit === '天' || unit === 'DDD/千人日') return v.toFixed(1)
  // 病例組合指數：平均相對權重，兩位小數
  if (unit === 'RW') return v.toFixed(2)
  return v.toLocaleString()
}

/**
 * 和比較月份的增減：任一邊沒有資料「—」；百分比類（佔床率、藥費占比）用「百分點」；其他用 %（比較月份是 0 時只寫差多少）
 */
export function mgmtChangeText(cur: number | null | undefined, base: number | null | undefined, unit: string): string {
  if (cur === null || cur === undefined || base === null || base === undefined) return '—'
  const d = cur - base
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±'
  if (unit === '%') return `${sign}${Math.abs(d).toFixed(1)} 百分點`
  if (unit === 'RW') return `${sign}${Math.abs(d).toFixed(2)}`
  if (base === 0) return d === 0 ? '±0' : `${sign}${Math.abs(d).toLocaleString()}`
  return `${sign}${Math.abs((d / base) * 100).toFixed(1)}%`
}
