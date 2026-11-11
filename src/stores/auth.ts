// 登入狀態：畫面用來決定顯示什麼（選單、使用者名稱）。
// 真正的權限檢查在服務層的 requireUser()，這裡只負責「體驗」。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { authApi, type SafeUser } from '@/services'
import type { Role } from '@/types'

export const useAuth = defineStore('auth', () => {
  // 重新整理頁面時，從服務層的 session 還原
  const user = ref<SafeUser | null>(authApi.currentUser())
  const isLoggedIn = computed(() => !!user.value)
  /** 閒置鎖定中（鎖定時間）；重新整理後從服務層還原，不能用 F5 繞過 */
  const lockedAt = ref<string | null>(authApi.currentLock()?.at ?? null)

  async function login(username: string, password: string) {
    user.value = await authApi.login(username, password)
    return user.value
  }

  async function logout() {
    await authApi.logout()
    user.value = null
    lockedAt.value = null
  }

  /** 變更自己的密碼；回傳的使用者已清掉「必須變更」 */
  async function changePassword(current: string, next: string) {
    user.value = await authApi.changeOwnPassword({ current, next })
    return user.value
  }

  async function lock() {
    lockedAt.value = (await authApi.lockSession()).at
  }

  /** 解鎖；連續錯太多次會被登出（回傳結果讓鎖定畫面顯示剩幾次） */
  async function unlock(password: string) {
    const r = await authApi.unlockSession(password)
    if (r.ok) lockedAt.value = null
    else if (r.loggedOut) {
      user.value = null
      lockedAt.value = null
    }
    return r
  }

  /** 未指定角色＝登入即可；admin 可進入所有頁面 */
  /**
   * 服務端判定登入已失效（帳號被停用、資料被匯入替換…）。
   * 前端狀態與服務端的 session 都要清掉——只清前端的話，帳號一恢復啟用，重新整理就「免密碼」登入回來了。
   */
  async function expire() {
    user.value = null
    lockedAt.value = null
    await authApi.logout().catch(() => undefined)
  }

  function canAccess(roles?: Role[]) {
    if (!user.value) return false
    if (!roles?.length || user.value.role === 'admin') return true
    return roles.includes(user.value.role)
  }

  return { user, isLoggedIn, lockedAt, login, logout, changePassword, lock, unlock, expire, canAccess }
})
