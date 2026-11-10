// 全域提示（toast）與確認框（confirm）。
// 任何地方都能呼叫 ui.toast.success('已儲存')、await ui.confirm({...})，畫面由 <UFeedbackHost> 統一呈現。
import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ToastKind = 'success' | 'error' | 'info' | 'warning'

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

export interface ConfirmOptions {
  title?: string
  message: string
  okText?: string
  cancelText?: string
  danger?: boolean
}

interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

let seq = 0

export const useUi = defineStore('ui', () => {
  const toasts = ref<ToastItem[]>([])
  const confirmState = ref<ConfirmState | null>(null)

  /** 每則提示的消失計時器（同一則重複出現時要重新計時） */
  const timers = new Map<number, ReturnType<typeof setTimeout>>()

  function push(kind: ToastKind, message: string, ms = kind === 'error' ? 5000 : 2500) {
    // 同樣的提示已經在畫面上（例如連續登入失敗）：不再疊一個，只重新計時
    const same = toasts.value.find((t) => t.kind === kind && t.message === message)
    const id = same?.id ?? ++seq
    if (!same) toasts.value.push({ id, kind, message })
    clearTimeout(timers.get(id))
    timers.set(id, setTimeout(() => dismiss(id), ms))
  }

  function dismiss(id: number) {
    clearTimeout(timers.get(id))
    timers.delete(id)
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  const toast = {
    success: (m: string) => push('success', m),
    error: (m: string) => push('error', m),
    info: (m: string) => push('info', m),
    warning: (m: string) => push('warning', m),
  }

  /** 回傳 Promise<boolean>，用 await 等使用者按下確定或取消 */
  function confirm(opts: ConfirmOptions | string): Promise<boolean> {
    const o = typeof opts === 'string' ? { message: opts } : opts
    confirmState.value?.resolve(false)
    return new Promise((resolve) => {
      confirmState.value = { ...o, resolve }
    })
  }

  function answer(ok: boolean) {
    confirmState.value?.resolve(ok)
    confirmState.value = null
  }

  return { toasts, toast, dismiss, confirmState, confirm, answer }
})
