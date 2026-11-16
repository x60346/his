// 轉診（純函式）：轉入轉診單的有效期、轉出轉診單的選項——掛號、批價、看診頁、測試共用這一份。
// 健保規則的簡化版：
//   - 轉診單從開單日起 90 天內有效（含開單日），不能是未來的日期
//   - 持轉診單就醫，基本部分負擔收「經轉診」的金額（billing.basicCopayLine）；同一療程醫師約的回診沿用
//   - 本院轉他科不算轉診（用會診、預約回診）

/** 轉診單有效天數（含開單日） */
export const REFERRAL_VALID_DAYS = 90

/** 轉出的轉診目的 */
export const REFERRAL_PURPOSES = ['進一步檢查', '門診治療', '住院治療', '手術', '其他'] as const

/** 轉診單最後有效日 */
export function referralValidUntil(issuedOn: string): string {
  const d = new Date(`${issuedOn}T00:00:00`)
  d.setDate(d.getDate() + REFERRAL_VALID_DAYS - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 這張轉診單在 visitDate 那天能不能用；不能用回傳原因 */
export function referralInProblem(issuedOn: string, visitDate: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedOn)) return '請填轉診單的開單日期'
  if (issuedOn > visitDate) return '開單日期不能晚於就醫日'
  const until = referralValidUntil(issuedOn)
  if (visitDate > until) return `轉診單已過期（${REFERRAL_VALID_DAYS} 天內有效，到 ${until}）`
  return undefined
}

/** 櫃台登錄的轉診單內容 */
export interface ReferralInInput {
  fromHospital: string
  issuedOn: string
  diagnosis: string
  purpose?: string
}

/** 轉診單欄位檢查（掛號頁即時提示、服務層共用）：回傳欄位錯誤，沒有＝可以用 */
export function checkReferralInInput(input: ReferralInInput, visitDate: string): Record<string, string> {
  const e: Record<string, string> = {}
  if (!input.fromHospital?.trim()) e.fromHospital = '請填轉出院所'
  if (!input.diagnosis?.trim()) e.diagnosis = '請填轉診單上的診斷'
  const p = referralInProblem(input.issuedOn ?? '', visitDate)
  if (p) e.issuedOn = p
  return e
}
