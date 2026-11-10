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

  async function login(username: string, password: string) {
    user.value = await authApi.login(username, password)
    return user.value
  }

  async function logout() {
    await authApi.logout()
    user.value = null
  }

  /** 未指定角色＝登入即可；admin 可進入所有頁面 */
  /**
   * 服務端判定登入已失效（帳號被停用、資料被匯入替換…）。
   * 前端狀態與服務端的 session 都要清掉——只清前端的話，帳號一恢復啟用，重新整理就「免密碼」登入回來了。
   */
  async function expire() {
    user.value = null
    await authApi.logout().catch(() => undefined)
  }

  function canAccess(roles?: Role[]) {
    if (!user.value) return false
    if (!roles?.length || user.value.role === 'admin') return true
    return roles.includes(user.value.role)
  }

  return { user, isLoggedIn, login, logout, expire, canAccess }
})
