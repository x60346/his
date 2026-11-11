<script setup lang="ts">
// 門診藥局：調劑清單（依領藥號）→ 調劑單 → 核對 → 發藥；可補貨、列印藥袋。
// 兩段式（核對、發藥）是用藥安全的標準流程；扣庫存只在發藥時發生，且整筆交易（任一藥不足就全部不扣）。
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { computed, ref, watch } from 'vue'
import { AlertTriangle, CheckCheck, ClipboardCheck, PackagePlus, Printer } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UDialog, UEmpty, UInput, UQueryState, UStatusBadge, UTabs } from '@/components/ui'
import PatientBanner from '@/components/PatientBanner.vue'
import DrugBagLabels from './components/DrugBagLabels.vue'
import ReceiveStockDialog from '@/components/ReceiveStockDialog.vue'
import { pharmacyApi } from '@/services'
import type { DispenseItem } from '@/services/pharmacy'
import { useAction, useQuery } from '@/composables/useService'
import { followToday } from '@/composables/useClock'
import { diffDays, today } from '@/utils/date'
import { dispenseStatus } from '@/utils/labels'
import type { DispenseStatus } from '@/types'

// ---------- 清單 ----------
const date = ref(today())
const todayStr = followToday(date) // 原本看今天的，跨日時自動換到新的一天
const { data: all, loading } = useQuery(() => pharmacyApi.listDispenses({ date: date.value }), [date])
const tab = ref<DispenseStatus>('pending')
const tabs = computed(() =>
  (['pending', 'verified', 'dispensed'] as DispenseStatus[]).map((s) => ({ key: s, label: dispenseStatus[s].label, count: (all.value ?? []).filter((d) => d.status === s).length })),
)
const list = computed(() => (all.value ?? []).filter((d) => d.status === tab.value))
// 前幾日開立、還沒領的單（服務層排在當天的後面）。領藥號每天重編，要標日期才分得出是哪一天的「3 號」
const createdDay = (x: { createdAt: string }) => x.createdAt.slice(0, 10)
const isCarried = (x: { createdAt: string; status: DispenseStatus }) => x.status !== 'dispensed' && createdDay(x) < date.value
/** 一般處方箋 3 日內有效：滿 3 天提醒（不擋，是否需重新看診由藥師判斷） */
const ageDays = (x: { createdAt: string }) => diffDays(createdDay(x), todayStr.value)

const selectedId = ref<string>()
useRevealOnNarrow(selectedId) // 窄螢幕點選後把明細捲進畫面
watch(date, () => (selectedId.value = undefined))

// 右側以 id 直接查最新的調劑單（不依賴清單上可能過期的狀態）
const { data: detail, loading: detailLoading } = useQuery(async () => (selectedId.value ? pharmacyApi.getDispense(selectedId.value) : undefined), [selectedId])
const d = computed(() => (detail.value?.id === selectedId.value ? detail.value : undefined))
const shortages = computed(() => (d.value?.items ?? []).filter((i) => i.shortage))

// 分頁跟著「選中那張單」的狀態走：核對後它移到「已核對」、發藥後移到「已發藥」，分頁就跟過去，
// 右邊顯示的病人一定找得到在左邊哪個清單。使用者自己切分頁時，單的狀態沒變，不會被拉回來。
watch(
  () => d.value?.status,
  (s) => {
    if (s) tab.value = s
  },
)

// ---------- 核對、發藥 ----------
const verify = useAction(pharmacyApi.verifyDispense, { success: (x) => `領藥號 ${x.pickupNo} 核對完成` })
const give = useAction(pharmacyApi.dispense, { success: (x) => `領藥號 ${x.pickupNo} 已發藥給 ${x.patientName}` })

/** 下一張待處理的單：發藥後自動帶到下一位，減少點擊 */
const nextPending = computed(() => (all.value ?? []).find((x) => x.status !== 'dispensed' && x.id !== selectedId.value))
async function onDispense() {
  if (!d.value) return
  if (await give.run(d.value.id)) {
    // 自動帶到下一張；分頁由上面的 watch 跟著那張單的狀態切換
    if (nextPending.value) selectedId.value = nextPending.value.id
  }
}

