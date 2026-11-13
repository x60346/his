<script setup lang="ts">
// 病房常備點班（每班一次）：逐項輸入實點數量，看得到帳上數量；有差異要寫原因，送出後自動調帳（服務層 countWard）。
// 送出的是「這個畫面列出的品項與帳上數量」：點的時候剛有人給藥或補充，服務層會擋下要求重新整理。
// 含管制藥：送出前另一位護理師當場見證（WitnessDialog → witness.approveWitness；服務層 countWard 沒有見證就擋）。
import { computed, reactive, ref, watch } from 'vue'
import { ClipboardCheck } from 'lucide-vue-next'
import { UBadge, UButton, UQueryState } from '@/components/ui'
import WitnessDialog from '@/components/WitnessDialog.vue'
import { wardStockApi, witnessApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ ward: string; clock: string }>()
const { data, loading } = useQuery(async () => ({ ward: props.ward, v: await wardStockApi.getWardStock(props.ward) }), [() => props.ward])
const view = computed(() => (data.value?.ward === props.ward ? data.value.v : undefined))

const counted = reactive<Record<string, number | undefined>>({})
const reasons = reactive<Record<string, string>>({})
// 只在「換病房、品項變了、剛完成一次點班」時清空：其他操作（例如見證）會讓畫面重新查詢，不能把填到一半的數字洗掉
const formKey = computed(() => (view.value ? `${view.value.ward}|${view.value.rows.map((r) => r.drugId).join(',')}|${view.value.lastCount?.at ?? ''}` : ''))
watch(formKey, () => {
  const v = view.value
  for (const k of Object.keys(counted)) delete counted[k]
  for (const k of Object.keys(reasons)) delete reasons[k]
  for (const r of v?.rows ?? []) counted[r.drugId] = undefined
})
// 見證：綁這個病房；點班送出成功才用掉（送出失敗——例如差異沒寫原因——改好再送不必重新見證；過期由服務層判斷）
const witness = ref<{ ward: string; token: string; name: string }>()
const witnessNow = computed(() => (witness.value?.ward === props.ward ? witness.value : undefined))
const witnessOpen = ref(false)
const approveFn = (cred: { username: string; password: string }) => witnessApi.approveWitness({ purpose: 'wardCount', ward: props.ward, ...cred })
function onWitnessed(token: string, name: string) {
  witness.value = { ward: props.ward, token, name }
  submit()
}
const controlledNames = computed(() => (view.value?.rows ?? []).filter((r) => r.controlled).map((r) => `${r.drugName}（管制 ${r.controlled} 級）`).join('、'))
const diffOf = (drugId: string, book: number) => (counted[drugId] === undefined || String(counted[drugId]) === '' ? 0 : Number(counted[drugId]) - book)
const allFilled = computed(() => (view.value?.rows ?? []).every((r) => counted[r.drugId] !== undefined && String(counted[r.drugId]) !== ''))
const save = useAction(wardStockApi.countWard, { success: (c) => `已完成 ${c.shift}點班：${c.lines.filter((l) => l.counted !== l.book).length ? '差異已調帳' : '帳實相符'}` })
async function submit() {
  const v = view.value
  if (!v) return
  if (v.needsWitness && !witnessNow.value) {
    witnessOpen.value = true
    return
  }
  const ok = await save.run(props.ward, { lines: v.rows.map((r) => ({ drugId: r.drugId, book: r.onHand, counted: Number(counted[r.drugId]), reason: reasons[r.drugId] })), ...(witnessNow.value ? { witness: witnessNow.value.token } : {}) })
  // 成功＝見證已用掉；見證無效或過期＝清掉，下次送出重新見證
  if (ok || save.fieldErrors.value.witness) witness.value = undefined
}
const md = (s: string) => s.slice(5, 16).replace('-', '/')
</script>

