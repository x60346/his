<script setup lang="ts">
// 病房常備（藥品庫存，藥師）：各病房的常備品項與基準量（藥劑部與護理部協議的清單）、現有量、最近一次點班。
// 補充在「住院藥局」頁；點班在護理站。這裡只維護清單：基準量改為 0＝移除（櫃子裡還有就不能移除）。
import { computed, reactive, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UQueryState, USearchSelect } from '@/components/ui'
import { masterApi, wardStockApi, witnessApi, type WardStockView } from '@/services'
import WitnessDialog from '@/components/WitnessDialog.vue'
import { useAction, useQuery } from '@/composables/useService'
import type { Drug } from '@/types'

const { data: wards, loading } = useQuery(() => wardStockApi.listWardStocks())
// '' ＝正在改、欄位清空了（不能當 0：基準量 0 是「移除品項」）
const pars = reactive<Record<string, number | '' | undefined>>({})
const key = (w: string, d: string) => `${w}|${d}`
// 效期收回：有管制藥要病房護理師或另一位藥師當場見證（服務層 returnWardExpiry 沒有見證就擋）
const retWard = ref<{ ward: string; name: string; lotIds: string[]; ctrl: string }>()
const witnessOpen = ref(false)
const approveFn = (cred: { username: string; password: string }) => witnessApi.approveWitness({ purpose: 'wardReturn', ward: retWard.value!.ward, ...cred })
function startReturn(w: { ward: string; locationName: string; expiryLots: { lotId: string; drugName: string; lotNo: string; qty: number; controlled?: number }[] }) {
  const ctrl = w.expiryLots.filter((x) => x.controlled)
  retWard.value = { ward: w.ward, name: w.locationName, lotIds: w.expiryLots.map((x) => x.lotId), ctrl: ctrl.map((x) => `${x.drugName} ${x.lotNo} ${x.qty}`).join('、') }
  if (ctrl.length) witnessOpen.value = true
  else ret.run(w.ward, retWard.value.lotIds)
}
function onWitnessed(token: string) {
  if (retWard.value) ret.run(retWard.value.ward, retWard.value.lotIds, { witness: token })
}
const ret = useAction(wardStockApi.returnWardExpiry, { success: (r) => `已收回 ${r.lots} 批、${r.qty} 個到住院藥局（${r.no}）：照報廢流程處理` })
const save = useAction(wardStockApi.saveWardStockItem, { success: (r) => (r ? `已設定基準量 ${r.par}` : '已移除常備品項') })
async function onSave(w: WardStockView, drugId: string) {
  const v = pars[key(w.ward, drugId)]
  if (v === undefined || v === '') return
  // 移除品項回傳 null（成功），失敗才是 undefined
  if ((await save.run(w.ward, drugId, Number(v))) !== undefined) delete pars[key(w.ward, drugId)]
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
            <span class="min-w-0 flex-[1_1_10rem]">
              <span class="font-medium text-slate-800">{{ r.drugName }}</span>
              <UBadge v-if="r.controlled" tone="red" class="ml-1">管制 {{ r.controlled }} 級</UBadge>
              <UBadge v-if="r.below" tone="yellow" class="ml-1">低於基準</UBadge>
              <span class="block text-xs text-slate-500">現有 {{ r.onHand }} {{ r.unit }}<template v-if="r.onHand !== r.usable">（可用 {{ r.usable }}）</template></span>
            </span>
            <label class="flex items-center gap-1 text-xs text-slate-500">基準
              <input :value="pars[key(w.ward, r.drugId)] ?? r.par" type="number" min="0" step="1" class="form-control w-16 text-right" :aria-label="`${w.locationName} ${r.drugName} 基準量`" @input="pars[key(w.ward, r.drugId)] = (($v) => ($v === '' ? '' : Number($v)))(($event.target as HTMLInputElement).value)" />
            </label>
            <UButton v-if="pars[key(w.ward, r.drugId)] !== undefined && pars[key(w.ward, r.drugId)] !== '' && pars[key(w.ward, r.drugId)] !== r.par" size="sm" variant="secondary" :loading="save.pending.value" @click="onSave(w, r.drugId)">儲存</UButton>
          </li>
        </ul>
        <div v-if="w.expiryLots.length" class="border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          <div class="mb-1 flex items-center gap-2"><b>效期（過期、30 天內到期）</b><UButton size="sm" variant="secondary" class="ml-auto" :loading="ret.pending.value" @click="startReturn(w)">全部收回到住院藥局</UButton></div>
          <div v-for="x in w.expiryLots" :key="x.lotId" :class="x.expired ? 'font-semibold text-red-700' : ''">{{ x.drugName }} {{ x.lotNo }}・{{ x.expiry }}{{ x.expired ? '（已過期）' : `（剩 ${x.daysLeft} 天）` }}・{{ x.qty }}</div>
        </div>
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
            <span v-if="w.lastCount" class="ml-2">上次點班 {{ md(w.lastCount.at) }} {{ w.lastCount.byName }}{{ w.lastCount.diffs ? `・差異 ${w.lastCount.diffs} 項` : '' }}{{ w.lastCount.witnessName ? `・見證 ${w.lastCount.witnessName}` : '' }}</span>
          </template>
        </div>
      </UCard>
    </div>
    <WitnessDialog
      v-model="witnessOpen"
      title="管制藥收回見證"
      who="見證人（病房護理師或另一位藥師）"
      ok-text="見證並收回"
      :subject="retWard ? `${retWard.name} 效期收回
管制藥：${retWard.ctrl}` : ''"
      note="見證人要和收回的藥師一起當場清點管制藥。"
      :approve="approveFn"
      @approved="onWitnessed"
    />
  </UQueryState>
</template>
