// 閒置計時（主版面使用）：記下最後一次操作的時間，每秒依 idlePhase 判斷該提醒還是該鎖定。
// 「操作」：點擊、按鍵、捲動、觸控；滑鼠移動也算，但最多 5 秒記一次（移動事件一秒觸發幾十次）。
// 已經在倒數提醒時，只有點擊或按鍵算數：桌子被碰到、滑鼠滑了一下，不該讓人以為還有人在用。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { authApi, dbVersion, idlePhase, type IdlePhase } from '@/services'
import { useAuth } from '@/stores/auth'

export function useIdleLock() {
  const auth = useAuth()
  const minutes = ref<number>()
  const lastActive = ref(Date.now())
  const phase = ref<IdlePhase>('active')
  const secondsLeft = ref(0)

  async function loadSetting() {
    try {
      minutes.value = await authApi.idleLockMinutes()
    } catch {
      // 鎖定中、或剛登出：讀不到就維持原值，解鎖後再讀
    }
  }

  const strong = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
  function onStrong() {
    if (auth.lockedAt) return
    lastActive.value = Date.now()
    if (phase.value === 'warning') tick()
  }
  let lastMove = 0
  function onMove() {
    if (auth.lockedAt || phase.value === 'warning') return
    const t = Date.now()
    if (t - lastMove < 5000) return
    lastMove = t
    lastActive.value = t
  }

  let locking = false
  async function tick() {
    if (!auth.user || auth.lockedAt || !minutes.value) return
    const r = idlePhase(lastActive.value, Date.now(), minutes.value)
    phase.value = r.phase
    secondsLeft.value = r.secondsLeft
    if (r.phase === 'lock' && !locking) {
      locking = true
      try {
        await auth.lock()
      } finally {
        locking = false
      }
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined
  // 分頁切回來時立刻判斷一次：背景分頁的計時器會被放慢，回來的那一刻可能早就該鎖了
  const onVisible = () => document.visibilityState === 'visible' && tick()
  onMounted(() => {
    for (const ev of strong) window.addEventListener(ev, onStrong, { capture: true, passive: true })
    window.addEventListener('mousemove', onMove, { capture: true, passive: true })
    document.addEventListener('visibilitychange', onVisible)
    timer = setInterval(tick, 1000)
    loadSetting()
  })
  onBeforeUnmount(() => {
    for (const ev of strong) window.removeEventListener(ev, onStrong, { capture: true })
    window.removeEventListener('mousemove', onMove, { capture: true })
    document.removeEventListener('visibilitychange', onVisible)
    clearInterval(timer)
  })

  // 解鎖（或重新整理後首次載入）：從現在重新計時，並重讀設定（管理員可能剛改過）
  watch(
    () => auth.lockedAt,
    (locked) => {
      if (locked) return
      lastActive.value = Date.now()
      phase.value = 'active'
      loadSetting()
    },
  )

  // 管理員改了設定（本分頁或其他分頁）：資料庫一有寫入就重讀，不必重新登入才生效
  watch(dbVersion, () => !auth.lockedAt && loadSetting())

  /** 提醒框的「繼續使用」 */
  function stayActive() {
    lastActive.value = Date.now()
    phase.value = 'active'
  }

  return { warning: computed(() => phase.value === 'warning' && !auth.lockedAt), secondsLeft, minutes, stayActive }
}
