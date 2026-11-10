<script setup lang="ts">
// 藥品庫存：摘要卡 → 藥品清單（篩選）→ 右側明細（批號、用量、異動帳）。
// 清單上「可用庫存」「可用天數」「效期」都是服務層依帳本算好的；頁面只負責呈現與篩選條件。
import { computed, ref } from 'vue'
import { AlertTriangle, CalendarClock, PackageX, Pill } from 'lucide-vue-next'
import { UBadge, UCard, UCheckbox, UEmpty, UInput, USelect, UStatCard, UTable, type Column } from '@/components/ui'
import DrugDetail from './components/DrugDetail.vue'
import { inventoryApi, type InventoryRow } from '@/services'
import { useDebounced, useQuery } from '@/composables/useService'

const keyword = ref('')
const kw = useDebounced(keyword)
const category = ref<string | number | undefined>('')
const attentionOnly = ref(false)

const { data: summary } = useQuery(() => inventoryApi.inventorySummary())
const { data: rows, loading } = useQuery(
  () => inventoryApi.listInventory({ keyword: kw.value, category: String(category.value ?? ''), attentionOnly: attentionOnly.value }),
  [kw, category, attentionOnly],
)

const selectedId = ref<string>()
const statusView = { out: { label: '缺貨', tone: 'red' }, low: { label: '偏低', tone: 'yellow' }, ok: { label: '正常', tone: 'green' } } as const

const columns: Column<InventoryRow>[] = [
  { key: 'name', label: '藥品' },
  { key: 'usable', label: '可用庫存', align: 'right', width: '7rem' },
  { key: 'daysLeft', label: '可用天數', align: 'right', width: '5.5rem' },
  { key: 'nearestExpiry', label: '最近效期', width: '7rem' },
  { key: 'status', label: '狀態', width: '5rem' },
]
const categories = ['口服', '外用', '注射', '吸入', '眼用']
const shown = computed(() => rows.value?.length ?? 0)
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <UStatCard label="使用中品項" :value="summary?.total ?? '—'" :icon="Pill" tone="slate" />
      <UStatCard label="缺貨" :value="summary?.out ?? '—'" :icon="PackageX" tone="red" hint="無可用庫存" />
      <UStatCard label="低於安全庫存" :value="summary?.low ?? '—'" :icon="AlertTriangle" tone="amber" />
      <UStatCard label="效期提醒" :value="summary ? `${summary.expiring} / ${summary.expired}` : '—'" :icon="CalendarClock" tone="amber" hint="60 天內到期 / 已過期待報廢" />
    </div>

    <div class="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_32rem]">
      <UCard :padded="false" class="self-start">
        <div class="flex flex-wrap items-end gap-3 border-b border-slate-100 p-3">
          <UInput v-model="keyword" placeholder="藥名、學名、代碼" class="w-56" />
          <USelect v-model="category" :options="[{ label: '全部劑型', value: '' }, ...categories]" class="w-32" />
          <UCheckbox v-model="attentionOnly" label="只看需處理（缺貨、偏低、效期）" class="pb-2" />
          <span class="ml-auto pb-2 text-xs text-slate-500">共 {{ shown }} 項</span>
        </div>
        <UTable
          :columns="columns"
          :rows="rows"
          :row-key="(r) => r.id"
          :loading="loading && !rows"
          :selected-key="selectedId"
          clickable
          dense
          empty-text="沒有符合條件的藥品"
          class="max-h-[calc(100vh-17rem)]"
          @row-click="(r) => (selectedId = r.id)"
        >
          <template #cell-name="{ row }">
            <div class="font-medium text-slate-800">{{ row.name }}<UBadge v-if="row.highAlert" tone="purple" class="ml-1">高警訊</UBadge></div>
            <div class="text-xs text-slate-500">{{ row.id }}・{{ row.spec }}・{{ row.category }}</div>
          </template>
          <template #cell-usable="{ row }">
            <span :class="['tabular font-medium', row.status === 'out' ? 'text-red-600' : row.status === 'low' ? 'text-amber-700' : 'text-slate-800']">{{ row.usable }}</span>
            <span class="text-xs text-slate-400"> {{ row.unit }}</span>
            <div v-if="row.expiredQty" class="text-xs text-red-600">另過期 {{ row.expiredQty }}</div>
          </template>
          <template #cell-daysLeft="{ row }">
            <span :class="['tabular', row.daysLeft !== null && row.daysLeft < 14 && 'font-semibold text-red-600']">{{ row.daysLeft ?? '—' }}</span>
          </template>
          <template #cell-nearestExpiry="{ row }">
            <span :class="['tabular text-xs', row.expiringSoon ? 'font-semibold text-amber-700' : 'text-slate-600']">{{ row.nearestExpiry ?? '—' }}</span>
          </template>
          <template #cell-status="{ row }"><UBadge :tone="statusView[row.status].tone">{{ statusView[row.status].label }}</UBadge></template>
        </UTable>
      </UCard>

      <UCard class="self-start">
        <UEmpty v-if="!selectedId" :icon="Pill" title="請從左側選擇藥品" description="檢視批號、用量趨勢與異動紀錄，並可進貨、盤點" />
        <DrugDetail v-else :drug-id="selectedId" />
      </UCard>
    </div>
  </div>
</template>
