// 門診候診順序（純函式）：看診頁的「下一位」與測試共用。
import type { Visit } from '@/types'

type QueueItem = Pick<Visit, 'id' | 'seqNo' | 'status' | 'skippedAt'>

/**
 * 下一位：先叫「沒有過號」的候診者（號碼小的先）；只剩過號的人時，才從過號者裡挑號碼最小的，讓這一診能看完。
 * 以前過號只是退回候診，「下一位」取最小號——過號的人下一輪又被排成下一位，醫師一直叫到不在場的人。
 * 過號的人回來時，醫師直接在清單上點他叫號即可（多數診所是「過號請洽櫃台」，回來再叫）。
 *
 * queue 必須已依看診順序排好（服務層 listQueue：上午診在前，同診依號碼）。這裡不重新依號碼排序——
 * 號碼只在同一診內有意義，上午 5 號要排在下午 1 號前面；曾經依 seqNo 重排，結果上午過號後跳去叫下午 1 號。
 */
export function nextInQueue<T extends QueueItem>(queue: T[], currentId?: string): T | undefined {
  const waiting = queue.filter((v) => v.status === 'registered' && v.id !== currentId)
  return waiting.find((v) => !v.skippedAt) ?? waiting[0]
}
