// 放射師排班（純函式）：哪幾間要放射師（一般攝影、電腦斷層、磁振造影；超音波由醫師做、心電圖由技術員做）、
// 一天分上午、下午兩段；一筆檢查碰到哪幾段、哪幾段沒排人。服務層（rad-roster.ts、exam.ts）、畫面、種子、測試共用
import type { ExamRoom, RadShift } from '@/types'

export const RAD_ROOMS: ExamRoom[] = ['XR', 'CT', 'MR']
export const RAD_BLOCKS: { key: RadShift['block']; label: string; start: string; end: string }[] = [
  { key: 'am', label: '上午', start: '08:00', end: '12:30' },
  { key: 'pm', label: '下午', start: '12:30', end: '17:00' },
]
export const radBlockLabel = (b: RadShift['block']) => RAD_BLOCKS.find((x) => x.key === b)!.label

const hm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
/** 一筆檢查（開始時間 YYYY-MM-DD HH:mm、幾分鐘）碰到的班段（08:00–17:00 以外的不算，開放時段另外管） */
export function blocksOf(start: string, minutes: number): RadShift['block'][] {
  const s = hm(start.slice(11, 16))
  const e = s + minutes
  return RAD_BLOCKS.filter((b) => s < hm(b.end) && e > hm(b.start)).map((b) => b.key)
}
/** 這筆檢查哪幾段沒有放射師（不需要放射師的檢查室回空陣列） */
export function staffMissing(shifts: Pick<RadShift, 'date' | 'room' | 'block'>[], room: ExamRoom, start: string, minutes: number): RadShift['block'][] {
  if (!RAD_ROOMS.includes(room)) return []
  const date = start.slice(0, 10)
  return blocksOf(start, minutes).filter((b) => !shifts.some((s) => s.date === date && s.room === room && s.block === b))
}
/** 現在這個時間是哪一段（08:00–17:00 以外回 undefined：值班時間不查排班） */
export const blockNow = (t: string): RadShift['block'] | undefined => blocksOf(t.slice(0, 16), 1)[0]

export const staffMissingText = (blocks: RadShift['block'][]) => (blocks.length ? `${blocks.map(radBlockLabel).join('、')}沒有排放射師` : '')
