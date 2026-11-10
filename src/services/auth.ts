// 登入與身分。回傳給前端的使用者資料一律移除密碼欄位。
import type { User } from '@/types'
import { db } from '@/mock/db'
import { fail, mutate, query, sessionUser, setSessionUser, audit } from './http'

export type SafeUser = Omit<User, 'password'>

export const toSafeUser = ({ password: _pw, ...rest }: User): SafeUser => rest

export function login(username: string, password: string): Promise<SafeUser> {
  return mutate(() => {
    const u = db.users.find((x) => x.username === username.trim())
    if (!u || u.password !== password) fail('帳號或密碼錯誤', 'UNAUTHORIZED')
    if (!u.active) fail('此帳號已停用', 'FORBIDDEN')
    setSessionUser(u.id)
    audit('登入', u.username)
    return toSafeUser(u)
  })
}

export function logout(): Promise<void> {
  return mutate(() => {
    const u = sessionUser()
    if (u) audit('登出', u.username)
    setSessionUser(null)
  })
}

/** 同步取得目前登入者（路由守衛在頁面載入前就需要知道） */
export function currentUser(): SafeUser | null {
  const u = sessionUser()
  return u ? toSafeUser(u) : null
}

/** 登入頁的展示帳號快速選擇 */
export function demoAccounts(): Promise<{ username: string; name: string; role: User['role'] }[]> {
  // 公開：登入頁需要。這只是展示系統的便利功能——真實系統絕不能在登入前列出帳號
  return query(() => db.users.filter((u) => u.active).map((u) => ({ username: u.username, name: u.name, role: u.role })), { public: true })
}
