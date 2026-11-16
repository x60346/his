// 預約回診的建議日期（純函式）：看診頁的快速選項與服務層共用。
//   - 一般：1 週、2 週、4 週後
//   - 慢性病連續處方箋：藥用完前 3 天回診（處方天數 × 可調劑次數 − 3）——早回來藥還沒吃完，晚回來會斷藥

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
