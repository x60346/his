<script setup lang="ts">
// 月統計：各項目服務人次（長條圖）＋ 異常、待報告數（表格）。
// 圖回答「哪個項目做最多」，表回答「異常率多少、還有幾份報告沒回來」——一張圖不要硬塞兩個問題。
import { computed, ref } from 'vue'
import { UBarChart, UQueryState, USelect, UTable, type BarDatum, type Column } from '@/components/ui'
import { preventApi, type PreventStat } from '@/services'
import { useQuery } from '@/composables/useService'
import { today } from '@/utils/date'

// 最近 6 個月
const months = Array.from({ length: 6 }, (_, i) => {
  const [y, m] = today().split('-').map(Number)
  const d = new Date(y, m - 1 - i, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
})
const month = ref<string | number | undefined>(months[0])
const monthLabel = (s: string) => `${Number(s.slice(0, 4)) - 1911} 年 ${Number(s.slice(5))} 月`

const { data, loading } = useQuery(
  async () => {
    const m = String(month.value)
    return { m, list: await preventApi.monthlyStats(m) }
  },
  [month],
)
const stats = computed(() => (data.value?.m === month.value ? data.value?.list : undefined))
const total = computed(() => (stats.value ?? []).reduce((s, x) => s + x.count, 0))

// 項目全名太長，X 軸用簡稱，滑鼠提示顯示全名
const shortName: Record<string, string> = { ADULT: '成人健檢', CERVIX: '子宮頸抹片', BREAST: '乳房攝影', COLON: '糞便潛血', ORAL: '口腔黏膜', LUNG: '肺癌 LDCT', BCLIVER: 'B/C 肝', CHILD: '兒童保健' }
const bars = computed<BarDatum[]>(() => (stats.value ?? []).map((s) => ({ label: shortName[s.code] ?? s.code, value: s.count, title: s.name })))

const columns: Column<PreventStat>[] = [
  { key: 'name', label: '項目' },
  { key: 'count', label: '人次', align: 'right' },
  { key: 'abnormal', label: '異常需追蹤', align: 'right' },
  { key: 'rate', label: '異常率', align: 'right', format: (r) => (r.count - r.pending ? `${Math.round((r.abnormal / (r.count - r.pending)) * 100)}%` : '—') },
  { key: 'pending', label: '待報告', align: 'right' },
]
</script>

<template>
  <div class="space-y-4 p-4">
    <div class="flex items-end gap-3">
      <USelect v-model="month" label="月份" :options="months.map((m) => ({ label: monthLabel(m), value: m }))" class="w-40" />
      <div class="pb-2 text-sm text-slate-600">共 <b class="tabular text-slate-800">{{ total }}</b> 人次</div>
    </div>
    <UQueryState :loading="loading && !stats" :ready="!!stats">
      <UBarChart :data="bars" value-labels="nonzero" :title="`${monthLabel(String(month))}各項目服務人次`" unit="人次" :height="220" />
      <UTable :columns="columns" :rows="stats" :row-key="(r) => r.code" dense class="mt-4">
        <template #cell-abnormal="{ row }"><span :class="['tabular', row.abnormal && 'font-semibold text-red-600']">{{ row.abnormal }}</span></template>
        <template #cell-pending="{ row }"><span :class="['tabular', row.pending && 'font-semibold text-amber-700']">{{ row.pending }}</span></template>
      </UTable>
      <p class="mt-2 text-xs text-slate-500">異常率 = 異常需追蹤 ÷（人次 − 待報告）：報告還沒回來的不算進分母。</p>
    </UQueryState>
  </div>
</template>
