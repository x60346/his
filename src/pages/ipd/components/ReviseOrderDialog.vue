<script setup lang="ts">
// 修改長期給藥醫囑：劑量、頻率、途徑、服用時機＋修改原因（藥不能換——換藥請停止後另開，要重新看過敏）。
// 服務層 reviseOrder 在同一筆交易裡停止舊的、開新的（檢查與開新醫囑同一份），從下一劑開始；
// 有護理師疑問的，疑問自動記為「已修改」。劑量偏高：服務層回 CONFLICT，這裡確認後帶 confirmHighDose 重送。
import { computed, reactive, watch } from 'vue'
import { UButton, UDialog, UInput, USelect } from '@/components/ui'
import { doseLevel, doseNote, DRUG_TIMINGS, effectiveTiming, ipdApi, marTimes, masterApi, ServiceError, timingApplies, TIMING_SHORT, type OrderView } from '@/services'
import type { ReviseInput } from '@/services/ipd'
import { Cancelled, useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import type { DrugTiming } from '@/types'

const props = defineProps<{ order: OrderView | null }>()
const emit = defineEmits<{ close: [] }>()
const open = computed({ get: () => !!props.order, set: (v) => !v && emit('close') })
const ui = useUi()

const { data: freqList } = useQuery(() => masterApi.listFrequencies())
const { data: drugs } = useQuery(() => masterApi.listDrugs({ includeInactive: true }))
const drug = computed(() => drugs.value?.find((d) => d.id === props.order?.drugId))
const freqOptions = computed(() => (freqList.value ?? []).filter((f) => f.code !== 'STAT').map((f) => ({ label: `${f.code}　${f.label}`, value: f.code })))
const routeOptions = masterApi.staticCodes.routes.map((r) => ({ label: `${r.code}　${r.name}`, value: r.code }))

const form = reactive({ dose: undefined as number | undefined, freq: '' as string | number | undefined, route: '' as string | number | undefined, timing: '' as string | number | undefined, reason: '' })
const showTiming = computed(() => !!drug.value && timingApplies(String(form.freq), String(form.route)))
const timingOptions = computed(() => {
  const master = drug.value?.timing ?? 'ANY'
  return [{ label: `照主檔（${TIMING_SHORT[master]}）`, value: '' }, ...DRUG_TIMINGS.filter((t) => t !== master).map((t) => ({ label: TIMING_SHORT[t], value: t }))]
})
const schedulePreview = computed(() => {
  const f = (freqList.value ?? []).find((x) => x.code === form.freq)
  if (!f || !drug.value) return []
  const rx = showTiming.value && form.timing ? (String(form.timing) as DrugTiming) : undefined
  return marTimes(f.code, f.times, effectiveTiming(drug.value.timing, rx), String(form.route))
})
const doseHint = computed(() => (drug.value && form.dose && doseLevel(drug.value, form.dose) !== 'ok' ? doseNote(drug.value, form.dose) : ''))

async function revise(id: string, input: ReviseInput) {
  try {
    return await ipdApi.reviseOrder(id, input)
  } catch (e) {
    if (!(e instanceof ServiceError && e.code === 'CONFLICT' && e.message.startsWith('劑量偏高'))) throw e
    if (!(await ui.confirm({ title: '劑量偏高', message: `${e.message}`, okText: '劑量無誤，修改', danger: true }))) throw new Cancelled()
    return ipdApi.reviseOrder(id, { ...input, confirmHighDose: true })
  }
}
const save = useAction(revise, { success: (o) => `已修改：${o.content}（舊醫囑已停止，護理師核對新醫囑後執行）` })
// 開啟時帶入目前的值（要放在 save 之後：immediate 會立刻用到它）
watch(
  () => props.order,
  (o) => {
    if (o) Object.assign(form, { dose: o.dose, freq: o.freq, route: o.route, timing: o.timingSet ? o.timing ?? '' : '', reason: '' })
    save.fieldErrors.value = {}
  },
  { immediate: true },
)

async function submit() {
  const o = props.order
  if (!o) return
  const r = await save.run(o.id, {
    dose: Number(form.dose), freq: String(form.freq), route: String(form.route),
    ...(showTiming.value && form.timing ? { timing: String(form.timing) as DrugTiming } : {}),
    reason: form.reason,
  })
  if (r) emit('close')
}
</script>

<template>
  <UDialog v-model="open" :title="`修改醫囑：${order?.content ?? ''}`" size="md" @submit="submit">
    <div v-if="order" class="space-y-3 text-sm">
      <p class="rounded-md bg-slate-50 px-3 py-2 text-slate-600">
        目前：每次 {{ order.dose }} {{ order.unit }}・{{ order.freq }}・{{ order.route }}<template v-if="order.timingShort">・{{ order.timingShort }}</template>
        <span v-if="order.pendingQuery" class="mt-1 block text-amber-800">護理師疑問：{{ order.pendingQuery.reason }}（修改後記為「已修改」）</span>
      </p>
      <div class="grid grid-cols-2 gap-3">
        <UInput v-model="form.dose" type="number" min="0" step="any" :label="`每次劑量（${order.unit}）`" required :hint="doseHint" />
        <USelect v-model="form.freq" label="頻率" required :options="freqOptions" />
        <USelect v-model="form.route" label="途徑" required :options="routeOptions" />
        <USelect v-if="showTiming" v-model="form.timing" label="服用時機" :options="timingOptions" />
      </div>
      <p v-if="schedulePreview.length" class="text-xs text-slate-500">每天給藥時間：{{ schedulePreview.join('、') }}（從下一劑開始；已給過的那一劑不會再排）</p>
      <UInput v-model="form.reason" label="修改原因" required placeholder="例：依腎功能調整劑量、病人吞嚥困難改途徑" :error="save.fieldErrors.value.reason" />
      <p class="text-xs text-slate-500">藥品不能換：要換藥請停止這筆再另開（要重新檢查過敏）。修改後舊醫囑停止、新醫囑接手，護理師要重新核對；已調劑沒給的藥會列入待送回藥局。</p>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="emit('close')">取消</UButton>
      <UButton type="submit" :loading="save.pending.value">修改</UButton>
    </template>
  </UDialog>
</template>
