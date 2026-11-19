<script setup lang="ts">
// 門診加做（看診醫師）：看完診、批價後補開檢驗——掛在今天已收件的同管別檢體上（不用再抽）。
// 健保的不用補繳；自費的要到批價補繳，繳完檢驗科才能發報告。服務層 opd-addon.ts
import { computed, ref } from 'vue'
import { FlaskConical } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, USelect } from '@/components/ui'
import { opdAddonApi, type OpdAddonOption } from '@/services'
import type { Encounter, Procedure } from '@/types'
import { useAction } from '@/composables/useService'

const props = defineProps<{ encounter: Encounter; procs: Procedure[] }>()
const pick = ref('')
const opt = ref<OpdAddonOption>()
const selfPay = ref(false)
const labs = computed(() => props.procs.filter((p) => p.labItems?.length && p.active && !props.encounter.procedures.some((x) => x.procId === p.id)).map((p) => ({ value: p.id, label: p.name })))
const addons = computed(() => props.encounter.procedures.filter((p) => p.addon))
const nameOf = (id: string) => props.procs.find((p) => p.id === id)?.name ?? id
async function onPick(id: string) {
  pick.value = id
  opt.value = id ? await opdAddonApi.opdAddonOption(props.encounter.id, id).catch(() => undefined) : undefined
  selfPay.value = !!opt.value?.selfPayVisit
}
const add = useAction(opdAddonApi.addOpdLab, { success: (r) => `已補開 ${r.procName}（加做：條碼 ${r.barcode}）${r.due ? `，自費 ${r.due} 元請病人到批價補繳` : '，健保不用補繳'}` })
async function submit() {
  if (opt.value?.ok && (await add.run(props.encounter.id, pick.value, { selfPay: selfPay.value }))) {
    pick.value = ''
    opt.value = undefined
  }
}
</script>

<template>
  <div class="space-y-2 rounded-md border border-indigo-200 bg-indigo-50/50 p-3 text-sm">
    <div class="flex items-center gap-2 font-semibold text-indigo-900"><FlaskConical class="h-4 w-4" />補開檢驗（加做，不用再抽血）</div>
    <ul v-if="addons.length" class="space-y-0.5 text-xs">
      <li v-for="p in addons" :key="p.procId" class="flex flex-wrap items-center gap-2">
        <b>{{ nameOf(p.procId) }}</b><span class="text-slate-500">{{ p.addon!.at.slice(11) }} 補開</span>
        <UBadge v-if="!p.addon!.selfPay" tone="green">健保・不用補繳</UBadge>
        <UBadge v-else-if="p.addon!.chargeId" tone="green">已補繳 {{ p.addon!.amount }} 元</UBadge>
        <UBadge v-else tone="yellow">待補繳 {{ p.addon!.amount }} 元</UBadge>
      </li>
    </ul>
    <div class="flex flex-wrap items-end gap-2">
      <USelect :model-value="pick" class="w-64" label="檢驗" :options="[{ value: '', label: '選一項檢驗…' }, ...labs]" @update:model-value="(v) => onPick(String(v ?? ''))" />
      <UCheckbox v-if="opt?.ok && !opt.selfPayVisit" v-model="selfPay" :label="`自費（${opt.selfPrice} 元）`" class="pb-2" />
      <UButton :disabled="!opt?.ok" :loading="add.pending.value" @click="submit">補開</UButton>
    </div>
    <p v-if="opt && !opt.ok" class="text-xs text-red-700">不能加做：{{ opt.reason }}（請另外看診開立、重新採檢）</p>
    <p v-else-if="opt?.ok" class="text-xs text-slate-600">用 {{ opt.tubeLabel }} {{ opt.specimen!.barcode }}（{{ opt.specimen!.collectedAt.slice(11) }} 採檢：{{ opt.specimen!.tests.join('、') }}），可加做到 {{ opt.specimen!.until.slice(5) }}{{ opt.selfPayVisit ? `；自費身分，${opt.selfPrice} 元要到批價補繳` : '' }}</p>
  </div>
</template>
