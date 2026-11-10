// 窄螢幕（手機、平板直向）上，左右兩欄會變成上下堆疊：點了清單上的項目，明細出現在清單下方。
// 清單長的頁面（護理站、掛號）明細會在畫面外，使用者以為沒反應。
// 這裡在「選取改變」時，把標了 data-detail 的明細區捲進畫面；寬螢幕兩欄並排時什麼都不做。
import { nextTick, watch, type WatchSource } from 'vue'

/**
 * @param trigger  選取的 id（改變且有值時才捲動）
 * @param minWidth 兩欄並排的寬度（Tailwind lg = 1024、xl = 1280），達到就不捲動
 */
export function useRevealOnNarrow(trigger: WatchSource<unknown>, minWidth = 1024) {
  watch(trigger, async (v) => {
    if (!v || typeof window === 'undefined' || window.matchMedia(`(min-width: ${minWidth}px)`).matches) return
    await nextTick()
    document.querySelector<HTMLElement>('main [data-detail]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}