// ---------- 補貨 ----------
const restockOpen = ref(false)
const restockItem = ref<DispenseItem>()
function openRestock(it: DispenseItem) {
  restockItem.value = it
  restockOpen.value = true
}

// ---------- 藥袋 ----------
const bagOpen = ref(false)
const print = () => window.print()
</script>

<template>
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-[21rem_1fr]">
    <!-- 清單 -->
    <UCard :padded="false" class="no-print self-start">
      <template #title><span class="text-sm font-semibold text-slate-800">調劑清單</span></template>
      <template #actions><div class="w-40"><UInput v-model="date" type="date" :max="todayStr" /></div></template>
      <div class="px-3"><UTabs v-model="tab" :tabs="tabs" /></div>
      <UQueryState :loading="loading" :ready="list.length > 0" :empty-title="`沒有${dispenseStatus[tab].label}的單`">
      <ul class="max-h-[calc(100vh-15rem)] divide-y divide-slate-100 overflow-y-auto">
        <li v-for="(x, i) in list" :key="x.id">
          <div v-if="isCarried(x) && (i === 0 || !isCarried(list[i - 1]))" class="bg-slate-50 px-3 py-1 text-xs font-medium text-slate-500">前幾日未領</div>
          <button :class="['flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50', x.id === selectedId && '!bg-brand-50']" @click="selectedId = x.id">
            <span class="tabular w-10 text-center leading-tight">
              <span v-if="createdDay(x) !== date" class="block text-[11px] font-medium text-slate-500">{{ createdDay(x).slice(5).replace('-', '/') }}</span>
              <span class="text-2xl font-bold text-brand-600">{{ x.pickupNo }}</span>
            </span>
            <span class="min-w-0 flex-1">
              <span class="block font-medium text-slate-800">{{ x.patientName }}</span>
              <span class="block truncate text-xs text-slate-500">{{ x.deptName }}・{{ x.items.length }} 項藥品</span>
              <UBadge v-if="x.status !== 'dispensed' && ageDays(x) >= 3" tone="yellow" class="mt-0.5">已開立 {{ ageDays(x) }} 天</UBadge>
            </span>
            <span class="flex flex-col items-end gap-1">
              <AlertTriangle v-if="x.allergyWarnings.length" class="h-4 w-4 text-red-500" aria-label="過敏警示" />
              <UBadge v-if="x.items.some((i) => i.shortage)" tone="red">缺藥</UBadge>
            </span>
          </button>
        </li>
      </ul>
      </UQueryState>
    </UCard>

    <!-- 調劑單 -->
    <UCard v-if="!selectedId" data-detail class="no-print"><UEmpty title="請從清單選擇調劑單" description="依領藥號順序處理" /></UCard>
    <UCard v-else-if="!d" data-detail class="no-print"><UQueryState :loading="detailLoading" :ready="false" empty-title="找不到這張調劑單" /></UCard>
    <div v-else data-detail class="no-print min-w-0 space-y-3">
      <PatientBanner :patient="d">
        <UBadge tone="blue">領藥號 {{ createdDay(d) !== todayStr ? createdDay(d).slice(5).replace('-', '/') + '・' : '' }}{{ d.pickupNo }}</UBadge>
        <UStatusBadge :map="dispenseStatus" :value="d.status" />
      </PatientBanner>

      <!-- 多重把關：醫師開藥時已提醒過，藥師這一關再顯示一次 -->
      <div v-if="d.allergyWarnings.length" class="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div class="font-semibold">過敏警示：請確認醫師已評估後再調劑</div>
          <div v-for="w in d.allergyWarnings" :key="w.drugId">{{ w.drugName }}：病人對 {{ w.allergen }} 過敏</div>
        </div>
      </div>

      <UCard :padded="false">
        <template #title>
          <div class="text-sm font-semibold text-slate-800">處方內容</div>
          <div class="text-xs text-slate-500">{{ d.deptName }}・{{ d.doctorName }}｜診斷：{{ d.diagnoses.join('、') }}</div>
        </template>
        <table class="tabular w-full text-sm">
          <thead class="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th class="px-4 py-2 text-left">藥品</th>
              <th class="px-3 py-2 text-left">用法</th>
              <th class="px-3 py-2 text-right">天數</th>
              <th class="px-3 py-2 text-right">總量</th>
              <th class="px-3 py-2 text-right">庫存</th>
              <th class="w-24 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in d.items" :key="it.drugId" :class="['border-t border-slate-100', it.shortage && 'bg-red-50']">
              <td class="px-4 py-2">
                <div class="font-medium text-slate-800">{{ it.drugName }}</div>
                <div class="flex items-center gap-1 text-xs text-slate-500">{{ it.spec }}<UBadge v-if="it.highAlert" tone="purple">高警訊</UBadge></div>
              </td>
              <td class="px-3 py-2 text-slate-700">{{ it.dose }} {{ it.doseUnit }}・{{ it.freq }}・{{ it.route }}</td>
              <td class="px-3 py-2 text-right">{{ it.days }}</td>
              <td class="px-3 py-2 text-right font-semibold">{{ it.qty }}</td>
              <td :class="['px-3 py-2 text-right', it.shortage ? 'font-semibold text-red-600' : 'text-slate-500']">
                {{ it.stock }}<div v-if="it.shortage" class="text-xs">缺 {{ it.qty - it.stock }}</div>
              </td>
              <td class="px-3 py-2 text-right">
                <UButton v-if="it.shortage" size="sm" variant="secondary" :icon="PackagePlus" @click="openRestock(it)">補貨</UButton>
              </td>
            </tr>
          </tbody>
        </table>
      </UCard>

      <!-- 錯誤訊息不只說「錯了」，也告訴使用者下一步 -->
      <div v-if="shortages.length && d.status !== 'dispensed'" class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
        {{ shortages.map((s) => s.drugName).join('、') }} 庫存不足，無法{{ d.status === 'pending' ? '核對' : '發藥' }}。請先按該列的「補貨」，或聯絡醫師更換藥品。
      </div>

      <div class="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3">
        <span class="text-xs text-slate-500">
          <template v-if="d.verifiedAt">核對：{{ d.verifiedAt.slice(11) }}　</template>
          <template v-if="d.dispensedAt">發藥：{{ d.dispensedAt.slice(11) }}</template>
        </span>
        <div class="ml-auto flex gap-2">
          <UButton variant="secondary" :icon="Printer" @click="bagOpen = true">藥袋</UButton>
          <UButton v-if="d.status === 'pending'" :icon="ClipboardCheck" :disabled="shortages.length > 0" :loading="verify.pending.value" @click="verify.run(d.id)">核對處方</UButton>
          <UButton v-if="d.status === 'verified'" variant="success" :icon="CheckCheck" :disabled="shortages.length > 0" :loading="give.pending.value" @click="onDispense">發藥</UButton>
        </div>
      </div>
    </div>

    <!-- 補貨＝進貨，與藥品庫存頁共用同一個對話框（要有批號、效期）；預設補到「本次需求 + 500」 -->
    <ReceiveStockDialog
      v-model="restockOpen"
      :drug-id="restockItem?.drugId"
      :drug-name="restockItem?.drugName"
      :unit="restockItem?.unit"
      :usable="restockItem?.stock"
      :suggested-qty="restockItem ? restockItem.qty - restockItem.stock + 500 : undefined"
    />

    <UDialog v-model="bagOpen" title="藥袋預覽" size="lg">
      <DrugBagLabels v-if="d" :d="d" />
      <template #footer>
        <UButton variant="secondary" @click="bagOpen = false">關閉</UButton>
        <UButton :icon="Printer" @click="print">列印</UButton>
      </template>
    </UDialog>
  </div>
</template>
