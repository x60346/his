// 這個分頁目前能做哪些受控操作（登入資料的 can，服務層依權限目錄算好的）。
// 只用來決定按鈕顯不顯示——真正的把關在服務層 requirePermission，直接呼叫 API 一樣會被擋。
import { useAuth } from '@/stores/auth'
import type { PermKey } from '@/services'

export function useCan() {
  const auth = useAuth()
  return (key: PermKey) => !!auth.user?.can?.includes(key)
}
