// 登入與身分。回傳給前端的使用者資料一律移除密碼欄位。
import type { Role, User } from '@/types'
import { db } from '@/mock/db'
import { fail, failField, failFields, fieldErrors, mutate, passwordAgeOf, query, requireUser, sessionLock, sessionRole, sessionRoleFellBack, sessionUser, setSessionLock, setSessionRole, setSessionUser, audit } from './http'
import { checkPasswordPolicy, PASSWORD_HISTORY_DEFAULT, PASSWORD_HISTORY_MAX, PASSWORD_MAX_DAYS_DEFAULT, passwordProblem, reusedPassword } from './password-rules'
import { checkIdleMinutes, IDLE_LOCK_DEFAULT_MIN, UNLOCK_MAX_FAILS } from './idle-rules'
import { now, today } from '@/utils/date'

/** 給前端的使用者：沒有密碼、也沒有以前的密碼 */
export type SafeUser = Omit<User, 'password' | 'passwordHistory'>

export const toSafeUser = ({ password: _pw, passwordHistory: _h, ...rest }: User): SafeUser => rest

/**
 * 目前登入的人：帳號（roles＝能用的所有角色）＋這個分頁的作業角色 role。畫面上的角色判斷一律看 role。
 * passwordExpired：密碼過期，版面蓋上強制變更畫面；passwordDaysLeft：進入提醒期，右上角提示還剩幾天
 */
export type SessionUser = SafeUser & { role: Role; passwordExpired?: boolean; passwordDaysLeft?: number }

const toSessionUser = (u: User): SessionUser => {
  const age = passwordAgeOf(u)
  return {
    ...toSafeUser(u), role: sessionRole() ?? u.roles[0],
    ...(age?.expired && !u.mustChangePassword ? { passwordExpired: true } : {}),
    ...(age?.warn ? { passwordDaysLeft: age.daysLeft } : {}),
  }
}

const roleText: Record<Role, string> = { admin: '系統管理員', doctor: '醫師', nurse: '護理師', pharmacist: '藥師', clerk: '掛號批價' }

/** 帳號有多個角色、登入時沒指定：先不登入，回傳可選的角色讓登入頁問一次（不先用第一個角色登入，稽核才不會多一筆沒意義的切換） */
export type LoginResult = SessionUser | { chooseRole: Role[] }

export function login(username: string, password: string, role?: Role): Promise<LoginResult> {
  return mutate((): LoginResult => {
    // 帳號一律以小寫儲存（系統管理建立帳號時就轉小寫），登入時也轉小寫比對：打成 ADMIN 也能登入
    const name = username.trim().toLowerCase()
    if (!name || !password) fail('請輸入帳號與密碼', 'BAD_REQUEST')
    const u = db.users.find((x) => x.username === name)
    if (!u || u.password !== password) fail('帳號或密碼錯誤', 'UNAUTHORIZED')
    if (!u.active) fail('此帳號已停用', 'FORBIDDEN')
    if (!u.roles.length) fail('此帳號沒有任何角色，請洽系統管理員', 'FORBIDDEN')
    if (role && !u.roles.includes(role)) fail(`此帳號沒有「${roleText[role]}」角色`, 'FORBIDDEN')
    if (!role && u.roles.length > 1) return { chooseRole: [...u.roles] }
    const active = role ?? u.roles[0]
    setSessionUser(u.id, Date.now(), active)
    audit('登入', u.roles.length > 1 ? `${u.username}（以${roleText[active]}身分）` : u.username)
    return toSessionUser(u)
  })
}

/** 切換作業角色（同一個帳號的其他角色）：不必重新登入；稽核記下切換 */
export function switchRole(role: Role): Promise<SessionUser> {
  return mutate(() => {
    const u = requireUser()
    if (!u.roles.includes(role)) fail(`此帳號沒有「${roleText[role]}」角色`, 'FORBIDDEN')
    if (u.role === role) return toSessionUser(u)
    const from = u.role
    setSessionRole(role)
    audit('切換角色', `${u.username}：${roleText[from]} → ${roleText[role]}`)
    return toSessionUser(u)
  })
}

/** 記下的作業角色已被管理員拿掉（已改用帳號的第一個角色）：版面提示一次 */
export const roleFellBack = (): boolean => sessionRoleFellBack()

export function logout(): Promise<void> {
  return mutate(() => {
    const u = sessionUser()
    if (u) audit('登出', u.username)
    setSessionUser(null)
  })
}

/** 同步取得目前登入者（路由守衛在頁面載入前就需要知道） */
export function currentUser(): SessionUser | null {
  const u = sessionUser()
  return u ? toSessionUser(u) : null
}

