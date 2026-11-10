// 頁面呼叫服務層的兩個標準姿勢：
//   useQuery  —— 讀資料：自動帶 loading、錯誤提示；條件變動或任何寫入（dbVersion 變了）就重新查詢
//   useAction —— 寫資料：防止重複送出、成功提示、ServiceError 自動顯示成 toast
import { ref, shallowRef, watch, type Ref, type WatchSource } from 'vue'
import { dbVersion, ServiceError } from '@/services'
import { useUi } from '@/stores/ui'
import { useAuth } from '@/stores/auth'

const isUnauthorized = (e: unknown) => e instanceof ServiceError && e.code === 'UNAUTHORIZED'

/**
 * 登入失效（UNAUTHORIZED）的統一處理：
 *   - 原本是登入狀態 → 清掉登入狀態、提示一次、回登入頁（登入後回到原頁）
 *   - 原本就沒登入 → 交給呼叫端：查詢直接靜默（路由守衛會處理），操作照一般錯誤顯示（例如登入頁輸錯密碼）
 * 回傳是否已處理（呼叫端不用再顯示錯誤）。
 */
async function handleUnauthorized(): Promise<boolean> {
  const auth = useAuth()
  if (!auth.user) return false
  const { router } = await import('@/router') // 動態載入，避免 composable ↔ router 的循環相依
  // 先記下「原本在哪一頁」再做任何 await：清 session 是一次寫入，會觸發畫面重新整理，之後再讀就可能已經變了
  const redirect = router.currentRoute.value.fullPath
  if (!auth.user) return false // 動態載入期間，可能已有其他查詢處理過了
  await auth.expire()
  useUi().toast.warning('登入已失效，請重新登入')
  router.push({ name: 'login', query: { redirect } })
  return true
}

export function errorMessage(e: unknown): string {
  if (e instanceof ServiceError) return e.message
  console.error(e)
  return '系統發生未預期的錯誤'
}

export function useQuery<T>(fn: () => Promise<T>, deps: WatchSource[] = [], opts: { immediate?: boolean } = {}) {
  const ui = useUi()
  const data = shallowRef<T>()
  const loading = ref(false)
  const error = ref<string | null>(null)
  // 只採用最後一次請求的結果，避免條件快速切換時舊回應蓋掉新回應
  let ticket = 0

  async function reload(): Promise<void> {
    const my = ++ticket
    loading.value = true
    error.value = null
    try {
      const result = await fn()
      if (my === ticket) data.value = result
    } catch (e) {
      if (my === ticket) {
        error.value = errorMessage(e)
        // 「沒登入所以讀不到」不需要錯誤提示：第一個失敗的查詢負責轉回登入頁，其餘（含跳轉後才回來的）一律靜默
        if (isUnauthorized(e)) await handleUnauthorized()
        else ui.toast.error(error.value)
      }
    } finally {
      if (my === ticket) loading.value = false
    }
  }

  watch([...deps, dbVersion], reload, { immediate: opts.immediate ?? true })
  return { data: data as Ref<T | undefined>, loading, error, reload }
}

export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>, opts: { success?: string | ((r: R) => string) } = {}) {
  const ui = useUi()
  const pending = ref(false)
  /** 服務層標了欄位的錯誤：{ idNo: '已建檔…' }，表單直接綁到對應欄位 */
  const fieldErrors = ref<Record<string, string>>({})

  /** 成功回傳結果；失敗已顯示提示並回傳 undefined，呼叫端用 if (result) 判斷即可 */
  async function run(...args: A): Promise<R | undefined> {
    if (pending.value) return undefined
    pending.value = true
    fieldErrors.value = {}
    try {
      const r = await fn(...args)
      if (opts.success) ui.toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success)
      return r
    } catch (e) {
      if (isUnauthorized(e) && (await handleUnauthorized())) return undefined
      if (e instanceof ServiceError && e.field) {
        // 欄位錯誤顯示在欄位下方；仍給一個簡短提示，避免欄位在畫面外時使用者沒注意到
        fieldErrors.value = e.fields ?? { [e.field]: e.message }
        ui.toast.warning('請修正標示的欄位')
      } else {
        ui.toast.error(errorMessage(e))
      }
      return undefined
    } finally {
      pending.value = false
    }
  }

  return { run, pending, fieldErrors }
}

/** 防抖：來源停止變動 ms 毫秒後才更新（搜尋框用，避免每打一個字就查一次） */
export function useDebounced<T>(source: Ref<T>, ms = 250): Ref<T> {
  const out = ref(source.value) as Ref<T>
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(source, (v) => {
    clearTimeout(timer)
    timer = setTimeout(() => (out.value = v), ms)
  })
  return out
}
