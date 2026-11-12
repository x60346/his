// 片語規則（純函式）：簡碼格式、展開。服務層存檔前檢查、看診頁輸入時展開，都用這裡同一份。

/** 簡碼：英文或數字 1–10 碼（不分大小寫，存小寫） */
export const PHRASE_CODE = /^[a-z0-9]{1,10}$/
export const PHRASE_MAX_TEXT = 500

export const normalizePhraseCode = (code: string) => (code ?? '').trim().replace(/^\./, '').toLowerCase()

/** 簡碼與內容的欄位錯誤（一次全部列出）；沒有錯誤回傳空物件 */
export function checkPhrase(input: { code: string; text: string }): Record<string, string> {
  const errors: Record<string, string> = {}
  const code = normalizePhraseCode(input.code)
  if (!code) errors.code = '請輸入簡碼'
  else if (!PHRASE_CODE.test(code)) errors.code = '簡碼只能用英文或數字，最多 10 碼'
  const text = (input.text ?? '').trim()
  if (!text) errors.text = '請輸入片語內容'
  else if (text.length > PHRASE_MAX_TEXT) errors.text = `片語最多 ${PHRASE_MAX_TEXT} 字`
  return errors
}

/**
 * 展開：游標前面緊接著「.簡碼」就換成片語內容，回傳新的文字與游標位置；不是片語就回傳 null（照常輸入空白）。
 * 「.簡碼」前面要是開頭、空白或中文標點——「v1.2」「3.5mg」裡的點不會被當成片語。
 * 找不到的簡碼不動它，醫師打的字不會無故消失。
 */
export function expandPhrase(text: string, cursor: number, phrases: { code: string; text: string }[]): { text: string; cursor: number } | null {
  const before = text.slice(0, cursor)
  const m = /(^|[\s，。、；：（(])\.([A-Za-z0-9]{1,10})$/.exec(before)
  if (!m) return null
  const p = phrases.find((x) => x.code === m[2].toLowerCase())
  if (!p) return null
  const start = cursor - m[2].length - 1
  return { text: text.slice(0, start) + p.text + text.slice(cursor), cursor: start + p.text.length }
}
