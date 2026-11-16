// 管制藥品的開立與調劑規則（純函式）：門診、住院、藥局、測試共用。
// 依管制藥品管理條例的精神（展示用簡化）：
//   - 第一～三級：醫師要有「管制藥品使用執照」（有效期內）才能開；門診要另開「管制藥品專用處方箋」，
//     上面要有病人身分證號與地址、藥品總量用國字大寫（防止塗改）、醫師的使用執照號碼；
//     藥局發藥時要登記領藥人的身分證號（本人或代領）。
//   - 第四級：一般處方即可，不需要使用執照、不需要專用處方箋（簿冊照樣要記）。

/** 這個級別要不要專用處方箋與使用執照（第一～三級） */
export const needsSpecialRx = (controlled: number | undefined): boolean => !!controlled && controlled <= 3

export const CONTROLLED_LEVEL_LABEL = ['', '第一級', '第二級', '第三級', '第四級']

/** 醫師的管制藥品使用執照能不能開某天的處方：回傳不能開的原因，沒問題回傳 undefined */
export function licenseProblem(lic: { no: string; validUntil: string } | undefined, date: string): string | undefined {
  if (!lic?.no) return '沒有管制藥品使用執照'
  if (lic.validUntil < date) return `的管制藥品使用執照已於 ${lic.validUntil} 到期`
  return undefined
}

/** 身分證字號格式（展示用：只檢查格式，不驗檢查碼） */
export const ID_NO_PATTERN = /^[A-Z][12]\d{8}$/

const DIGIT = ['零', '壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖']
const UNIT = ['', '拾', '佰', '仟']

/**
 * 數量的國字大寫（專用處方箋的總量，防止「1」被改成「11」）：
 * 9 → 玖、10 → 壹拾、105 → 壹佰零伍、1000 → 壹仟、0.5 → 零點伍。最多到 9999.99（處方總量不會更大）
 */
export function chineseUpper(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n >= 10000) return String(n)
  const [intPart, frac = ''] = String(Math.round(n * 100) / 100).split('.')
  const digits = intPart.split('').map(Number)
  let s = ''
  let zero = false
  digits.forEach((d, i) => {
    const unit = UNIT[digits.length - 1 - i]
    if (d === 0) {
      zero = s !== ''
      return
    }
    if (zero) s += '零'
    zero = false
    s += DIGIT[d] + unit
  })
  if (!s) s = '零'
  return frac ? `${s}點${frac.split('').map((c) => DIGIT[Number(c)]).join('')}` : s
}
