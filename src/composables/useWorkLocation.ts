// 藥師目前在哪個庫存地點工作（大型醫院：藥庫、門診藥局、住院藥局…）。
// 頁面上選、記住上次選的（每台電腦各自記：藥庫的電腦通常一直是藥庫）。小型醫院只有一個地點，選單不顯示。
// 能不能在這個地點做什麼，由服務層判斷；這裡只是「預設帶哪個地點」。
import { computed, ref, watch } from 'vue'
import { inventoryApi } from '@/services'
import { useQuery } from './useService'

const KEY = 'his-demo-work-location'
const read = () => {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}
// 模組層級：庫存頁、明細、進貨對話框共用同一個選擇
const chosen = ref(read())

export function useWorkLocation() {
  const { data } = useQuery(() => inventoryApi.listStockLocations())
  const locations = computed(() => data.value?.locations ?? [])
  /** 目前地點：記住的那個還存在就用它，否則用門診發藥的藥局 */
  const locationId = computed(() => (locations.value.some((l) => l.id === chosen.value) ? chosen.value : (data.value?.opd ?? '')))
  const location = computed(() => locations.value.find((l) => l.id === locationId.value))
  const multi = computed(() => locations.value.length > 1)
  watch(chosen, (v) => {
    try {
      localStorage.setItem(KEY, v)
    } catch {
      // 無痕模式等存不了：只是下次不會記住，不影響操作
    }
  })
  const select = (id: string | number | undefined) => (chosen.value = String(id ?? ''))
  return { locations, locationId, location, multi, select, ready: computed(() => !!data.value) }
}
