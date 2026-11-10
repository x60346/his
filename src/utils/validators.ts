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

// ---------- 病人基本資料（建檔表單即時提示與服務層共用） ----------
export const NAME_MAX = 30
/** 出生日期下限：早於此日期幾乎一定是輸入錯誤（例：1800 年） */
export const BIRTH_MIN = '1900-01-01'

/** 姓名檢查：有問題回傳訊息，沒問題回傳 null */
export function checkName(name: string): string | null {
  const n = name.trim()
  if (!n) return '姓名為必填'
  if (n.length > NAME_MAX) return `姓名最多 ${NAME_MAX} 個字（目前 ${n.length} 字）`
  return null
}

/** 出生日期檢查：today 由呼叫端傳入（純函式不自己讀時間） */
export function checkBirthDate(date: string, today: string): string | null {
  if (!date) return '出生日期為必填'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '出生日期格式錯誤'
  if (date < BIRTH_MIN) return `出生日期不可早於 ${BIRTH_MIN}`
  if (date > today) return '出生日期不可晚於今天'
  return null
}
