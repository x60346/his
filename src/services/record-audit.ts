// 住院病歷完整性稽核：出院後病歷要在 14 天內完成（出院病摘簽署、手術紀錄、死亡證明書、會診回覆）。
// 主治看「我的病歷待完成」（逾期在前）；病歷室（權限「疾病分類」）看全院清單與每月準時完成率。規則在 record-audit-rules
import type { Admission } from '@/types'
import { db } from '@/mock/db'
import { today } from '@/utils/date'
import { query, requirePermission, requireUser } from './http'
import { recordCompletedAt, recordDue, recordGaps, recordOnTimeRate, recordOverdue } from './record-audit-rules'
import { discharged, progressGapsOf, recordInputOf } from './record-audit-work'
import { shiftMonth } from './management-rules'
import { find, nameOf } from './views'

export interface RecordItem {
  admissionId: string
  admitNo: string
  patientName: string
  chartNo: string
  doctorName: string
  deptName: string
  dischargedAt: string
  dischargeType: string
  due: string
  gaps: string[]
  overdue: boolean
  completedAt?: string
}
function item(a: Admission, t: string): RecordItem {
  const x = recordInputOf(a)
  return {
    admissionId: a.id, admitNo: a.admitNo, patientName: nameOf.patient(a.patientId), chartNo: find.patient(a.patientId)?.chartNo ?? '', doctorName: nameOf.doctor(a.doctorId), deptName: nameOf.dept(a.deptId),
    dischargedAt: a.dischargedAt ?? '', dischargeType: a.dischargeType ?? a.dischargeSummary?.dischargeType ?? '', due: recordDue(x.dischargedAt), gaps: recordGaps(x), overdue: recordOverdue(x, t),
    ...((c) => (c ? { completedAt: c } : {}))(recordCompletedAt(x)),
  }
}
const sortItems = (xs: RecordItem[]) => xs.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.dischargedAt.localeCompare(b.dischargedAt))

/** 主治：我主治的出院病人，病歷還沒完成的（逾期在前） */
export function myIncompleteRecords(): Promise<RecordItem[]> {
  return query(() => {
    const u = requireUser('doctor')
    const t = today()
    return sortItems(discharged().filter((a) => a.doctorId === u.doctorId).map((a) => item(a, t)).filter((x) => x.gaps.length))
  })
}

/** 主治：我主治的住院中病人，最近 7 天缺病程紀錄的日期 */
export function myMissingProgressNotes(): Promise<{ admissionId: string; admitNo: string; patientName: string; bedText: string; admittedAt: string; dates: string[] }[]> {
  return query(() => {
    const u = requireUser('doctor')
    const t = today()
    return db.admissions.filter((a) => a.doctorId === u.doctorId).map((a) => ({ a, dates: progressGapsOf(a, t) })).filter((x) => x.dates.length)
      .map(({ a, dates }) => ({ admissionId: a.id, admitNo: a.admitNo, patientName: nameOf.patient(a.patientId), bedText: a.bedId ? find.bed(a.bedId)?.bedNo ?? '' : '', admittedAt: a.admittedAt ?? '', dates }))
      .sort((x, y) => y.dates.length - x.dates.length)
  })
}

export interface RecordAudit {
  /** 還沒完成的（逾期在前） */
  incomplete: RecordItem[]
  /** 最近 6 個月：出院人數、已到期或已完成的、準時完成率 */
  months: { month: string; discharged: number; rate: number | null; incomplete: number }[]
  /** 各主治：還沒完成、逾期 */
  byDoctor: { doctorName: string; incomplete: number; overdue: number }[]
}
/** 病歷室：全院病歷完整性 */
export function recordAudit(): Promise<RecordAudit> {
  return query(() => {
    requirePermission('coding')
    const t = today()
    const all = discharged()
    const items = all.map((a) => item(a, t))
    const ms = Array.from({ length: 6 }, (_, i) => shiftMonth(t.slice(0, 7), -i))
    const docs = [...new Set(items.filter((x) => x.gaps.length).map((x) => x.doctorName))]
    return {
      incomplete: sortItems(items.filter((x) => x.gaps.length)),
      months: ms.map((m) => {
        const xs = all.filter((a) => a.dischargedAt!.startsWith(m))
        return { month: m, discharged: xs.length, rate: recordOnTimeRate(xs.map(recordInputOf), t), incomplete: xs.filter((a) => recordGaps(recordInputOf(a)).length).length }
      }),
      byDoctor: docs.map((d) => ({ doctorName: d, incomplete: items.filter((x) => x.doctorName === d && x.gaps.length).length, overdue: items.filter((x) => x.doctorName === d && x.overdue).length })).sort((a, b) => b.overdue - a.overdue || b.incomplete - a.incomplete),
    }
  })
}

