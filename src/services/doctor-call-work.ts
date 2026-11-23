// 呼叫醫師的內部工具（index 不匯出、不會被包成 API）：首頁的待辦（值班醫師沒寫值班紀錄、緊急呼叫沒回覆）
import type { DoctorCall } from '@/types'
import { db } from '@/mock/db'
import { addMinutes } from '@/utils/date'
import { dutyDateOf, isOffHours } from './duty-rules'

/** 緊急呼叫幾分鐘沒回覆要再找 */
export const CALL_URGENT_MINUTES = 15
export const minutesBetween = (a: string, b: string) => Math.round((Date.parse(b.replace(' ', 'T')) - Date.parse(a.replace(' ', 'T'))) / 60000)

/** 這一班（下班時間是現在這一班；白天是昨晚那一班）值班醫師被呼叫、回覆了，但之後沒幫那位病人寫值班紀錄的 */
export function callsWithoutNote(userId: string, t: string): DoctorCall[] {
  const date = isOffHours(t) ? dutyDateOf(t) : dutyDateOf(addMinutes(t, -9 * 60))
  const from = `${date} 00:00`
  const u = db.users.find((x) => x.id === userId)
  return db.doctorCalls.filter((c) => c.toUserId === userId && c.toRole === 'oncall' && c.response && c.calledAt >= from
    && !db.progressNotes.some((n) => n.admissionId === c.admissionId && n.kind === 'duty' && n.doctorId === u?.doctorId && n.at >= c.calledAt))
}

/** 護理站：緊急呼叫超過 15 分鐘沒回覆（再找主治或上一級） */
export const overdueUrgentCalls = (t: string) => db.doctorCalls.filter((c) => c.urgency === 'urgent' && !c.response && minutesBetween(c.calledAt, t) >= CALL_URGENT_MINUTES)
