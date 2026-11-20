// 事前審查（純函式）：狀態、能不能用、審查逾時、填寫欄位。服務層（preauth.ts、nursing 給藥、implant 登記、申報檢核）、畫面、測試共用
import type { PreAuth, PreAuthStatus } from '@/types'
import { parseDate } from '@/utils/date'

/** 送審後幾天還沒結果算逾時（健保署約兩週） */
export const PREAUTH_DAYS = 14
export const PREAUTH_STATUS_LABEL: Record<PreAuthStatus, string> = { draft: '待醫師填寫', ready: '待送審', submitted: '審查中', more: '補件', approved: '核准', rejected: '不核准' }

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
