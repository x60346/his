// 疾病分類編碼審查的內部工具（index 不匯出、不會被包成 API）：逾時天數、首頁待辦。API 在 coding.ts
import { db } from '@/mock/db'
import { addDays } from '@/utils/date'

/** 出院超過幾天還沒審查標紅 */
export const CODING_DAYS = 7

/** 首頁：病歷管理師待審查、逾時；主治編碼修改未讀 */
export function codingCounts(t: string, doctorId?: string) {
  const xs = db.admissions.filter((a) => a.status === 'discharged' && a.dischargedAt && !a.coding)
  return {
    due: xs.length, overdue: xs.filter((a) => a.dischargedAt!.slice(0, 10) < addDays(t.slice(0, 10), -CODING_DAYS)).length,
    changed: doctorId ? db.admissions.filter((a) => a.doctorId === doctorId && a.coding?.changed && !a.coding.ack).length : 0,
  }
}
