<script setup lang="ts">
// 退回藥庫（藥局）：逐批勾選要退的（過期、近效期、存太多的排前面），填數量、寫原因 → 送出就從這個藥局扣、運送中；
// 藥庫在同一張撥補單簽收入帳。能不能退、數量夠不夠由服務層判斷，錯誤標在那一列。
import { computed, reactive, ref } from 'vue'
import { Undo2 } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UQueryState, UTextarea } from '@/components/ui'
import { transferApi, type ReturnCandidate } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'

const props = defineProps<{ fromLocationId: string; fromLocationName?: string }>()
const emit = defineEmits<{ created: [id: string] }>()
const ui = useUi()

const { data: cands, loading } = useQuery(() => transferApi.returnCandidates(props.fromLocationId), [() => props.fromLocationId])
const FLAG = { expired: { label: '已過期', tone: 'red' }, expiring: { label: '近效期', tone: 'yellow' }, overstock: { label: '存量偏多', tone: 'blue' } } as const
const showAll = ref(false)
const shown = computed(() => (cands.value ?? []).filter((c) => showAll.value || c.flag))

// 勾選＝要退；數量預設整批
const picked = reactive<Record<string, number | undefined>>({})
const isPicked = (c: ReturnCandidate) => c.lotId in picked
function toggle(c: ReturnCandidate, on: boolean) {
  if (on) picked[c.lotId] = c.qty
  else delete picked[c.lotId]
}
const pickedList = computed(() => (cands.value ?? []).filter(isPicked))
const reason = ref('')
const presets = ['近效期，退回藥庫統一處理', '請領過多', '已過期，送藥庫集中報廢', '品質疑慮（外觀異常）']

const send = useAction(transferApi.returnToWarehouse, { success: (t) => `已退回 ${t.no}：運送中，等${t.toName}簽收` })
// 服務層的列錯誤用送出的順序（line-0…）；換算回批號，標在那一列
const errOf = (c: ReturnCandidate) => {
  const i = pickedList.value.findIndex((x) => x.lotId === c.lotId)
  return i >= 0 ? send.fieldErrors.value[`line-${i}`] : undefined
}
async function onSend() {
  const lines = pickedList.value.map((c) => ({ lotId: c.lotId, qty: Number(picked[c.lotId]) }))
  if (lines.length) {
    const total = lines.reduce((n, l) => n + l.qty, 0)
    const ok = await ui.confirm({ title: '退回藥庫', message: `從${props.fromLocationName ?? '這個藥局'}退回 ${lines.length} 個批號（共 ${total}）？送出就從這裡扣帳，藥庫簽收後入帳。`, okText: '退回' })
    if (!ok) return
  }
  const t = await send.run({ fromLocationId: props.fromLocationId, reason: reason.value, lines })
  if (t) emit('created', t.id)
}
</script>

<template>
  <div class="space-y-3">
    <h2 class="text-lg font-bold text-slate-800">退回藥庫<template v-if="fromLocationName">（{{ fromLocationName }}）</template></h2>
    <p class="text-xs text-slate-500">勾選要退的批號（批號、效期跟著藥走）。過期的也能退，送藥庫集中報廢。送出就從這個藥局扣帳，藥庫簽收才入。</p>
    <UQueryState :loading="loading && !cands" :ready="!!cands?.length" empty-title="這個藥局沒有庫存可以退">
      <div class="overflow-x-auto rounded-md border border-slate-200">
        <table class="tabular w-full text-sm">
          <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500">
            <tr><th class="w-8"></th><th class="px-2 py-1.5 text-left font-medium">藥品・批號（效期）</th><th class="px-2 text-right font-medium">庫存</th><th class="px-2 text-right font-medium">退回數量</th></tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="c in shown" :key="c.lotId" :class="isPicked(c) && 'bg-brand-50/50'">
              <td class="px-2"><UCheckbox :model-value="isPicked(c)" :aria-label="`退回 ${c.drugName} 批號 ${c.lotNo}`" @update:model-value="(v) => toggle(c, v)" /></td>
              <td class="px-2 py-1.5">
                <div class="font-medium text-slate-800">{{ c.drugName }}<UBadge v-if="c.flag" :tone="FLAG[c.flag].tone" class="ml-1">{{ FLAG[c.flag].label }}</UBadge></div>
                <div class="text-xs text-slate-500">{{ c.lotNo }}（{{ c.expiry }}）</div>
                <div v-if="errOf(c)" class="text-xs text-red-600">{{ errOf(c) }}</div>
              </td>
              <td class="px-2 text-right">{{ c.qty }} <span class="text-xs text-slate-400">{{ c.unit }}</span></td>
              <td class="px-2 text-right">
                <input v-if="isPicked(c)" v-model.number="picked[c.lotId]" type="number" min="1" :max="c.qty" step="1" class="form-control w-20 text-right" :aria-label="`${c.drugName} 批號 ${c.lotNo} 退回數量`" />
              </td>
            </tr>
            <tr v-if="!shown.length"><td colspan="4" class="px-3 py-4 text-center text-sm text-slate-400">沒有過期、近效期或存量偏多的批號</td></tr>
          </tbody>
        </table>
      </div>
      <UCheckbox v-model="showAll" class="mt-2">顯示全部批號（{{ cands?.length }}）</UCheckbox>
    </UQueryState>
    <p v-if="send.fieldErrors.value.lines" class="text-xs text-red-600">{{ send.fieldErrors.value.lines }}</p>
    <div class="flex flex-wrap gap-1.5">
      <UButton v-for="p in presets" :key="p" size="sm" variant="secondary" @click="reason = p">{{ p }}</UButton>
    </div>
    <UTextarea v-model="reason" label="退回原因" required :rows="2" :error="send.fieldErrors.value.reason" />
    <div class="flex justify-end">
      <UButton size="sm" :icon="Undo2" :loading="send.pending.value" @click="onSend">退回藥庫（{{ pickedList.length }} 個批號）</UButton>
    </div>
  </div>
</template>
