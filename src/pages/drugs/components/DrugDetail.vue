<script setup lang="ts">
// 藥品庫存明細：批號（含盤點）、近 30 天用量、異動紀錄。
// 異動紀錄就是「庫存為什麼是這個數字」的答案：每一筆增減都查得到時間、人、單據、原因。
import { computed, ref } from 'vue'
import { PackagePlus, Trash2 } from 'lucide-vue-next'
import { UBadge, UBarChart, UButton, UQueryState, type BarDatum } from '@/components/ui'
import ReceiveStockDialog from '@/components/ReceiveStockDialog.vue'
import StocktakeDialog from './StocktakeDialog.vue'
import { inventoryApi, isExpiringSoon } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import { today } from '@/utils/date'
import type { DrugLot, StockTxnType } from '@/types'

const props = defineProps<{ drugId: string }>()
const ui = useUi()

const { data, loading } = useQuery(
  async () => {
    const id = props.drugId
    return { id, ledger: await inventoryApi.getDrugLedger(id) }
  },
  [() => props.drugId],
)
const ledger = computed(() => (data.value?.id === props.drugId ? data.value.ledger : undefined))
const row = computed(() => ledger.value?.row)

const bars = computed<BarDatum[]>(() => (ledger.value?.daily ?? []).map((d) => ({ label: d.date.slice(8), value: d.qty, title: d.date })))

const typeView: Record<StockTxnType, { label: string; tone: 'gray' | 'green' | 'blue' | 'yellow' }> = {
  opening: { label: '期初', tone: 'gray' },
  receive: { label: '進貨', tone: 'green' },
  dispense: { label: '發藥', tone: 'blue' },
  adjust: { label: '盤點調整', tone: 'yellow' },
}
const lotState = (l: DrugLot) => (l.expiry < today() ? { label: '已過期', tone: 'red' as const } : isExpiringSoon(l.expiry, today()) ? { label: '即將到期', tone: 'yellow' as const } : null)

const receiveOpen = ref(false)
const takeOpen = ref(false)
const takeLot = ref<DrugLot>()
function startTake(l: DrugLot) {
  takeLot.value = l
  takeOpen.value = true
}

const scrap = useAction(inventoryApi.scrapExpired, { success: (t) => `已報廢 ${t.length} 個過期批號` })
async function onScrap() {
  if (!row.value) return
  const ok = await ui.confirm({ title: '報廢過期藥品', message: `${row.value.name} 已過期 ${row.value.expiredQty} ${row.value.unit}，確定報廢？\n報廢會寫入盤點調整紀錄。`, okText: '報廢', danger: true })
  if (ok) scrap.run(row.value.id)
}
</script>

