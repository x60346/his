<script setup lang="ts">
// 門診退藥（可部分、可分次）：逐項填這次退多少，「全部」一鍵帶入還能退的量；
// 不可再用（已拆封、汙損）的勾起來——退回後直接報廢，送出前要另一位藥師覆核（WitnessDialog）。
// 規則（不能超過發出的量、退回哪個批號、全部退完才讓櫃台整張退費）都在服務層 pharmacy.returnDispense。
import { computed, reactive, ref, watch } from 'vue'
import { UButton, UCheckbox, UDialog, UTextarea } from '@/components/ui'
import WitnessDialog from '@/components/WitnessDialog.vue'
import { pharmacyApi, witnessApi, type DispenseView } from '@/services'
import { useAction } from '@/composables/useService'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ dispense: DispenseView }>()

const qty = reactive<Record<number, number | undefined>>({})
const scrap = reactive<Record<number, boolean>>({})
const reason = ref('')
const left = (i: number) => props.dispense.items[i].qty - props.dispense.items[i].returned
watch(open, (v) => {
  if (!v) return
  for (const k of Object.keys(qty)) delete qty[Number(k)]
  for (const k of Object.keys(scrap)) delete scrap[Number(k)]
  reason.value = ''
  ret.fieldErrors.value = {}
}, { immediate: true })
const lines = computed(() => props.dispense.items.map((_, i) => ({ idx: i, qty: Number(qty[i] ?? 0) || 0, scrap: !!scrap[i] })).filter((l) => l.qty > 0))
const allLeft = () => props.dispense.items.forEach((_, i) => (qty[i] = left(i)))
const willFinish = computed(() => props.dispense.items.every((it, i) => (Number(qty[i] ?? 0) || 0) >= it.qty - it.returned))
const scrapItems = computed(() => lines.value.filter((l) => l.scrap).map((l) => `${props.dispense.items[l.idx].drugName} ${l.qty} ${props.dispense.items[l.idx].unit}`).join('、'))

const ret = useAction(pharmacyApi.returnDispense, {
  success: (x) => (x.status === 'returned' ? `領藥號 ${x.pickupNo} 已全部退藥：請櫃台辦理作廢或退費` : `領藥號 ${x.pickupNo} 已部分退藥：櫃台那張收據會出現待退費`),
})
const witnessOpen = ref(false)
const approveFn = (cred: { username: string; password: string }) =>
  witnessApi.approveWitness({ purpose: 'scrapReturn', dispenseId: props.dispense.id, items: scrapItems.value, ...cred })
async function submit(witness?: string) {
  const ok = await ret.run(props.dispense.id, { reason: reason.value, lines: lines.value, ...(witness ? { witness } : {}) })
  if (ok) open.value = false
}
function onSubmit() {
  // 原因、數量先讓服務層檢查（沒寫原因就不必先找人覆核）；都填了、又有不可再用的，才請另一位藥師覆核
  if (scrapItems.value && reason.value.trim()) witnessOpen.value = true
  else submit()
}
</script>

<template>
  <UDialog v-model="open" :title="`門診退藥：領藥號 ${dispense.pickupNo} ${dispense.patientName}`" size="lg">
    <div class="space-y-3 text-sm">
      <div class="flex items-center gap-2 text-xs text-slate-500">
        <span>逐項填這次退多少（不退的留空）；退回發出時的批號。全部退完，櫃台才能整張作廢或退費；只退一部分，櫃台退差額。</span>
        <UButton size="sm" variant="secondary" class="ml-auto shrink-0" @click="allLeft">全部退</UButton>
      </div>
      <div class="overflow-x-auto rounded-md border border-slate-200">
        <table class="tabular w-full">
          <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500">
            <tr>
              <th class="px-3 py-1.5 text-left font-medium">品項</th>
              <th class="px-2 text-right font-medium">發出</th>
              <th class="px-2 text-right font-medium">已退</th>
              <th class="px-2 text-right font-medium">這次退</th>
              <th class="px-3 text-left font-medium">不可再用</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="(it, i) in dispense.items" :key="i" :class="left(i) ? '' : 'text-slate-400'">
              <td class="px-3 py-1.5">{{ it.drugName }}</td>
              <td class="px-2 text-right">{{ it.qty }} <span class="text-xs text-slate-400">{{ it.unit }}</span></td>
              <td class="px-2 text-right">{{ it.returned || '—' }}</td>
              <td class="px-2 py-1 text-right">
                <input v-if="left(i)" v-model.number="qty[i]" type="number" min="0" :max="left(i)" step="1" class="form-control ml-auto w-20 text-right" :aria-label="`${it.drugName} 這次退`" />
                <span v-else class="text-xs">已全部退</span>
                <div v-if="ret.fieldErrors.value[`qty.${i}`]" class="text-xs text-red-600">{{ ret.fieldErrors.value[`qty.${i}`] }}</div>
              </td>
              <td class="px-3">
                <UCheckbox v-if="left(i)" v-model="scrap[i]" :label="scrap[i] ? '報廢' : ''" :aria-label="`${it.drugName} 不可再用`" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="ret.fieldErrors.value.lines" class="text-xs text-red-600">{{ ret.fieldErrors.value.lines }}</p>
      <div class="flex flex-wrap gap-1.5">
        <UButton v-for="p in ['病人過敏回診', '醫師修改處方', '病人不需要了', '未拆封退回']" :key="p" size="sm" variant="secondary" @click="reason = p">{{ p }}</UButton>
      </div>
      <UTextarea v-model="reason" label="退藥原因" required :rows="2" :error="ret.fieldErrors.value.reason" />
      <p v-if="scrapItems" class="text-xs text-amber-800">不可再用的退回後直接報廢：送出前要另一位藥師覆核（{{ scrapItems }}）。</p>
      <p v-if="ret.fieldErrors.value.witness" class="text-xs text-red-600">{{ ret.fieldErrors.value.witness }}</p>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton variant="danger" :disabled="!lines.length" :loading="ret.pending.value" @click="onSubmit">{{ willFinish ? '全部退藥' : '退藥' }}</UButton>
    </template>
  </UDialog>
  <WitnessDialog
    v-model="witnessOpen"
    title="退藥報廢覆核"
    who="覆核藥師"
    ok-text="覆核並退藥"
    danger
    :subject="`領藥號 ${dispense.pickupNo}・不可再用、報廢：${scrapItems}\n原因：${reason.trim()}`"
    note="覆核人要當場確認退回的實物不能再用。"
    :approve="approveFn"
    @approved="(token: string) => submit(token)"
  />
</template>
