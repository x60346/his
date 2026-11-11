// 登入與身分。回傳給前端的使用者資料一律移除密碼欄位。
import type { User } from '@/types'
import { db } from '@/mock/db'
import { fail, failField, mutate, query, requireUser, sessionLock, sessionUser, setSessionLock, setSessionUser, audit } from './http'
import { checkIdleMinutes, IDLE_LOCK_DEFAULT_MIN, UNLOCK_MAX_FAILS } from './idle-rules'
import { now } from '@/utils/date'

export type SafeUser = Omit<User, 'password'>

export const toSafeUser = ({ password: _pw, ...rest }: User): SafeUser => rest

export function login(username: string, password: string): Promise<SafeUser> {
  return mutate(() => {
    // 帳號一律以小寫儲存（系統管理建立帳號時就轉小寫），登入時也轉小寫比對：打成 ADMIN 也能登入
    const name = username.trim().toLowerCase()
    if (!name || !password) fail('請輸入帳號與密碼', 'BAD_REQUEST')
    const u = db.users.find((x) => x.username === name)
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

// ---------- 閒置鎖定 ----------

/** 同步取得鎖定狀態（重新整理後，版面要立刻知道是否該顯示鎖定畫面） */
export function currentLock(): { at: string } | null {
  const l = sessionLock()
  return sessionUser() && l ? { at: l.at } : null
}

/** 閒置多久鎖定（分鐘）：登入後的版面用來計時 */
export function idleLockMinutes(): Promise<number> {
  return query(() => db.securitySettings?.idleLockMin ?? IDLE_LOCK_DEFAULT_MIN)
}

/** 鎖定：閒置時間到，由版面呼叫。已鎖定就不重複寫稽核 */
export function lockSession(): Promise<{ at: string }> {
  return mutate(() => {
    const u = sessionUser()
    if (!u) fail('請先登入', 'UNAUTHORIZED')
    const l = sessionLock()
    if (l) return { at: l.at }
    const at = now()
    setSessionLock({ at, failures: 0 })
    audit('閒置鎖定', u!.username)
    return { at }
  })
}

export type UnlockResult = { ok: true } | { ok: false; remaining: number; loggedOut: boolean }

/**
 * 解鎖：只能由同一個人輸入自己的密碼。密碼錯不丟錯誤、回傳結果——
 * 丟錯誤的話交易會回滾，「解鎖失敗」的稽核紀錄就留不下來。
 * 連續錯 UNLOCK_MAX_FAILS 次直接登出。
 */
export function unlockSession(password: string): Promise<UnlockResult> {
  return mutate((): UnlockResult => {
    const u = sessionUser()
    const l = sessionLock()
    if (!u) fail('請先登入', 'UNAUTHORIZED')
    if (!l) return { ok: true }
    if (!password) failField('password', '請輸入密碼')
    if (u!.password === password) {
      setSessionLock(null)
      audit('解鎖', u!.username)
      return { ok: true }
    }
    const failures = l.failures + 1
    if (failures >= UNLOCK_MAX_FAILS) {
      audit('解鎖失敗', `${u!.username}：連續 ${failures} 次，已強制登出`)
      setSessionUser(null)
      return { ok: false, remaining: 0, loggedOut: true }
    }
    setSessionLock({ ...l, failures })
    audit('解鎖失敗', `${u!.username}：第 ${failures} 次`)
    return { ok: false, remaining: UNLOCK_MAX_FAILS - failures, loggedOut: false }
  })
}

/** 安全設定（管理員） */
export function saveIdleLockMinutes(min: number): Promise<number> {
  return mutate(() => {
    requireUser('admin')
    const problem = checkIdleMinutes(min)
    if (problem) failField('idleLockMin', problem)
    const old = db.securitySettings?.idleLockMin ?? IDLE_LOCK_DEFAULT_MIN
    db.securitySettings = { idleLockMin: min }
    audit('修改安全設定', `閒置鎖定 ${old} → ${min} 分鐘`)
    return min
  })
}
