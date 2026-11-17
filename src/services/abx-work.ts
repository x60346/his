// 管制性抗生素的內部工具（index 不匯出）：誰是感染科、執行中的管制性抗生素醫囑、各種待辦（首頁、審核頁共用）
import type { Drug, IpdOrder } from '@/types'
import { db } from '@/mock/db'
import { now } from '@/utils/date'
import { ABX_REASON_LABEL, ABX_STATUS_LABEL, abxState, abxText } from './abx-rules'
import { nameOf } from './views'

/** 感染科醫師（科別代碼 INF）：審核管制性抗生素 */
export const isInfectious = (doctorId?: string) => {
  const d = doctorId ? db.doctors.find((x) => x.id === doctorId) : undefined
  return !!d && db.departments.find((x) => x.id === d.deptId)?.code === 'INF'
}

/** 抗生素（審核時列出病人目前所有的抗生素）：管制性的，或主檔作用寫抗生素的 */
export const isAntibiotic = (d?: Drug) => !!d && (!!d.restrictedAbx || d.indication.includes('抗生素'))

type AbxOrder = IpdOrder & { abx: NonNullable<IpdOrder['abx']> }
/** 住院中、執行中的管制性抗生素醫囑 */
export const activeAbxOrders = (): AbxOrder[] =>
  db.ipdOrders.filter((o): o is AbxOrder => !!o.abx && o.status === 'active' && db.admissions.find((a) => a.id === o.admissionId)?.status === 'admitted')

/** 感染科待審核（逾時的數量另算） */
export function abxPendingCounts(t: string): { pending: number; overdue: number } {
  const list = activeAbxOrders().filter((o) => o.abx.status === 'pending')
  return { pending: list.length, overdue: list.filter((o) => abxState(o.abx, t).overdue).length }
}

/** 主治要處理的：不核准（停藥、改藥或申覆）、核准天數快到或已超過（申請續用） */
export function abxAttendingTodo(doctorId: string, t: string): { rejected: AbxOrder[]; extend: AbxOrder[] } {
  const mine = activeAbxOrders().filter((o) => db.admissions.find((a) => a.id === o.admissionId)?.doctorId === doctorId)
  return { rejected: mine.filter((o) => o.abx.status === 'rejected'), extend: mine.filter((o) => !!abxState(o.abx, t).extend) }
}

export interface AbxInfo {
  /** 「使用第 3 天（核准至第 7 天）」 */
  text: string
  day: number
  statusLabel: string
  overdue: boolean
  extend?: 'soon' | 'over'
  reviewDueAt: string
  /** 「依培養結果（MRSA）・皮膚軟組織」 */
  reasonText: string
  steps: (NonNullable<IpdOrder['abx']>['steps'][number] & { byName: string })[]
}

export function abxInfoOf(abx: NonNullable<IpdOrder['abx']>, t: string = now()): AbxInfo {
  const s = abxState(abx, t)
  return {
    text: abxText(abx, t), day: s.day, statusLabel: ABX_STATUS_LABEL[abx.status], overdue: s.overdue, reviewDueAt: s.reviewDueAt, ...(s.extend ? { extend: s.extend } : {}),
    reasonText: `${ABX_REASON_LABEL[abx.reason]}${abx.organism ? `（${abx.organism}）` : ''}・${abx.site}`,
    steps: abx.steps.map((x) => ({ ...x, byName: nameOf.user(x.by) })),
  }
}
