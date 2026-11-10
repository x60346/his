// 會走動的「現在時間」：時間相關的顯示（逾時、待給）依它重新計算。
// 頁面不要各自 setInterval——一個時鐘、一個清理點，元件卸載時自動停止。
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { now } from '@/utils/date'

export function useNow(intervalMs = 30_000) {
  const current = ref(now())
  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => (timer = setInterval(() => (current.value = now()), intervalMs)))
  onBeforeUnmount(() => clearInterval(timer))
  return current
}