/** 登入頁的展示帳號快速選擇 */
export function demoAccounts(): Promise<{ username: string; name: string; roles: Role[]; passwordChanged: boolean }[]> {
  // 公開：登入頁需要。這只是展示系統的便利功能——真實系統絕不能在登入前列出帳號（更不能透露密碼改過沒有）
  // passwordChanged：密碼已不是展示用的 1234，快速登入按鈕只帶入帳號、由使用者自己輸入密碼
  return query(() => db.users.filter((u) => u.active).map((u) => ({ username: u.username, name: u.name, roles: u.roles, passwordChanged: u.password !== '1234' })), { public: true })
}

/**
 * 變更自己的密碼：要輸入目前的密碼（座位上沒登出的電腦，別人不能順手改掉密碼、占用帳號）。
 * 不用 requireUser：「必須先改密碼」的人也要能呼叫。
 * 改完後，這個分頁的登入時間同步更新（繼續登入）；其他比較早登入的分頁全部失效。
 */
export function changeOwnPassword(input: { current: string; next: string }): Promise<SessionUser> {
  return mutate(() => {
    const u = sessionUser()
    if (!u) fail('請先登入', 'UNAUTHORIZED')
    const v = fieldErrors()
    if (!input.current) v.add('current', '請輸入目前的密碼')
    else if (input.current !== u!.password) v.add('current', '目前的密碼不正確')
    // 規則（長度、英數、不含帳號）先看；都符合才比對以前用過的——訊息一次只講一件事
    const recent = [u!.password, ...(u!.passwordHistory ?? [])]
    const problem = passwordProblem(input.next, { username: u!.username, current: u!.password }) ?? reusedPassword(input.next, recent, db.securitySettings?.passwordHistory ?? PASSWORD_HISTORY_DEFAULT)
    if (problem) v.add('next', problem)
    v.done()
    const forced = !!u!.mustChangePassword
    const expired = !forced && !!passwordAgeOf(u!)?.expired
    const at = Date.now()
    const keepRole = sessionRole()
    // 管理員設定的暫時密碼也記進歷史（本人不能「改回」管理員給的那組——管理員知道它）
    u!.passwordHistory = recent.slice(0, PASSWORD_HISTORY_MAX)
    u!.password = input.next
    u!.passwordChangedAt = at
    u!.passwordSetOn = today()
    delete u!.mustChangePassword
    setSessionUser(u!.id, at, keepRole) // 繼續登入，角色不變
    audit(forced ? '首次變更密碼' : expired ? '密碼過期變更' : '變更密碼', u!.username)
    return toSessionUser(u!)
  })
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

/** 密碼原則：期限（天，0＝不限）、不可重複最近幾次。登入後的版面與管理頁都會讀 */
export function passwordPolicy(): Promise<{ maxDays: number; history: number }> {
  return query(() => ({ maxDays: db.securitySettings?.passwordMaxDays ?? PASSWORD_MAX_DAYS_DEFAULT, history: db.securitySettings?.passwordHistory ?? PASSWORD_HISTORY_DEFAULT }))
}

/**
 * 修改密碼原則（管理員）。縮短期限會讓一些帳號立刻過期——回傳受影響的帳號數，管理頁提示；
 * 不會因此鎖帳號，那些人下次操作時先改密碼
 */
export function savePasswordPolicy(input: { maxDays: number; history: number }): Promise<{ maxDays: number; history: number; expiredUsers: number }> {
  return mutate(() => {
    requireUser('admin')
    failFields(checkPasswordPolicy(input))
    const old = { maxDays: db.securitySettings?.passwordMaxDays ?? PASSWORD_MAX_DAYS_DEFAULT, history: db.securitySettings?.passwordHistory ?? PASSWORD_HISTORY_DEFAULT }
    db.securitySettings = { ...db.securitySettings, passwordMaxDays: input.maxDays, passwordHistory: input.history } // 合併：不蓋掉其他設定
    const expiredUsers = db.users.filter((u) => u.active && !u.mustChangePassword && passwordAgeOf(u)?.expired).length
    audit('修改安全設定', `密碼期限 ${old.maxDays}→${input.maxDays} 天、不可重複最近 ${old.history}→${input.history} 次`)
    return { ...input, expiredUsers }
  })
}

/** 安全設定（管理員） */
export function saveIdleLockMinutes(min: number): Promise<number> {
  return mutate(() => {
    requireUser('admin')
    const problem = checkIdleMinutes(min)
    if (problem) failField('idleLockMin', problem)
    const old = db.securitySettings?.idleLockMin ?? IDLE_LOCK_DEFAULT_MIN
    db.securitySettings = { ...db.securitySettings, idleLockMin: min } // 合併：不能把同一個物件裡的其他設定（雙人核對）蓋掉
    audit('修改安全設定', `閒置鎖定 ${old} → ${min} 分鐘`)
    return min
  })
}
