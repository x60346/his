// 放射師排班的內部工具（index 不匯出、不會被包成 API）：已排的檢查哪些沒有放射師（排程看板、首頁）
import type { ImagingExam } from '@/types'
import { db } from '@/mock/db'
import { addDays } from '@/utils/date'
import { examRoomName } from './exam-rules'
import { staffMissing, staffMissingText } from './rad-roster-rules'
import { nameOf } from './views'

export const examStaffMissing = (e: Pick<ImagingExam, 'room' | 'start' | 'minutes'>) => staffMissingText(staffMissing(db.radShifts, e.room, e.start, e.minutes))

/** 現在到 14 天內、已排、還沒報到、時段沒有放射師的檢查 */
export function radUnstaffedExams(t: string) {
  const until = `${addDays(t.slice(0, 10), 14)} 23:59`
  return db.imagingExams
    .filter((e) => !e.cancelled && !e.arrivedAt && e.start >= t.slice(0, 16) && e.start <= until && examStaffMissing(e))
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((e) => ({ id: e.id, patientName: nameOf.patient(e.patientId), roomName: examRoomName(e.room), start: e.start, missing: examStaffMissing(e) }))
}