<template>
  <UQueryState :loading="loading && !ledger" :ready="!!ledger">
    <div v-if="ledger && row" class="space-y-4">
      <header class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h2 class="flex flex-wrap items-center gap-2 text-lg font-bold text-slate-800">
            {{ row.name }}<UBadge v-if="row.highAlert" tone="purple">高警訊</UBadge>
          </h2>
          <p class="text-xs text-slate-500">{{ row.id }}・{{ row.generic }}・{{ row.spec }}・{{ row.category }}</p>
        </div>
        <UButton size="sm" :icon="PackagePlus" @click="receiveOpen = true">進貨</UButton>
      </header>

      <dl class="grid grid-cols-3 gap-2 text-center">
        <div class="rounded-md bg-slate-50 p-2">
          <dt class="text-xs text-slate-500">可用庫存</dt>
          <dd :class="['tabular text-xl font-semibold', row.status === 'out' ? 'text-red-600' : row.status === 'low' ? 'text-amber-700' : 'text-slate-800']">{{ row.usable }}</dd>
          <dd class="text-xs text-slate-400">安全庫存 {{ row.safetyStock }} {{ row.unit }}</dd>
        </div>
        <div class="rounded-md bg-slate-50 p-2">
          <dt class="text-xs text-slate-500">近 30 天用量</dt>
          <dd class="tabular text-xl font-semibold text-slate-800">{{ row.used30 }}</dd>
          <dd class="text-xs text-slate-400">日均 {{ (row.used30 / 30).toFixed(1) }}</dd>
        </div>
        <div class="rounded-md bg-slate-50 p-2">
          <dt class="text-xs text-slate-500">預估可用</dt>
          <dd :class="['tabular text-xl font-semibold', row.daysLeft !== null && row.daysLeft < 14 ? 'text-red-600' : 'text-slate-800']">{{ row.daysLeft ?? '—' }}</dd>
          <dd class="text-xs text-slate-400">{{ row.daysLeft === null ? '近期無用量' : '天' }}</dd>
        </div>
      </dl>

      <!-- 批號 -->
      <section>
        <div class="mb-2 flex items-center">
          <h3 class="text-sm font-semibold text-slate-700">批號（發藥依效期先後扣除）</h3>
          <UButton v-if="row.expiredQty" class="ml-auto" size="sm" variant="danger" :icon="Trash2" :loading="scrap.pending.value" @click="onScrap">報廢過期 {{ row.expiredQty }}</UButton>
        </div>
        <p v-if="!ledger.lots.length" class="text-sm text-slate-400">目前沒有庫存批號</p>
        <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
          <li v-for="l in ledger.lots" :key="l.id" :class="['flex items-center gap-3 px-3 py-2 text-sm', l.expiry < today() && 'bg-red-50/60']">
            <span class="tabular w-24 font-medium text-slate-800">{{ l.lotNo }}</span>
            <span class="tabular text-slate-600">效期 {{ l.expiry }}</span>
            <UBadge v-if="lotState(l)" :tone="lotState(l)!.tone">{{ lotState(l)!.label }}</UBadge>
            <span class="tabular ml-auto font-medium text-slate-800">{{ l.qty }} {{ row.unit }}</span>
            <UButton size="sm" variant="secondary" @click="startTake(l)">盤點</UButton>
          </li>
        </ul>
      </section>

      <!-- 用量 -->
      <section>
        <UBarChart :data="bars" title="近 30 天每日發藥量" :unit="row.unit" :height="150" />
      </section>

      <!-- 異動紀錄 -->
      <section>
        <h3 class="mb-2 text-sm font-semibold text-slate-700">異動紀錄（最近 {{ ledger.txns.length }} 筆）</h3>
        <div class="max-h-80 overflow-y-auto rounded-md border border-slate-200">
          <table class="w-full text-sm">
            <thead class="sticky top-0 bg-slate-50 text-xs text-slate-500">
              <tr><th class="px-3 py-1.5 text-left font-medium">時間</th><th class="px-2 text-left font-medium">類別</th><th class="px-2 text-left font-medium">說明</th><th class="px-2 text-right font-medium">增減</th><th class="px-3 text-right font-medium">結存</th></tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="t in ledger.txns" :key="t.id">
                <td class="tabular whitespace-nowrap px-3 py-1.5 text-xs text-slate-500">{{ t.at.slice(5) }}</td>
                <td class="px-2"><UBadge :tone="typeView[t.type].tone">{{ typeView[t.type].label }}</UBadge></td>
                <td class="px-2 text-xs text-slate-600">
                  {{ t.ref ?? t.reason ?? '' }}<template v-if="t.ref && t.reason">・{{ t.reason }}</template>
                  <span class="text-slate-400">（{{ t.lots.map((l) => l.lotNo).join('、') }}・{{ t.userName }}）</span>
                </td>
                <td :class="['tabular px-2 text-right font-medium', t.qty > 0 ? 'text-emerald-700' : 'text-slate-700']">{{ t.qty > 0 ? '+' : '' }}{{ t.qty }}</td>
                <td class="tabular px-3 text-right text-slate-800">{{ t.balance }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <ReceiveStockDialog v-model="receiveOpen" :drug-id="row.id" :drug-name="row.name" :unit="row.unit" :usable="row.usable" />
      <StocktakeDialog v-model="takeOpen" :lot="takeLot" :drug-name="row.name" :unit="row.unit" />
    </div>
  </UQueryState>
</template>
