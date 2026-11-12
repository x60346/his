// 門診候診順序（純函式）：看診頁的「下一位」與測試共用。
import type { Visit } from '@/types'

type QueueItem = Pick<Visit, 'id' | 'seqNo' | 'status' | 'skippedAt' | 'checkedInAt'>

/**
 * 這一診「目前看到幾號」：
 *   有人在看診 → 看診中的那一號（同時有兩位時取最後叫號的，那是「現在」正在做的事）
 *   沒有 → 已看完的最大號，標為「已看到」——櫃台說的「看到幾號」是進度，不是最後叫了誰：
 *          過號的 2 號在 5 號之後才回來看，進度仍是「已看到 5 號」
 * 還沒看過任何人就沒有。掛號櫃台被問「現在看到幾號」時，看診次卡就答得出來。
 */
export function currentNumber(visits: Pick<Visit, 'seqNo' | 'status' | 'calledAt'>[]): { seqNo: number; inConsult: boolean } | undefined {
  const inConsult = visits.filter((v) => v.status === 'in-consult').sort((a, b) => (a.calledAt ?? '').localeCompare(b.calledAt ?? '') || a.seqNo - b.seqNo).pop()
  if (inConsult) return { seqNo: inConsult.seqNo, inConsult: true }
  const seen = visits.filter((v) => ['consulted', 'charged', 'dispensed'].includes(v.status)).map((v) => v.seqNo)
  return seen.length ? { seqNo: Math.max(...seen), inConsult: false } : undefined
}

/**
 * 能不能報到（服務層 checkIn 擋下時的原因；清單上的「報到」按鈕用 VisitView.canCheckIn，同一條規則）。
 * 回傳 undefined 表示可以報到。
 */
export function checkInProblem(v: Pick<Visit, 'status' | 'date' | 'refillOf' | 'checkedInAt'>, today: string): { message: string } | undefined {
  if (v.refillOf) return { message: '慢箋領藥不需看診，不必報到' }
  if (v.status !== 'registered') return { message: '只有候診中的掛號可以報到' }
  if (v.date !== today) return { message: `這是 ${v.date} 的掛號，當天到院才能報到` }
  if (v.checkedInAt) return { message: `已於 ${v.checkedInAt.slice(11)} 報到` }
  return undefined
}

/**
 * 下一位：先叫「已報到、沒有過號」的候診者（號碼小的先）；再來是還沒報到的（醫師叫號時會再確認一次）；
 * 都沒有才輪到過號的。預約 1 號還沒到，就先看已經在等的 2 號——以前只看號碼，醫師一直叫到不在場的人。
 *
 * 過號的部分：先叫「沒有過號」的候診者（號碼小的先）；只剩過號的人時，才從過號者裡挑號碼最小的，讓這一診能看完。
 * 以前過號只是退回候診，「下一位」取最小號——過號的人下一輪又被排成下一位，醫師一直叫到不在場的人。
 * 過號的人回來時，醫師直接在清單上點他叫號即可（多數診所是「過號請洽櫃台」，回來再叫）。
 *
 * queue 必須已依看診順序排好（服務層 listQueue：上午診在前，同診依號碼）。這裡不重新依號碼排序——
 * 號碼只在同一診內有意義，上午 5 號要排在下午 1 號前面；曾經依 seqNo 重排，結果上午過號後跳去叫下午 1 號。
 */
export function nextInQueue<T extends QueueItem>(queue: T[], currentId?: string): T | undefined {
  const waiting = queue.filter((v) => v.status === 'registered' && v.id !== currentId)
  return waiting.find((v) => v.checkedInAt && !v.skippedAt) ?? waiting.find((v) => !v.skippedAt) ?? waiting[0]
}
