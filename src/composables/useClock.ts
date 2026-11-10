// 全系統共用的時鐘：一個計時器、每 30 秒更新一次，所有頁面讀同一個「現在」與「今天」。
//
// 為什麼需要：頁面打開時呼叫一次 today() 記下來，之後就不會變。頁面開著跨過午夜，
// 護理站的「今天」還停在昨天——大夜班（00:00–08:00）正是跨夜值班的人。
// 用「會走動的今天」，日期一變，依賴它的畫面與查詢就會自動更新。
import { computed, ref, watch, type Ref } from 'vue'
import { now } from '@/utils/date'

const current = ref(now())
let started = false
function start() {
  if (started || typeof window === 'undefined') return
  started = true
  // 全域時鐘跟著整個應用程式存在，不需要清除
  window.setInterval(() => (current.value = now()), 30_000)
}

/** 會走動的「現在」（YYYY-MM-DD HH:mm） */
export function useClock(): Readonly<Ref<string>> {
  start()
  return current
}

/** 會走動的「今天」（YYYY-MM-DD），跨過午夜時自動變成新的一天 */
export function useToday() {
  start()
  return computed(() => current.value.slice(0, 10))
}

/**
 * 讓日期欄位「跟著今天走」：欄位原本顯示今天，跨日時自動換成新的今天；
 * 使用者自己選了別的日期（例如查昨天的報表），就不去動它。
 */
export function followToday(date: Ref<string | undefined>) {
  const today = useToday()
  watch(today, (next, prev) => {
    if (date.value === prev) date.value = next
  })
  return today
}
