<script setup lang="ts">
// 藥品庫存：摘要卡 → 藥品清單（篩選）→ 右側明細（批號、用量、異動帳）。
// 清單上「可用庫存」「可用天數」「效期」都是服務層依帳本算好的；頁面只負責呈現與篩選條件。
// 大型醫院有多個庫存地點（藥庫、門診藥局…）：頂端選「目前地點」，摘要、清單、明細、進貨、報廢都是那個地點的。
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { AlertTriangle, CalendarClock, PackageX, Pill, Truck, X } from 'lucide-vue-next'
import type { StockFlag } from '@/services/stock-rules'
import { UBadge, UCard, UCheckbox, UEmpty, UInput, USelect, UStatCard, UTable, UTabs, type Column } from '@/components/ui'
import DrugDetail from './components/DrugDetail.vue'
import StocktakePanel from './components/StocktakePanel.vue'
import PurchasePanel from './components/PurchasePanel.vue'
import SupplierPanel from './components/SupplierPanel.vue'
import LocationPanel from './components/LocationPanel.vue'
import QuarantinePanel from './components/QuarantinePanel.vue'
import WardStockAdminPanel from './components/WardStockAdminPanel.vue'
import ControlledLedgerPanel from './components/ControlledLedgerPanel.vue'
import TransferPanel from './components/TransferPanel.vue'
import { inventoryApi, type InventoryRow } from '@/services'
import { useDebounced, useQuery } from '@/composables/useService'
import { useWorkLocation } from '@/composables/useWorkLocation'

const work = useWorkLocation()
// 庫存／採購單／盤點單（首頁待辦帶 ?tab=purchase、?tab=stocktake 進來直接看）
const route0 = useRoute()
const view = ref(['stocktake', 'purchase', 'transfer', 'supplier', 'location', 'quarantine', 'ward', 'controlled'].includes(String(route0.query.tab)) ? String(route0.query.tab) : 'stock')
// 撥補單只有大型醫院（多個地點）才有
const viewTabs = computed(() => [
  { key: 'stock', label: '庫存' },
  ...(work.multi.value ? [{ key: 'transfer', label: '撥補單' }, { key: 'quarantine', label: '待報廢區' }] : []),
  { key: 'purchase', label: '採購單' },
  { key: 'supplier', label: '供應商' },
  { key: 'stocktake', label: '盤點單' },
  { key: 'ward', label: '病房常備' },
  { key: 'controlled', label: '管制藥簿冊' },
  { key: 'location', label: '庫存地點' },
])

const keyword = ref('')
const kw = useDebounced(keyword)
const category = ref<string | number | undefined>('')
const attentionOnly = ref(false)

// 摘要卡片點了直接篩選（再點一次、或點「使用中品項」取消）
// 「待到貨」不是庫存標籤（是已經在處理的事），另走 restockOnly；有病人在等的排前面
const cardFilters = {
  out: { label: '缺貨', flags: ['out'] },
  low: { label: '低於安全庫存', flags: ['low'] },
  expiry: { label: '效期提醒', flags: ['expiring', 'expired'] },
  restock: { label: '補貨待到貨', flags: [] },
  // 沒有卡片、只從首頁待辦連過來：「缺貨或低於安全庫存」（首頁的數字＝缺貨＋偏低，點進來看到的要是同一批）
  short: { label: '缺貨或低於安全庫存', flags: ['out', 'low'] },
} as const satisfies Record<string, { label: string; flags: StockFlag[] }>
type CardKey = keyof typeof cardFilters
// 首頁待辦「補貨申請待到貨」帶 ?filter=restock 進來，直接篩好
const route = useRoute()
const cardFilter = ref<CardKey | null>(route.query.filter === 'restock' || route.query.filter === 'short' ? route.query.filter : null)
const toggleCard = (k: CardKey | null) => (cardFilter.value = cardFilter.value === k ? null : k)

