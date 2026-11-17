// 管制性抗生素（純函式）：使用理由、感染部位、療程第幾天、48 小時審核期限、核准天數快到的提醒、怎麼顯示。
// 開立（服務層把關）、醫囑列與給藥列的標記、感染科審核頁、首頁待辦都用這一份
import type { AbxReason, AbxRequest } from '@/types'
import { addMinutes, diffDays } from '@/utils/date'

export const ABX_REASON_LABEL: Record<AbxReason, string> = { empiric: '經驗性治療', culture: '依培養結果', prophylaxis: '手術預防' }
export const ABX_SITES = ['肺部', '泌尿道', '皮膚軟組織', '腹腔', '血流', '中樞神經', '骨關節', '手術部位', '不明']
/** 開立（或申覆、續用申請）後多久內要審 */
export const ABX_REVIEW_HOURS = 48
/** 核准天數：預設 7 天，最多 28 天（之後再申請續用） */
export const ABX_DEFAULT_DAYS = 7
export const ABX_MAX_DAYS = 28
export const ABX_STATUS_LABEL: Record<AbxRequest['status'], string> = { pending: '待感染科審核', approved: '已核准', rejected: '審核未通過' }

/** 開立時的申請欄位檢查（欄位 key 對應畫面：abxReason、abxSite、abxOrganism） */
export function checkAbxInput(x: { reason?: string; site?: string; organism?: string } | undefined): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x?.reason || !(x.reason in ABX_REASON_LABEL)) e.abxReason = '管制性抗生素：請選擇使用理由'
  if (!x?.site?.trim()) e.abxSite = '請填感染部位'
  if (x?.reason === 'culture' && !x.organism?.trim()) e.abxOrganism = '依培養結果：請寫菌種（例：MRSA、ESBL 大腸桿菌）'
  return e
}

/** 療程第幾天：開始那天是第 1 天 */
export const abxDay = (courseStart: string, now: string) => diffDays(courseStart.slice(0, 10), now.slice(0, 10)) + 1

export interface AbxState {
  day: number
  /** 審核期限（送審後 48 小時）——只有待審核的有意義 */
  reviewDueAt: string
  /** 待審核超過 48 小時 */
  overdue: boolean
  /** 核准天數：soon 最後一天或前一天（該申請續用了）、over 已超過還沒申請 */
  extend?: 'soon' | 'over'
}

export function abxState(abx: Pick<AbxRequest, 'courseStart' | 'status' | 'requestedAt' | 'approvedDays'>, now: string): AbxState {
  const day = abxDay(abx.courseStart, now)
  const reviewDueAt = addMinutes(abx.requestedAt, ABX_REVIEW_HOURS * 60)
  const extend = abx.status === 'approved' && abx.approvedDays ? (day > abx.approvedDays ? 'over' : day >= abx.approvedDays - 1 ? 'soon' : undefined) : undefined
  return { day, reviewDueAt, overdue: abx.status === 'pending' && now > reviewDueAt, ...(extend ? { extend } : {}) }
}

/** 醫囑列、給藥列上的一句話：「使用第 3 天（核准至第 7 天）」「使用第 2 天・待感染科審核（逾時）」 */
export function abxText(abx: Pick<AbxRequest, 'courseStart' | 'status' | 'requestedAt' | 'approvedDays'>, now: string): string {
  const s = abxState(abx, now)
  const tail =
    abx.status === 'approved' ? `（核准至第 ${abx.approvedDays} 天${s.extend === 'over' ? '，已超過' : ''}）`
    : abx.status === 'rejected' ? '・審核未通過'
    : `・待感染科審核${s.overdue ? '（逾時）' : ''}${abx.approvedDays ? `（續用申請；原核准至第 ${abx.approvedDays} 天）` : ''}`
  return `使用第 ${s.day} 天${tail}`
}
