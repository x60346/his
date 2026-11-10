// 會走動的「現在時間」：時間相關的顯示（逾時、待給）依它重新計算。
// 實際的時鐘在 useClock（全系統共用一個計時器），這裡保留舊名稱供既有頁面使用。
import { useClock } from './useClock'

export function useNow() {
  return useClock()
}
