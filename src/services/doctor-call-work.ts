// 呼叫醫師的內部工具（index 不匯出、不會被包成 API）：首頁的待辦（值班醫師沒寫值班紀錄、緊急呼叫沒回覆）
import type { DoctorCall } from '@/types'
import { db } from '@/mock/db'
import { addMinutes } from '@/utils/date'
import { dutyDateOf, isOffHours } from './duty-rules'

/** 緊急呼叫幾分鐘沒回覆要再找 */
export const CALL_URGENT_MINUTES = 15
export const minutesBetween = (a: string, b: string) => Math.round((Date.parse(b.replace(' ', 'T')) - Date.parse(a.replace(' ', 'T'))) / 60000)

/** 「這一班」是哪天的值班：下班時間是現在這一班；白天是昨晚那一班 */
export const shiftDateOf = (t: string) => (isOffHours(t) ? dutyDateOf(t) : dutyDateOf(addMinutes(t, -9 * 60)))
/** 這筆呼叫之後，被呼叫的醫師有沒有幫那位病人寫值班紀錄 */
export const dutyNoteAfter = (c: DoctorCall) => ((doctorId) => db.progressNotes.some((n) => n.admissionId === c.admissionId && n.kind === 'duty' && n.doctorId === doctorId && n.at >= c.calledAt))(db.users.find((x) => x.id === c.toUserId)?.doctorId)

/** 這一班值班醫師被呼叫、回覆了，但之後沒幫那位病人寫值班紀錄的 */
export function callsWithoutNote(userId: string, t: string): DoctorCall[] {
  const from = `${shiftDateOf(t)} 00:00`
  return db.doctorCalls.filter((c) => c.toUserId === userId && c.toRole === 'oncall' && c.response && c.calledAt >= from && !dutyNoteAfter(c))
}

/** 某一天那一班、某一科：被呼叫的統計（呼叫時間在那一班的下班時間內、病人是這一科的、找的是值班醫師） */
export function shiftCallStats(date: string, deptId: string) {
  const list = db.doctorCalls.filter((c) => c.toRole === 'oncall' && isOffHours(c.calledAt) && dutyDateOf(c.calledAt) === date && db.admissions.find((a) => a.id === c.admissionId)?.deptId === deptId)
  const answered = list.filter((c) => c.response)
  return {
    calls: list.length,
    urgent: list.filter((c) => c.urgency === 'urgent').length,
    open: list.length - answered.length,
    ...(answered.length ? { avgWait: Math.round(answered.reduce((s, c) => s + minutesBetween(c.calledAt, c.response!.at), 0) / answered.length) } : {}),
    withoutNote: answered.filter((c) => !dutyNoteAfter(c)).length,
  }
}

/** 護理站：緊急呼叫超過 15 分鐘沒回覆（再找主治或上一級） */
export const overdueUrgentCalls = (t: string) => db.doctorCalls.filter((c) => c.urgency === 'urgent' && !c.response && !c.escalatedTo && !c.rrtId && minutesBetween(c.calledAt, t) >= CALL_URGENT_MINUTES)
