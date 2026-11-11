// 閒置鎖定的規則（純函式：版面的計時器、管理頁的設定檢查、流程測試共用）。
// 鎖定而不是直接登出：病歷寫到一半的人離開座位，回來輸入密碼就能接著寫；換人使用則按「切換使用者」真正登出。

/** 預設閒置多久鎖定（分鐘） */
export const IDLE_LOCK_DEFAULT_MIN = 15
/** 可設定的範圍（分鐘）：1 分鐘方便展示，60 分鐘以上離開座位太久 */
export const IDLE_LOCK_RANGE: [number, number] = [1, 60]
/** 鎖定前提醒幾秒（設定很短時最多提醒一半的時間，例：1 分鐘 → 前 30 秒照常、後 30 秒倒數） */
export const IDLE_WARN_SEC = 60
/** 解鎖密碼連續錯幾次就直接登出（避免有人坐下來一直猜） */
export const UNLOCK_MAX_FAILS = 5

export type IdlePhase = 'active' | 'warning' | 'lock'

/**
 * 依「最後一次操作」與「現在」算出目前階段。用時間戳記算、不靠倒數計時：
 * 背景分頁的計時器會被瀏覽器放慢、電腦睡眠時計時器暫停，醒來時一算就知道早該鎖了。
 */
export function idlePhase(lastActiveMs: number, nowMs: number, timeoutMin: number): { phase: IdlePhase; secondsLeft: number } {
  const total = timeoutMin * 60
  const warn = Math.min(IDLE_WARN_SEC, total / 2)
  const left = Math.ceil(total - (nowMs - lastActiveMs) / 1000)
  if (left <= 0) return { phase: 'lock', secondsLeft: 0 }
  return { phase: left <= warn ? 'warning' : 'active', secondsLeft: left }
}

/** 管理頁設定檢查：有問題回傳訊息 */
export function checkIdleMinutes(min: number | undefined): string | null {
  const [lo, hi] = IDLE_LOCK_RANGE
  if (min === undefined || min === null || Number.isNaN(min)) return '請輸入分鐘數'
  if (!Number.isInteger(min) || min < lo || min > hi) return `請輸入 ${lo}–${hi} 的整數`
  return null
}
