// 影像檢查排程（純函式）：檢查室、開放時段、排程檢查（不能排在過去、要在開放時段內）、同一間撞期、
// 檢查走到哪一步、和給藥時間衝突。檢查室排程、護理站、判讀清單、測試都用這一份
import type { ExamRoom, ImagingExam } from '@/types'
import { addMinutes } from '@/utils/date'
import { overlaps } from './surgery-rules'

export const EXAM_ROOMS: { id: ExamRoom; name: string }[] = [
  { id: 'XR', name: 'X 光室' },
  { id: 'CT', name: '電腦斷層室' },
  { id: 'US', name: '超音波室' },
  { id: 'ECG', name: '心電圖室' },
]
export const examRoomName = (r: ExamRoom) => EXAM_ROOMS.find((x) => x.id === r)?.name ?? r
/** 檢查室開放時段 */
export const EXAM_DAY = { start: '08:00', end: '17:00' }
/** 給藥時間在檢查前後多少分鐘內算「衝突」（病人可能不在病房） */
export const EXAM_MAR_MARGIN = 30

export type ExamStage = 'scheduled' | 'arrived' | 'done'
export const EXAM_STAGE_LABEL: Record<ExamStage, string> = { scheduled: '已排程', arrived: '已報到', done: '已完成' }
export const examStage = (e: Pick<ImagingExam, 'arrivedAt' | 'doneAt'>): ExamStage => (e.doneAt ? 'done' : e.arrivedAt ? 'arrived' : 'scheduled')

/** 排程時間檢查：不能在過去、要在開放時段內（結束時間也要在關門前） */
export function checkExamSlot(start: string | undefined, minutes: number, now: string): Record<string, string> {
  if (!start || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(start)) return { start: '請選日期與時間' }
  if (start < now) return { start: '不能排在過去' }
  const end = addMinutes(start, minutes)
  if (start.slice(11) < EXAM_DAY.start || end.slice(11) > EXAM_DAY.end || end.slice(0, 10) !== start.slice(0, 10)) return { start: `檢查室開放 ${EXAM_DAY.start}–${EXAM_DAY.end}` }
  return {}
}

/** 同一間檢查室撞期的那一筆（自己那筆不算） */
export const examClash = <T extends Pick<ImagingExam, 'id' | 'room' | 'start' | 'minutes'>>(exams: T[], x: { id?: string; room: ExamRoom; start: string; minutes: number }) =>
  exams.find((e) => e.id !== x.id && e.room === x.room && overlaps(e.start, e.minutes, x.start, x.minutes))

/** 檢查前後 30 分鐘內的給藥時間（還沒給的）：護理站提醒調整 */
export const marConflicts = (e: Pick<ImagingExam, 'start' | 'minutes'>, marTimes: string[]) =>
  marTimes.filter((t) => t >= addMinutes(e.start, -EXAM_MAR_MARGIN) && t <= addMinutes(e.start, e.minutes + EXAM_MAR_MARGIN)).sort()