const { data: summary } = useQuery(() => inventoryApi.inventorySummary(work.locationId.value || undefined), [work.locationId])
const { data: rows, loading } = useQuery(
  () =>
    inventoryApi.listInventory({
      locationId: work.locationId.value || undefined,
      keyword: kw.value,
      category: String(category.value ?? ''),
      attentionOnly: attentionOnly.value,
      flags: cardFilter.value ? [...cardFilters[cardFilter.value].flags] : undefined,
      restockOnly: cardFilter.value === 'restock',
    }),
  [kw, category, attentionOnly, cardFilter, work.locationId],
)

const selectedId = ref<string>()
useRevealOnNarrow(selectedId, 1280) // 窄螢幕點選後把明細捲進畫面
// 狀態標籤：服務層算好的 flags（可同時多項），空陣列顯示「正常」
const flagView = { out: { label: '缺貨', tone: 'red' }, low: { label: '偏低', tone: 'yellow' }, expired: { label: '待報廢', tone: 'red' }, expiring: { label: '近效期', tone: 'yellow' } } as const

const columns: Column<InventoryRow>[] = [
  { key: 'name', label: '藥品' },
  { key: 'usable', label: '可用庫存', align: 'right', width: '7rem' },
  { key: 'daysLeft', label: '可用天數', align: 'right', width: '5.5rem' },
  { key: 'nearestExpiry', label: '最近效期', width: '7rem' },
  { key: 'status', label: '狀態', width: '6.5rem' },
]
const categories = ['口服', '外用', '注射', '吸入', '眼用']
const shown = computed(() => rows.value?.length ?? 0)
</script>

