import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuth } from '@/stores/auth'
import { routes } from './routes'

export const router = createRouter({
  // hash 模式：建置後放到任何靜態主機（甚至直接開檔案）都能用，不需伺服器設定
  history: createWebHashHistory(),
  routes,
})

// 路由守衛：未登入 → 登入頁（記住原本要去哪）；角色不符 → 沒有權限頁
router.beforeEach((to) => {
  const auth = useAuth()
  if (to.meta.public) {
    return to.name === 'login' && auth.isLoggedIn ? '/' : true
  }
  if (!auth.isLoggedIn) return { name: 'login', query: { redirect: to.fullPath } }
  if (!auth.canAccess(to.meta.roles)) return { name: 'forbidden', query: { from: to.fullPath } }
  return true
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title}｜HIS 展示系統` : 'HIS 展示系統'
})
