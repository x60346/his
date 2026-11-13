<script setup lang="ts">
// 病房常備（藥品庫存，藥師）：各病房的常備品項與基準量（藥劑部與護理部協議的清單）、現有量、最近一次點班。
// 補充在「住院藥局」頁；點班在護理站。這裡只維護清單：基準量改為 0＝移除（櫃子裡還有就不能移除）。
import { computed, reactive, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UQueryState, USearchSelect } from '@/components/ui'
import { masterApi, wardStockApi, type WardStockView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import type { Drug } from '@/types'

const { data: wards, loading } = useQuery(() => wardStockApi.listWardStocks())
const pars = reactive<Record<string, number | undefined>>({})
const key = (w: string, d: string) => `${w}|${d}`
const save = useAction(wardStockApi.saveWardStockItem, { success: (r) => (r ? `已設定基準量 ${r.par}` : '已移除常備品項') })
async function onSave(w: WardStockView, drugId: string) {
  const v = pars[key(w.ward, drugId)]
  if (v === undefined || String(v) === '') return
  if (await save.run(w.ward, drugId, Number(v))) delete pars[key(w.ward, drugId)]
}
// 新增品項
const adding = ref<string>()
const newDrug = ref<Drug | null>(null)
const newPar = ref<number | undefined>(10)
const searchDrugs = (kw: string) => masterApi.listDrugs({ keyword: kw })
async function onAdd(w: WardStockView) {
  if (!newDrug.value || !newPar.value) return
  if (await save.run(w.ward, newDrug.value.id, Number(newPar.value))) {
    adding.value = undefined
    newDrug.value = null
  }
}
const md = (s: string) => s.slice(5, 16).replace('-', '/')
const totalBelow = computed(() => (wards.value ?? []).reduce((n, w) => n + w.rows.filter((r) => r.below).length, 0))
</script>

<template>
  <UQueryState :loading="loading && !wards" :ready="!!wards">
    <p class="mb-3 text-sm text-slate-600">各病房櫃子裡的常備藥：PRN、STAT 給藥從這裡扣；低於基準量的在「住院藥局」頁補充<template v-if="totalBelow">（目前 {{ totalBelow }} 項待補）</template>。護理站每班點班。</p>
    <div class="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr))]">
      <UCard v-for="w in wards" :key="w.ward" :padded="false" class="self-start">
        <template #title><span class="text-sm font-semibold">{{ w.locationName }}</span></template>
        <template #actions>
          <UBadge :tone="w.shift.counted ? 'green' : 'yellow'">{{ w.shift.shift }}{{ w.shift.counted ? '已點班' : '未點班' }}</UBadge>
        </template>
        <ul class="divide-y divide-slate-100 text-sm">
          <li v-for="r in w.rows" :key="r.drugId" class="flex flex-wrap items-center gap-2 px-4 py-1.5">
            <span class="min-w-0 flex-1">
              <span class="font-medium text-slate-800">{{ r.drugName }}</span>
              <UBadge v-if="r.below" tone="yellow" class="ml-1">低於基準</UBadge>
              <span class="block text-xs text-slate-500">現有 {{ r.onHand }} {{ r.unit }}<template v-if="r.onHand !== r.usable">（可用 {{ r.usable }}）</template></span>
            </span>
            <label class="flex items-center gap-1 text-xs text-slate-500">基準
              <input :value="pars[key(w.ward, r.drugId)] ?? r.par" type="number" min="0" step="1" class="form-control w-16 text-right" :aria-label="`${w.locationName} ${r.drugName} 基準量`" @input="pars[key(w.ward, r.drugId)] = Number(($event.target as HTMLInputElement).value)" />
            </label>
            <UButton v-if="pars[key(w.ward, r.drugId)] !== undefined && pars[key(w.ward, r.drugId)] !== r.par" size="sm" variant="secondary" :loading="save.pending.value" @click="onSave(w, r.drugId)">儲存</UButton>
          </li>
        </ul>
        <div class="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
          <template v-if="adding === w.ward">
            <div class="flex flex-wrap items-end gap-2">
              <div class="min-w-48 flex-1"><USearchSelect :search="searchDrugs" :item-key="(d: Drug) => d.id" :item-label="(d: Drug) => d.name" :clear-on-select="false" placeholder="搜尋藥品" @select="(d: Drug) => (newDrug = d)" /></div>
              <input v-model.number="newPar" type="number" min="1" class="form-control w-16 text-right" aria-label="基準量" />
              <UButton size="sm" :disabled="!newDrug" :loading="save.pending.value" @click="onAdd(w)">加入</UButton>
              <UButton size="sm" variant="ghost" @click="adding = undefined">取消</UButton>
            </div>
          </template>
          <template v-else>
            <UButton size="sm" variant="ghost" :icon="Plus" @click="(adding = w.ward), (newDrug = null), (newPar = 10)">新增品項</UButton>
            <span v-if="w.lastCount" class="ml-2">上次點班 {{ md(w.lastCount.at) }} {{ w.lastCount.byName }}{{ w.lastCount.diffs ? `・差異 ${w.lastCount.diffs} 項` : '' }}</span>
          </template>
        </div>
      </UCard>
    </div>
  </UQueryState>
</template>
