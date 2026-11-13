<script setup lang="ts">
// 病房常備補充（住院藥局）：各病房低於基準量的品項，建議補到基準量；按「補充」從住院藥局扣、進病房常備（一步完成，跟著藥車送）。
// 送錯、短少由病房每班點班抓出來。
import { computed, reactive, ref, watch } from 'vue'
import { PackagePlus } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UEmpty } from '@/components/ui'
import { wardStockApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data: wards } = useQuery(() => wardStockApi.listWardStocks())
const needs = computed(() => (wards.value ?? []).map((w) => ({ ...w, rows: w.rows.filter((r) => r.below) })).filter((w) => w.rows.length))
const qty = reactive<Record<string, number | undefined>>({})
watch(needs, (ns) => {
  for (const w of ns) for (const r of w.rows) qty[`${w.ward}|${r.drugId}`] = r.par - r.usable
}, { immediate: true })
const refill = useAction(wardStockApi.refillWard, { success: (r) => `已補充 ${r.no}：${r.lines} 項` })
// 欄位錯誤只屬於剛送出的那個病房（不同病房可能有同一種藥）
const lastWard = ref('')
const err = (ward: string, drugId: string) => (lastWard.value === ward ? refill.fieldErrors.value[`qty.${drugId}`] : undefined)
async function onRefill(w: (typeof needs.value)[number]) {
  lastWard.value = w.ward
  await refill.run(w.ward, w.rows.map((r) => ({ drugId: r.drugId, qty: Number(qty[`${w.ward}|${r.drugId}`] ?? 0) })))
}
</script>

<template>
  <UCard :padded="false" :class="needs.length ? 'border-violet-300' : ''">
    <template #title>
      <div class="flex items-center gap-2 text-sm font-semibold text-slate-800"><PackagePlus class="h-4 w-4 text-violet-600" />病房常備補充<UBadge v-if="needs.length" tone="purple">{{ needs.reduce((n, w) => n + w.rows.length, 0) }} 項</UBadge></div>
      <div class="text-xs text-slate-500">低於基準量的補到基準量：從住院藥局扣、進病房常備（跟著藥車送，病房點班會核對）</div>
    </template>
    <UEmpty v-if="!needs.length" title="各病房常備都在基準量以上" class="py-6" />
    <div v-for="w in needs" :key="w.ward" class="border-t border-slate-100 px-4 py-2">
      <div class="mb-1 flex items-center gap-2 text-sm">
        <span class="font-semibold text-slate-700">{{ w.locationName }}</span>
        <UButton size="sm" class="ml-auto" :loading="refill.pending.value" @click="onRefill(w)">補充</UButton>
      </div>
      <ul class="space-y-1 text-sm">
        <li v-for="r in w.rows" :key="r.drugId" class="flex flex-wrap items-center gap-2">
          <span class="min-w-0 flex-1">{{ r.drugName }} <span class="text-xs text-slate-500">現有 {{ r.usable }}／基準 {{ r.par }} {{ r.unit }}</span></span>
          <input v-model.number="qty[`${w.ward}|${r.drugId}`]" type="number" min="0" step="1" class="form-control w-20 text-right" :aria-label="`${w.locationName} ${r.drugName} 補充數量`" />
          <span v-if="err(w.ward, r.drugId)" class="w-full text-right text-xs text-red-600">{{ err(w.ward, r.drugId) }}</span>
        </li>
      </ul>
    </div>
  </UCard>
</template>
