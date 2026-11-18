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

/** 過了排程時間多少分鐘還沒報到算「未到」 */
export const EXAM_NOSHOW_MIN = 30
/** 未到：沒取消、沒報到、已經過了排程時間 30 分鐘 */
export const examNoShow = (e: Pick<ImagingExam, 'start' | 'arrivedAt' | 'cancelled'>, now: string) => !e.cancelled && !e.arrivedAt && now > addMinutes(e.start, EXAM_NOSHOW_MIN)

/** 檢查前準備還沒完成的項目（沒確認、或確認「沒完成」的） */
export const examPrepMissing = (defs: { id: string; label: string }[] | undefined, prep: ImagingExam['prep']) => (defs ?? []).filter((d) => !prep?.[d.id]?.ok)

/**
 * 顯影劑與腎功能（CrCl，Cockcroft-Gault）：< 30 不能打（請開立醫師改無顯影檢查或取消）；30–45 可以打但要提醒水化；算不出要提醒先確認腎功能
 */
export function contrastCheck(crcl: number | null): { level: 'ok' | 'hydrate' | 'unknown' | 'block'; text: string } {
  if (crcl === null) return { level: 'unknown', text: 'CrCl 算不出（沒有 7 天內的肌酸酐或 30 天內的體重）：請先確認腎功能再打顯影劑' }
  if (crcl < 30) return { level: 'block', text: `CrCl ${crcl} ml/min（< 30）：不能打顯影劑，請開立醫師改無顯影的檢查或取消` }
  if (crcl < 45) return { level: 'hydrate', text: `CrCl ${crcl} ml/min（30–45）：可以打，檢查前後請水化（補充水分）` }
  return { level: 'ok', text: `CrCl ${crcl} ml/min：腎功能可以打顯影劑` }
}

/** 顯影劑過敏：病人過敏紀錄裡有顯影劑、碘（含英文）→ 回傳那一筆 */
export const contrastAllergy = (allergies: string[] | undefined) => (allergies ?? []).find((a) => /顯影劑|碘|contrast|iodin/i.test(a))

/** Metformin：打顯影劑後暫停幾小時（腎功能不好時乳酸中毒風險） */
export const METFORMIN_HOLD_HOURS = 48
/** 要不要暫停 Metformin：CrCl < 45 或算不出 */
export const metforminAtRisk = (crcl: number | null) => crcl === null || crcl < 45
export const metforminText = (crcl: number | null) => `病人有在用 Metformin${crcl === null ? '、CrCl 算不出' : `、CrCl ${crcl}`}：打顯影劑後暫停 ${METFORMIN_HOLD_HOURS} 小時，複查腎功能正常再恢復`

/** 顯影劑水化建議：生理食鹽水 1 mL/kg/hr（檢查前後），一袋 500 mL */
export const HYDRATION = { mlPerKgH: 1, volumeMl: 500 }
export const hydrationRate = (weightKg: number) => Math.max(1, Math.round(weightKg * HYDRATION.mlPerKgH))