<template>
  <div class="space-y-4">
    <!-- 多個地點才有選單：小型醫院只有一個藥局，不用選 -->
    <div v-if="work.multi.value" class="flex flex-wrap items-end gap-3">
      <div class="w-60">
        <USelect :model-value="work.locationId.value" label="目前地點" :options="work.locations.value.map((l) => ({ label: `${l.name}${l.dispensesOpd ? '（門診發藥）' : l.receivesPurchase ? '（採購入庫）' : ''}`, value: l.id }))" @update:model-value="work.select" />
      </div>
      <p class="pb-2 text-xs text-slate-500">下方的庫存、批號、進貨、報廢都是「{{ work.location.value?.name }}」的；醫師開藥看到的可用量是「{{ work.locations.value.find((l) => l.dispensesOpd)?.name }}」（負責門診發藥）的。</p>
    </div>
    <UTabs v-model="view" :tabs="viewTabs" />
    <TransferPanel v-if="view === 'transfer' && work.multi.value" :location-id="work.locationId.value" :location-name="work.location.value?.name" :is-pharmacy="work.location.value?.kind === 'pharmacy'" />
    <PurchasePanel v-else-if="view === 'purchase'" />
    <SupplierPanel v-else-if="view === 'supplier'" />
    <LocationPanel v-else-if="view === 'location'" />
    <QuarantinePanel v-else-if="view === 'quarantine' && work.multi.value" />
    <WardStockAdminPanel v-else-if="view === 'ward'" />
    <ControlledLedgerPanel v-else-if="view === 'controlled'" />
    <StocktakePanel v-else-if="view === 'stocktake'" :location-id="work.locationId.value" :location-name="work.location.value?.name" />
    <template v-else>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
      <UStatCard label="使用中品項" :value="summary?.total ?? '—'" :icon="Pill" tone="slate" :on-click="() => (cardFilter = null)" />
      <UStatCard label="缺貨" :value="summary?.out ?? '—'" :icon="PackageX" tone="red" hint="無可用庫存" :active="cardFilter === 'out'" :on-click="() => toggleCard('out')" />
      <UStatCard label="低於安全庫存" :value="summary?.low ?? '—'" :icon="AlertTriangle" tone="amber" :active="cardFilter === 'low'" :on-click="() => toggleCard('low')" />
      <UStatCard label="效期提醒" :value="summary ? `${summary.expiring} / ${summary.expired}` : '—'" :icon="CalendarClock" tone="amber" hint="60 天內到期 / 已過期待報廢" :active="cardFilter === 'expiry'" :on-click="() => toggleCard('expiry')" />
      <UStatCard label="補貨待到貨" :value="summary?.restockOpen ?? '—'" :icon="Truck" tone="brand" hint="已申請、還沒到貨入庫" :active="cardFilter === 'restock'" :on-click="() => toggleCard('restock')" />
    </div>

    <div class="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_32rem]">
      <UCard :padded="false" class="self-start">
        <div class="flex flex-wrap items-end gap-3 border-b border-slate-100 p-3">
          <div class="w-64"><UInput v-model="keyword" placeholder="藥名、中文名、作用、代碼" /></div>
          <USelect v-model="category" :options="[{ label: '全部劑型', value: '' }, ...categories]" class="w-32" />
          <UCheckbox v-model="attentionOnly" label="只看需處理（缺貨、偏低、效期）" class="pb-2" />
          <span class="ml-auto flex items-center gap-2 pb-2 text-xs text-slate-500">
            <button v-if="cardFilter" type="button" class="flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-brand-700 hover:bg-brand-100" :aria-label="`取消篩選：${cardFilters[cardFilter].label}`" @click="cardFilter = null">
              篩選：{{ cardFilters[cardFilter].label }}<X class="h-3 w-3" />
            </button>
            共 {{ shown }} 項
          </span>
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
            <div class="font-medium text-slate-800">{{ row.name }}<UBadge v-if="row.highAlert" tone="purple" class="ml-1">高警訊</UBadge><UBadge v-if="row.controlled" tone="red" class="ml-1">管制 {{ row.controlled }} 級</UBadge></div>
            <div class="text-xs text-slate-500">{{ row.nameZh }}・{{ row.id }}・{{ row.spec }}・{{ row.category }}</div>
          </template>
          <template #cell-usable="{ row }">
            <span v-if="row.counting" class="text-xs text-violet-700">盤點中</span>
            <span v-else :class="['tabular font-medium', row.status === 'out' ? 'text-red-600' : row.status === 'low' ? 'text-amber-700' : 'text-slate-800']">{{ row.usable }}</span>
            <span v-if="!row.counting" class="text-xs text-slate-400"> {{ row.unit }}</span>
            <div v-if="row.expiredQty" class="text-xs text-red-600">另過期 {{ row.expiredQty }}</div>
            <div v-if="row.inTransit" class="text-xs text-sky-700">運送中 {{ row.inTransit }}</div>
          </template>
          <template #cell-daysLeft="{ row }">
            <span :class="['tabular', row.daysLeft !== null && row.daysLeft < 14 && 'font-semibold text-red-600']">{{ row.daysLeft ?? '—' }}</span>
          </template>
          <template #cell-nearestExpiry="{ row }">
            <span :class="['tabular text-xs', row.expiringSoon ? 'font-semibold text-amber-700' : 'text-slate-600']">{{ row.nearestExpiry ?? '—' }}</span>
          </template>
          <template #cell-status="{ row }">
            <div class="flex flex-wrap gap-1">
              <UBadge v-for="f in row.flags" :key="f" :tone="flagView[f].tone">{{ flagView[f].label }}</UBadge>
              <UBadge v-if="row.counting" tone="purple" :title="`盤點單 ${row.counting}`">盤點中</UBadge>
              <UBadge v-else-if="!row.flags.length && !row.restock" tone="green">正常</UBadge>
              <UBadge v-if="row.restock" tone="blue" :title="`補貨申請尚欠 ${row.restock.outstanding}`">待到貨{{ row.restock.waiting ? `・${row.restock.waiting} 人等` : '' }}</UBadge>
            </div>
          </template>
        </UTable>
      </UCard>

      <UCard data-detail class="self-start">
        <UEmpty v-if="!selectedId" :icon="Pill" title="請從清單選擇藥品" description="檢視批號、用量趨勢與異動紀錄，並可進貨、盤點" />
        <DrugDetail v-else :drug-id="selectedId" :location-id="work.locationId.value" :location-name="work.multi.value ? work.location.value?.name : undefined" />
      </UCard>
    </div>
    </template>
  </div>
</template>
