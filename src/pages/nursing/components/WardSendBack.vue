<script setup lang="ts">
// 待送回藥局（全病房）：藥局發來、不會給了的藥（暫停、拒絕、醫囑停止、出院）。
// 放在病房層級：已出院病人的剩藥也要送回，那位病人已經不在病人清單上了。
// 把藥放進退藥袋、勾選、按「送回藥局」；藥局點收時再核實數量（短少由藥師寫原因）。
import { computed, reactive } from 'vue'
import { Undo2 } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox } from '@/components/ui'
import { udApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ ward: string }>()
const { data } = useQuery(async () => ({ ward: props.ward, rows: await udApi.listWardUdReturns(props.ward) }), [() => props.ward])
const rows = computed(() => (data.value?.ward === props.ward ? data.value.rows : []))
const picked = reactive<Record<string, boolean>>({})
const chosen = computed(() => rows.value.filter((r) => picked[r.lineId]))
const allOn = computed({
  get: () => rows.value.length > 0 && rows.value.every((r) => picked[r.lineId]),
  set: (v: boolean) => rows.value.forEach((r) => (picked[r.lineId] = v)),
})
const send = useAction(udApi.sendBackUd, { success: (r) => `已送回藥局：${r.lines} 項、${r.doses} 劑，等藥局點收` })
async function onSend() {
  if (await send.run(chosen.value.map((r) => r.lineId))) for (const k of Object.keys(picked)) delete picked[k]
}
</script>

<template>
  <section v-if="rows.length" class="mb-4 rounded-md border border-amber-300 bg-amber-50/60 p-3">
    <div class="mb-2 flex flex-wrap items-center gap-2 text-sm">
      <Undo2 class="h-4 w-4 text-amber-700" />
      <span class="font-semibold text-amber-900">待送回藥局（{{ rows.length }} 項）</span>
      <span class="text-xs text-amber-800">沒給的 UD 藥放進退藥袋送回，藥局點收時核實數量</span>
      <UButton size="sm" class="ml-auto" :icon="Undo2" :disabled="!chosen.length" :loading="send.pending.value" @click="onSend">送回藥局（{{ chosen.length }}）</UButton>
    </div>
    <UCheckbox v-model="allOn" class="mb-1 text-xs">全選</UCheckbox>
    <ul class="divide-y divide-amber-100 rounded border border-amber-200 bg-white">
      <li v-for="r in rows" :key="r.lineId" class="flex flex-wrap items-center gap-3 px-3 py-1.5 text-sm">
        <UCheckbox v-model="picked[r.lineId]" :aria-label="`送回 ${r.patientName} ${r.drugName}`" />
        <span class="tabular w-12 text-xs font-semibold text-slate-600">{{ r.bedNo }}</span>
        <span class="min-w-0 flex-1">
          <span class="font-medium text-slate-800">{{ r.patientName }}</span><UBadge v-if="r.discharged" tone="gray" class="ml-1">已出院</UBadge>・{{ r.drugName }}
          <span class="block text-xs text-slate-500">{{ r.causes }}</span>
        </span>
        <span class="tabular">{{ r.expected }} <span class="text-xs text-slate-500">{{ r.unit }}</span></span>
      </li>
    </ul>
  </section>
</template>
