// 身分證字號工具：產生與驗證格式（僅檢查格式與檢查碼，不代表真實身分）。

const letterCodes: Record<string, number> = {
  A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18, K: 19, L: 20, M: 21,
  N: 22, O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33,
}

const weights = [8, 7, 6, 5, 4, 3, 2, 1]

function partialSum(letter: string, digits: number[]): number {
  const code = letterCodes[letter]
  let sum = Math.floor(code / 10) + (code % 10) * 9
  digits.forEach((d, i) => (sum += d * weights[i]))
  return sum
}

/** 產生符合檢查碼規則的假身分證字號 */
export function makeIdNo(letter: string, gender: 'M' | 'F', serial: number): string {
  const body = [gender === 'M' ? 1 : 2, ...String(serial % 10000000).padStart(7, '0').split('').map(Number)]
  const check = (10 - (partialSum(letter, body) % 10)) % 10
  return `${letter}${body.join('')}${check}`
}

export function isValidIdNo(idNo: string): boolean {
  const s = idNo.trim().toUpperCase()
  if (!/^[A-Z][12]\d{8}$/.test(s)) return false
  const digits = s.slice(1).split('').map(Number)
  return (partialSum(s[0], digits.slice(0, 8)) + digits[8]) % 10 === 0
}

export function isValidPhone(phone: string): boolean {
  return /^0\d{1,3}-?\d{3,4}-?\d{3,4}$/.test(phone.trim())
}
