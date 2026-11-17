// 預約回診的建議日期、預約未到、出院後回診的規則（純函式）：畫面與服務層共用。
//   - 一般：1 週、2 週、4 週後
//   - 慢性病連續處方箋：藥用完前 3 天回診（處方天數 × 可調劑次數 − 3）——早回來藥還沒吃完，晚回來會斷藥

import type { NoShowResult, Visit } from '@/types'
import { addDays } from '@/utils/date'

export const FOLLOW_UP_PICKS = [
  { label: '1 週後', days: 7 },
  { label: '2 週後', days: 14 },
  { label: '4 週後', days: 28 },
] as const

/** 建議回診找診次時，從目標日往後找幾天內的診次 */
export const FOLLOW_UP_SEARCH_DAYS = 7

/** 慢性病連續處方箋：幾天後回診（沒有連續處方回傳 undefined） */
export function refillFollowUpDays(maxRxDays: number, refillTimes: number): number | undefined {
  if (refillTimes < 2 || maxRxDays <= 0) return undefined
  return Math.max(1, maxRxDays * refillTimes - 3)
}

// ---------- 預約未到 ----------

/** 未到追蹤清單看最近幾天（就醫日） */
export const NO_SHOW_TRACK_DAYS = 14

/** 預約未到：就醫日已過（今天的不算，下午還可能來）、還是已掛號（沒報到、沒看診、沒退掛）。慢箋領藥登記不算 */
/** 急診沒等到看診就走了不算「預約未到」（不是預約） */
export const isNoShow = (v: Pick<Visit, 'status' | 'date' | 'refillOf' | 'er'>, today: string) => v.status === 'registered' && v.date < today && !v.refillOf && !v.er

/** 未到的類別（排序依這個）：出院後回診 > 醫師約的回診 > 慢性病 > 一般 */
export type NoShowKind = 'afterDischarge' | 'followUp' | 'chronic' | 'normal'
export const NO_SHOW_KIND_LABEL: Record<NoShowKind, string> = { afterDischarge: '出院後回診', followUp: '醫師約的回診', chronic: '慢性病', normal: '一般預約' }
export const noShowKind = (v: Pick<Visit, 'afterDischarge' | 'followUpOf' | 'caseType'>): NoShowKind =>
  v.afterDischarge ? 'afterDischarge' : v.followUpOf ? 'followUp' : v.caseType === '04' ? 'chronic' : 'normal'
/** 臨床上要追的（首頁待辦只算這些）：病人自己掛、沒來的，列在清單但不催 */
export const isImportantNoShow = (v: Pick<Visit, 'afterDischarge' | 'followUpOf' | 'caseType'>) => noShowKind(v) !== 'normal'

export const NO_SHOW_RESULT_LABEL: Record<NoShowResult, string> = { rebooked: '已改約', declined: '病人不需要', unreachable: '聯絡不到' }
/** 結案：最後一筆聯絡是「已改約」或「病人不需要」 */
export const noShowClosed = (v: Pick<Visit, 'noShow'>) => {
  const last = v.noShow?.contacts.at(-1)
  return !!last && last.result !== 'unreachable'
}

// ---------- 出院後回診 ----------

/** 出院後幾天內的回診，基本部分負擔比照經轉診（含出院當天起算的第 30 天） */
export const AFTER_DISCHARGE_COPAY_DAYS = 30

/**
 * 出院後回診收經轉診的基本部分負擔：醫師出院時約的（afterDischarge）、看診日在出院後 30 天內、
 * 而且是這次住院「第一次實際就醫」的回診（更早的出院回診已經看過診就不算；沒來的不算）。
 * dischargedOn：出院日（還沒出院就是 undefined——預估時以今天出院估）
 */
export function afterDischargeCopayEligible(v: Pick<Visit, 'afterDischarge' | 'date'>, dischargedOn: string | undefined, earlierSeen: boolean): boolean {
  if (!v.afterDischarge || !dischargedOn || earlierSeen) return false
  return v.date >= dischargedOn && v.date <= addDays(dischargedOn, AFTER_DISCHARGE_COPAY_DAYS)
}
