// 日期工具：全系統以本地時間字串 YYYY-MM-DD / YYYY-MM-DD HH:mm 傳遞日期，避免時區問題。

const pad = (n: number) => String(n).padStart(2, '0')

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function toDateTimeStr(d: Date): string {
  return `${toDateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function today(): string {
  return toDateStr(new Date())
}

export function now(): string {
  return toDateTimeStr(new Date())
}

/** 解析 YYYY-MM-DD 或 YYYY-MM-DD HH:mm 為本地 Date */
export function parseDate(s: string): Date {
  const [datePart, timePart] = s.split(' ')
  const [y, m, d] = datePart.split('-').map(Number)
  const [hh, mm] = (timePart ?? '00:00').split(':').map(Number)
  return new Date(y, m - 1, d, hh, mm)
}

export function addDays(s: string, days: number): string {
  const d = parseDate(s)
  d.setDate(d.getDate() + days)
  return toDateStr(d)
}

export function diffDays(from: string, to: string): number {
  const ms = parseDate(to.slice(0, 10)).getTime() - parseDate(from.slice(0, 10)).getTime()
  return Math.round(ms / 86400000)
}

/** 足歲 */
export function ageOf(birthDate: string, at: string = today()): number {
  const b = parseDate(birthDate)
  const a = parseDate(at)
  let age = a.getFullYear() - b.getFullYear()
  if (a.getMonth() < b.getMonth() || (a.getMonth() === b.getMonth() && a.getDate() < b.getDate())) age--
  return age
}

/** 顯示用年齡：未滿 1 歲顯示月數 */
export function ageText(birthDate: string, at: string = today()): string {
  const age = ageOf(birthDate, at)
  if (age >= 1) return `${age} 歲`
  const b = parseDate(birthDate)
  const a = parseDate(at)
  let months = (a.getFullYear() - b.getFullYear()) * 12 + a.getMonth() - b.getMonth()
  if (a.getDate() < b.getDate()) months--
  return `${Math.max(0, months)} 個月`
}

/** 民國年日期，例：113/05/02 */
export function toRoc(s: string): string {
  if (!s) return ''
  const [y, m, d] = s.slice(0, 10).split('-')
  const rest = s.length > 10 ? ` ${s.slice(11, 16)}` : ''
  return `${Number(y) - 1911}/${m}/${d}${rest}`
}

export const periodLabel: Record<string, string> = { AM: '上午診', PM: '下午診', NIGHT: '夜診' }

/** 依目前時間推算當下診別 */
export function currentPeriod(): 'AM' | 'PM' | 'NIGHT' {
  const h = new Date().getHours()
  if (h < 12) return 'AM'
  if (h < 17) return 'PM'
  return 'NIGHT'
}

export function weekdayLabel(s: string): string {
  return ['日', '一', '二', '三', '四', '五', '六'][parseDate(s).getDay()]
}

/** YYYY-MM-DD HH:mm 加減分鐘 */
export function addMinutes(s: string, minutes: number): string {
  return toDateTimeStr(new Date(parseDate(s).getTime() + minutes * 60000))
}

/**
 * 加 N 年（同月同日）。2/29 加到非閏年時落在 3/1——「滿 N 年」的那天，2/28 還不算滿。
 * 不用「N × 365 天」：遇到閏年會差一天，資格判斷的邊界就錯了。
 */
export function addYears(s: string, years: number): string {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number)
  return toDateStr(new Date(y + years, m - 1, d))
}