<template>
  <div class="space-y-3 p-4">
    <UQueryState :loading="loading && !view" :ready="!!view">
      <template v-if="view">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="font-semibold text-slate-700">{{ view.locationName }}</span>
          <UBadge :tone="view.shift.counted ? 'green' : 'yellow'">{{ view.shift.date.slice(5).replace('-', '/') }} {{ view.shift.shift }}{{ view.shift.counted ? '已點班' : '尚未點班' }}</UBadge>
          <span v-if="view.lastCount" class="text-xs text-slate-500">上次：{{ md(view.lastCount.at) }} {{ view.lastCount.shift }} {{ view.lastCount.byName }}{{ view.lastCount.diffs ? `（差異 ${view.lastCount.diffs} 項）` : '（帳實相符）' }}{{ view.lastCount.witnessName ? `・見證 ${view.lastCount.witnessName}` : '' }}</span>
        </div>
        <div class="overflow-x-auto rounded-md border border-slate-200">
          <table class="tabular w-full text-sm">
            <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500">
              <tr>
                <th class="px-3 py-1.5 text-left font-medium">品項</th>
                <th class="px-2 text-right font-medium">基準量</th>
                <th class="px-2 text-right font-medium">帳上</th>
                <th class="px-2 text-right font-medium">實點</th>
                <th class="px-3 text-left font-medium">差異原因</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="r in view.rows" :key="r.drugId" :class="diffOf(r.drugId, r.onHand) ? 'bg-amber-50/60' : ''">
                <td class="px-3 py-1.5">
                  <span class="font-medium text-slate-800">{{ r.drugName }}</span>
                  <UBadge v-if="r.controlled" tone="red" class="ml-1">管制 {{ r.controlled }} 級</UBadge>
                  <UBadge v-if="r.below" tone="yellow" class="ml-1">低於基準量</UBadge>
                  <UBadge v-if="!r.par" tone="gray" class="ml-1">已不在常備清單</UBadge>
                </td>
                <td class="px-2 text-right text-slate-500">{{ r.par || '—' }}</td>
                <td class="px-2 text-right">{{ r.onHand }} <span class="text-xs text-slate-400">{{ r.unit }}</span></td>
                <td class="px-2 text-right">
                  <input v-model.number="counted[r.drugId]" type="number" min="0" step="1" class="form-control w-20 text-right" :aria-label="`${r.drugName} 實點`" />
                  <div v-if="save.fieldErrors.value[`counted.${r.drugId}`]" class="text-xs text-red-600">{{ save.fieldErrors.value[`counted.${r.drugId}`] }}</div>
                </td>
                <td class="px-3 py-1.5">
                  <template v-if="diffOf(r.drugId, r.onHand)">
                    <span :class="['mr-2 text-xs font-semibold', diffOf(r.drugId, r.onHand) < 0 ? 'text-red-700' : 'text-sky-700']">{{ diffOf(r.drugId, r.onHand) > 0 ? '+' : '' }}{{ diffOf(r.drugId, r.onHand) }}</span>
                    <input v-model="reasons[r.drugId]" type="text" placeholder="例：破損、找不到、上一班給藥未登打" :class="['form-control w-56 text-xs', save.fieldErrors.value[`reason.${r.drugId}`] && 'form-control-error']" :aria-label="`${r.drugName} 差異原因`" />
                    <div v-if="save.fieldErrors.value[`reason.${r.drugId}`]" class="text-xs text-red-600">{{ save.fieldErrors.value[`reason.${r.drugId}`] }}</div>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <span class="text-xs text-slate-500">每一項都要填（和帳上相同也要填）；有差異寫原因，送出後自動調帳<template v-if="view.needsWitness">；含管制藥，送出前需另一位護理師見證</template></span>
          <span v-if="witnessNow" class="text-xs font-medium text-emerald-700">見證：{{ witnessNow.name }}</span>
          <span v-if="save.fieldErrors.value.witness" class="text-xs text-red-600">{{ save.fieldErrors.value.witness }}</span>
          <UButton :icon="ClipboardCheck" :disabled="!allFilled" :loading="save.pending.value" @click="submit">完成點班</UButton>
        </div>
      </template>
    </UQueryState>
    <WitnessDialog
      v-model="witnessOpen"
      title="管制藥點班見證"
      who="見證護理師"
      ok-text="見證並完成點班"
      :subject="view ? `${view.locationName}・${view.shift.shift}點班\n管制藥：${controlledNames}` : ''"
      note="見證人要和點班的人一起當場清點管制藥。"
      :approve="approveFn"
      @approved="onWitnessed"
    />
  </div>
</template>
