// 事前審查（純函式）：狀態、能不能用、審查逾時、填寫欄位。服務層（preauth.ts、nursing 給藥、implant 登記、申報檢核）、畫面、測試共用
import type { PreAuth, PreAuthStatus } from '@/types'
import { addDays, parseDate } from '@/utils/date'

/** 送審後幾天還沒結果算逾時（健保署約兩週） */
export const PREAUTH_DAYS = 14
export const PREAUTH_STATUS_LABEL: Record<PreAuthStatus, string> = { draft: '待醫師填寫', ready: '待送審', submitted: '審查中', more: '補件', approved: '核准', rejected: '不核准' }

/** 門診核准沒寫期限時，預設從核准日起有效幾天 */
export const OPD_PREAUTH_VALID_DAYS = 180

/** 門診核准的有效期限（YYYY-MM-DD）：審查結果寫的期限，沒寫＝核准日 + 180 天 */
export function opdPreAuthUntil(p: Pick<PreAuth, 'status' | 'result'>): string | undefined {
  if (p.status !== 'approved' || !p.result) return undefined
  return p.result.until ?? addDays(p.result.at.slice(0, 10), OPD_PREAUTH_VALID_DAYS)
}
/** 門診這天能不能健保開：核准而且在期限內 */
export const opdPreAuthValid = (p: Pick<PreAuth, 'status' | 'result'>, date: string): boolean => ((u) => !!u && date <= u)(opdPreAuthUntil(p))

/** 門診核准量還剩多少（沒寫核准量＝undefined 不限）：used＝效期內已經健保開的量 */
export const opdPreAuthLeft = (p: Pick<PreAuth, 'result'>, used: number): number | undefined => (p.result?.qty !== undefined ? Math.max(0, p.result.qty - used) : undefined)

/** 這次要開的量：慢箋算整張（每次調劑同量 × 可調劑次數） */
export const opdRxQty = (qty: number, refillTimes: number) => qty * (refillTimes >= 2 ? refillTimes : 1)

/** 門診擋下時的說明 */
export function opdPreAuthBlockText(drugName: string, p: Pick<PreAuth, 'no' | 'status' | 'result'> | undefined, date: string): string {
  const why = !p ? '還沒申請' : p.status === 'approved' && !opdPreAuthValid(p, date) ? `${p.no} 核准已過期（${opdPreAuthUntil(p)}）：請重新申請` : `${p.no} ${PREAUTH_STATUS_LABEL[p.status]}`
  return `${drugName} 需健保事前審查（門診，${why}）：核准前只能自費開立（勾「自費」），或先在處方旁申請送審`
}

/** 能不能用：核准、病人同意自費、醫師寫了緊急理由 */
export const preAuthAllows = (p: Pick<PreAuth, 'status' | 'selfPay' | 'emergency'>): boolean => p.status === 'approved' || !!p.selfPay || !!p.emergency

/** 送審幾天了；審查中超過 14 天＝逾時 */
export const preAuthDays = (p: Pick<PreAuth, 'submittedAt'>, now: string): number | undefined => (p.submittedAt ? Math.floor((parseDate(now).getTime() - parseDate(p.submittedAt).getTime()) / 86400000) : undefined)
export const preAuthOverdue = (p: Pick<PreAuth, 'status' | 'submittedAt'>, now: string): boolean => p.status === 'submitted' && (preAuthDays(p, now) ?? 0) > PREAUTH_DAYS

/** 不能用時的說明（給藥、登記植入物擋下時） */
export const preAuthBlockText = (p: Pick<PreAuth, 'no' | 'itemName' | 'status'>) =>
  `${p.itemName} 需健保事前審查（${p.no}，${PREAUTH_STATUS_LABEL[p.status]}）：核准前不能用；病人同意改自費、或醫師寫緊急理由後才能用`

export function checkPreAuthFill(input: { summary?: string; reason?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!input.summary?.trim()) e.summary = '請寫病情摘要（診斷、相關檢查結果）'
  if (!input.reason?.trim()) e.reason = '請寫使用理由（為什麼需要這個項目）'
  return e
}
