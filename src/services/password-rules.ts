// 密碼規則（純函式：變更密碼對話框、強制變更畫面、管理員重設與新增帳號、服務層共用）。
// 規則只在「設定密碼」時檢查；展示帳號既有的 1234 照樣能登入。

export const PASSWORD_MIN = 8
export const PASSWORD_RULE = `至少 ${PASSWORD_MIN} 碼，需同時包含英文字母與數字`

/**
 * 新密碼的問題；沒問題回傳 null。
 * current：目前的密碼（自己變更時才給）——新舊相同等於沒改。
 */
export function passwordProblem(pw: string | undefined, opts: { username: string; current?: string }): string | null {
  if (!pw) return '請輸入新密碼'
  if (pw.length < PASSWORD_MIN) return `至少 ${PASSWORD_MIN} 碼`
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return '需同時包含英文字母與數字'
  // 包含帳號的密碼（dr01abc1）幾乎等於公開的
  if (opts.username && pw.toLowerCase().includes(opts.username.toLowerCase())) return '不可包含帳號名稱'
  if (opts.current !== undefined && pw === opts.current) return '不可與目前密碼相同'
  return null
}
