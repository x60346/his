// 影像檢查排程（純函式）：檢查室、開放時段、排程檢查（不能排在過去、要在開放時段內）、同一間撞期、
// 檢查走到哪一步、和給藥時間衝突。檢查室排程、護理站、判讀清單、測試都用這一份
import type { ExamRoom, ImagingExam, RoomDowntime } from '@/types'
import { addMinutes, parseDate, toDateTimeStr } from '@/utils/date'
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

// ── 放射師完成含顯影劑的檢查：記用量；有不良反應記嚴重度、症狀、處置（中度以上自動產生不良反應通報給藥師評估） ──

/** 顯影劑用量合理範圍（mL） */
export const CONTRAST_ML = { min: 1, max: 200 }
/** 顯影劑不良反應通報的懷疑物（不在藥品主檔）；藥師評估後加入過敏的就是這個字（過敏檢查認得「顯影劑」） */
export const CONTRAST_AGENT = '碘化顯影劑'
export type ContrastReactionSeverity = 'mild' | 'moderate' | 'severe'
export const CONTRAST_REACTION_LABEL: Record<ContrastReactionSeverity, string> = { mild: '輕度（局部蕁麻疹、噁心，觀察即緩解）', moderate: '中度（全身蕁麻疹、喘鳴，需要給藥）', severe: '重度（血壓下降、呼吸困難，需急救）' }
/** 中度以上自動通報 */
export const contrastReactionReportable = (s: ContrastReactionSeverity) => s !== 'mild'

/** 完成時的欄位：含顯影劑要有用量；有反應的話嚴重度、症狀、處置都要寫；不含顯影劑不能記顯影劑的東西 */
export function checkContrastDone(x: { contrastMl?: number; reaction?: { severity?: string; symptoms?: string; action?: string } }, isContrast: boolean): Record<string, string> {
  const e: Record<string, string> = {}
  if (!isContrast) {
    if (x.contrastMl !== undefined || x.reaction) e.contrastMl = '這項檢查不含顯影劑'
    return e
  }
  const ml = Number(x.contrastMl)
  if (x.contrastMl === undefined || !Number.isFinite(ml) || ml < CONTRAST_ML.min || ml > CONTRAST_ML.max) e.contrastMl = `請寫顯影劑用量（${CONTRAST_ML.min}–${CONTRAST_ML.max} mL）`
  if (x.reaction) {
    if (!x.reaction.severity || !(x.reaction.severity in CONTRAST_REACTION_LABEL)) e.severity = '請選反應嚴重度'
    if (!x.reaction.symptoms?.trim()) e.symptoms = '請寫症狀（例：前胸蕁麻疹）'
    if (!x.reaction.action?.trim()) e.action = '請寫處置（例：觀察 30 分鐘緩解、給抗組織胺）'
  }
  return e
}

// ── 檢查室設備停機：故障或保養的時段排不進去、不能報到；已排的列「需改期」，可以一鍵排到下一個空檔 ──

export type DowntimeReason = 'breakdown' | 'maintenance'
export const DOWNTIME_REASON_LABEL: Record<DowntimeReason, string> = { breakdown: '故障', maintenance: '保養' }
type DT = Pick<RoomDowntime, 'room' | 'from' | 'to' | 'endedAt'>
/** 實際結束時間（提早結束的用結束時間） */
export const downtimeEnd = (d: Pick<RoomDowntime, 'to' | 'endedAt'>) => (d.endedAt && d.endedAt < d.to ? d.endedAt : d.to)
const dtMinutes = (d: DT) => Math.max(0, Math.round((parseDate(downtimeEnd(d)).getTime() - parseDate(d.from).getTime()) / 60000))
/** 這個時段碰到哪一段停機（同一間） */
export const downtimeClash = <T extends DT>(ds: T[], x: { room: ExamRoom; start: string; minutes: number }) =>
  ds.find((d) => d.room === x.room && dtMinutes(d) > 0 && overlaps(d.from, dtMinutes(d), x.start, x.minutes))
/** 現在停機中的 */
export const downtimeNow = <T extends DT>(ds: T[], room: ExamRoom, now: string) => ds.find((d) => d.room === room && d.from <= now && now < downtimeEnd(d))
export const downtimeText = (d: Pick<RoomDowntime, 'from' | 'to' | 'endedAt' | 'reason'>) =>
  `${DOWNTIME_REASON_LABEL[d.reason]} ${d.from.slice(5)}–${downtimeEnd(d).slice(d.from.slice(0, 10) === downtimeEnd(d).slice(0, 10) ? 11 : 5)}`

/** 登記欄位：檢查室、起訖（結束要在開始之後、不能整段在過去、最長 7 天）、原因 */
export function checkDowntime(x: { room?: string; from?: string; to?: string; reason?: string }, now: string): Record<string, string> {
  const e: Record<string, string> = {}
  const re = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
  if (!EXAM_ROOMS.some((r) => r.id === x.room)) e.room = '請選檢查室'
  if (!x.from || !re.test(x.from)) e.from = '請選開始時間'
  if (!x.to || !re.test(x.to)) e.to = '請選結束時間'
  else if (x.from && x.to <= x.from) e.to = '結束要在開始之後'
  else if (x.to <= now) e.to = '整段都在過去，不用登記'
  else if (x.from && parseDate(x.to).getTime() - parseDate(x.from).getTime() > 7 * 24 * 3600000) e.to = '一次最長 7 天'
  if (x.reason !== 'breakdown' && x.reason !== 'maintenance') e.reason = '請選原因（故障、保養）'
  return e
}

/**
 * 下一個空檔：after 之後（10 分鐘為一格、開放時段內），同一間沒撞期、沒停機的第一個時段；最多找 14 天
 */
export function nextFreeSlot(room: ExamRoom, minutes: number, after: string, exams: Pick<ImagingExam, 'id' | 'room' | 'start' | 'minutes'>[], downtimes: DT[], selfId?: string): string | undefined {
  const t0 = parseDate(after)
  t0.setSeconds(0, 0)
  const m = t0.getMinutes()
  if (m % 10) t0.setMinutes(m + (10 - (m % 10)))
  let t = toDateTimeStr(t0)
  for (let i = 0; i < 14 * 24 * 6; i++, t = addMinutes(t, 10)) {
    const end = addMinutes(t, minutes)
    if (t.slice(11) < EXAM_DAY.start || end.slice(11) > EXAM_DAY.end || end.slice(0, 10) !== t.slice(0, 10)) continue
    if (examClash(exams, { id: selfId, room, start: t, minutes }) || downtimeClash(downtimes, { room, start: t, minutes })) continue
    return t
  }
  return undefined
}

/** 停機時數（since 之後，各檢查室；分鐘→小時一位小數） */
export function downtimeHours(ds: DT[], since: string, now: string): { room: ExamRoom; name: string; hours: number; count: number }[] {
  return EXAM_ROOMS.map((r) => {
    const xs = ds.filter((d) => d.room === r.id && downtimeEnd(d) > since && d.from < now)
    const min = xs.reduce((a, d) => {
      const s = d.from < since ? since : d.from
      const e = downtimeEnd(d) > now ? now : downtimeEnd(d)
      return a + Math.max(0, (parseDate(e).getTime() - parseDate(s).getTime()) / 60000)
    }, 0)
    return { room: r.id, name: r.name, hours: Math.round(min / 6) / 10, count: xs.length }
  })
}
