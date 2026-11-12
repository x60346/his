// 密碼規則（純函式：變更密碼對話框、強制變更畫面、管理員重設與新增帳號、服務層共用）。
// 規則只在「設定密碼」時檢查；展示帳號既有的 1234 照樣能登入。
import { addDays, diffDays } from '@/utils/date'

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

// ---------- 密碼期限與歷史 ----------
// 期限從「本人設定這組密碼的日期」（User.passwordSetOn）算起；管理員重設的密碼本來就要先改（mustChangePassword），不另外算期限。
// 到期不鎖帳號：登入後先改密碼才能做其他事（和管理員重設後一樣），服務層 requireUser 也擋。

export const PASSWORD_MAX_DAYS_DEFAULT = 90
export const PASSWORD_HISTORY_DEFAULT = 3
/** 到期前幾天開始在右上角提醒 */
export const PASSWORD_WARN_DAYS = 14
/** 設定範圍：期限 0（不限）或 30–365 天；不可重複最近 0–10 次 */
export const PASSWORD_MAX_DAYS_RANGE = [30, 365] as const
export const PASSWORD_HISTORY_MAX = 10

export interface PasswordAge {
  expiresOn: string
  /** 還剩幾天（0＝今天到期，負數＝已過期幾天） */
  daysLeft: number
  expired: boolean
  /** 進入提醒期（還沒過期） */
  warn: boolean
}

/** 這組密碼的期限狀態；沒有期限（設定 0）或不知道設定日期回傳 null */
export function passwordAge(setOn: string | undefined, today: string, maxDays: number): PasswordAge | null {
  if (!maxDays || !setOn) return null
  const expiresOn = addDays(setOn, maxDays)
  const daysLeft = diffDays(today, expiresOn)
  // 到期日當天起就要改（daysLeft ≤ 0）：「90 天」是可以用 90 天，第 91 天要換
  return { expiresOn, daysLeft, expired: daysLeft <= 0, warn: daysLeft > 0 && daysLeft <= PASSWORD_WARN_DAYS }
}

/**
 * 新密碼是不是最近用過的：recent＝目前的密碼＋以前的（新到舊），n＝不可重複最近幾次（含目前這組）。
 * 只有服務層呼叫——以前的密碼不會送到畫面上，畫面只檢查長度、英數這些規則
 */
export function reusedPassword(next: string, recent: readonly string[], n: number): string | null {
  const k = Math.max(1, n) // 至少不能和目前的相同（passwordProblem 也擋）
  if (!recent.slice(0, k).includes(next)) return null
  return k === 1 ? '不可與目前密碼相同' : `不可與最近 ${k} 次用過的密碼相同`
}

/** 密碼原則設定檢查（管理頁即時提示與服務層共用） */
export function checkPasswordPolicy(p: { maxDays?: number; history?: number }): { maxDays?: string; history?: string } {
  const e: { maxDays?: string; history?: string } = {}
  const [lo, hi] = PASSWORD_MAX_DAYS_RANGE
  if (!Number.isInteger(p.maxDays) || (p.maxDays !== 0 && (p.maxDays! < lo || p.maxDays! > hi))) e.maxDays = `0（不限）或 ${lo}–${hi} 天的整數`
  if (!Number.isInteger(p.history) || p.history! < 0 || p.history! > PASSWORD_HISTORY_MAX) e.history = `0–${PASSWORD_HISTORY_MAX} 的整數（0＝只擋和目前相同）`
  return e
}
