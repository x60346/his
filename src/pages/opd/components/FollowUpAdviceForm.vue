<script setup lang="ts">
// 建議回診（不直接約，交給櫃台掛號）：幾週後、哪一科（預設這一科，也可以建議別科）、指定醫師（可不指定）、原因。
// 櫃台在掛號頁「待預約回診」聯絡病人掛號。這次已寫的列在上面，櫃台還沒處理的可以撤回。服務層 booking.adviseFollowUp
import { computed, reactive, watch } from 'vue'
import { MessageSquarePlus, Trash2 } from 'lucide-vue-next'
import { UBadge, UButton, UInput, USelect } from '@/components/ui'
import { ADVICE_REASONS, ADVICE_WEEKS, bookingApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ visitId: string; deptId: string; shown: boolean }>()
const { data } = useQuery(async () => (props.shown && props.visitId ? bookingApi.adviceOptions(props.visitId) : undefined), [() => props.shown, () => props.visitId])
const form = reactive({ weeks: 2, deptId: '', doctorId: '', reason: '' })
watch(() => props.shown, (v) => v && Object.assign(form, { weeks: 2, deptId: props.deptId, doctorId: '', reason: '' }), { immediate: true })
const doctors = computed(() => [{ value: '', label: '不指定' }, ...(data.value?.doctors ?? []).filter((d) => d.deptId === form.deptId).map((d) => ({ value: d.id, label: d.name }))])
watch(() => form.deptId, () => (form.doctorId = ''))
const advise = useAction(bookingApi.adviseFollowUp, { success: (a) => `已寫建議回診：${a.weeks} 週後 ${a.deptName}（交給櫃台掛號）` })
async function submit() {
  if (await advise.run(props.visitId, { weeks: Number(form.weeks), deptId: form.deptId, ...(form.doctorId ? { doctorId: form.doctorId } : {}), reason: form.reason })) form.reason = ''
}
const cancel = useAction(bookingApi.cancelAdvice, { success: '已撤回建議' })
</script>

<template>
  <section v-if="data" class="space-y-2 rounded-md border border-indigo-200 bg-indigo-50/40 p-3">
    <h4 class="flex items-center gap-1.5 text-xs font-semibold text-indigo-900"><MessageSquarePlus class="h-4 w-4" />只寫建議，交給櫃台掛號（可以建議別科）</h4>
    <ul v-if="data.mine.length" class="space-y-1 text-xs">
      <li v-for="a in data.mine" :key="a.id" class="flex flex-wrap items-center gap-2">
        <b>{{ a.weeks }} 週後</b><span>{{ a.deptName }}{{ a.doctorName ? ` ${a.doctorName}` : '' }}</span><span class="text-slate-600">{{ a.reason }}</span>
        <UBadge :tone="a.status === 'pending' ? 'yellow' : 'green'">{{ a.statusLabel }}</UBadge>
        <UButton v-if="a.status === 'pending'" size="sm" variant="ghost" :icon="Trash2" :loading="cancel.pending.value" @click="cancel.run(a.id)">撤回</UButton>
      </li>
    </ul>
    <div class="flex flex-wrap items-end gap-2">
      <USelect v-model="form.weeks" class="w-28" label="幾週後" :options="ADVICE_WEEKS.map((w) => ({ value: w, label: `${w} 週後` }))" :error="advise.fieldErrors.value.weeks" />
      <USelect v-model="form.deptId" class="w-36" label="科別" :options="data.depts.map((d) => ({ value: d.id, label: d.name }))" :error="advise.fieldErrors.value.deptId" />
      <USelect v-model="form.doctorId" class="w-32" label="醫師" :options="doctors" :error="advise.fieldErrors.value.doctorId" />
      <UInput v-model="form.reason" class="min-w-[12rem] flex-1" label="原因" placeholder="例：看檢驗報告" :error="advise.fieldErrors.value.reason" />
      <UButton size="sm" :loading="advise.pending.value" @click="submit">寫建議</UButton>
    </div>
    <div class="flex flex-wrap gap-1"><UButton v-for="r in ADVICE_REASONS" :key="r" size="sm" variant="ghost" @click="form.reason = r">{{ r }}</UButton></div>
  </section>
</template>
