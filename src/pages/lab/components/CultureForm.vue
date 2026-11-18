<script setup lang="ts">
// 細菌培養報告登打（檢驗科）：檢體 → 長菌了沒 → 每株菌（菌種）與它的藥敏組合（每支抗生素 S／I／R）。錯誤一次標出（服務層 checkCulture）
import { computed, reactive, watch } from 'vue'
import { UButton, USelect } from '@/components/ui'
import { astName, labApi, ORGANISMS, SPECIMENS, type LabReportView } from '@/services'
import type { CultureSpecimen, SirResult } from '@/types'
import { useAction } from '@/composables/useService'

const props = defineProps<{ itemKey: string }>()
const emit = defineEmits<{ done: [r: LabReportView] }>()
const f = reactive({ specimen: '' as CultureSpecimen | '', isolates: [] as { organism: string; ast: Record<string, SirResult | ''> }[] })
watch(() => props.itemKey, () => Object.assign(f, { specimen: '', isolates: [] }), { immediate: true })
const panelOf = (id: string) => ORGANISMS.find((o) => o.id === id)?.panel ?? []
function addIsolate() {
  if (f.isolates.length < 3) f.isolates.push({ organism: '', ast: {} })
}
const act = useAction(labApi.reportCulture, { success: (r) => `已發培養報告 ${r.no}${r.hasCritical ? '（血液培養陽性：危急值）' : ''}` })
async function submit() {
  const r = await act.run({ key: props.itemKey, specimen: f.specimen as CultureSpecimen, isolates: f.isolates.map((x) => ({ organism: x.organism, ast: Object.fromEntries(panelOf(x.organism).map((k) => [k, x.ast[k] ?? ''])) as Record<string, SirResult> })) })
  if (r) emit('done', r)
}
const err = computed(() => act.fieldErrors.value)
const SIR = [{ label: '—', value: '' }, { label: 'S 敏感', value: 'S' }, { label: 'I 中等', value: 'I' }, { label: 'R 抗藥', value: 'R' }]
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <div class="w-48"><USelect v-model="f.specimen" label="檢體" :options="[{ label: '請選', value: '' }, ...SPECIMENS.map((s) => ({ label: s.label, value: s.key }))]" :error="err.specimen" /></div>
    <p v-if="!f.isolates.length" class="text-slate-600">沒有加菌株＝<b class="text-emerald-700">無菌生長</b></p>
    <div v-for="(x, i) in f.isolates" :key="i" class="rounded border border-slate-200 p-2">
      <div class="flex items-end gap-2">
        <div class="w-72"><USelect v-model="x.organism" :label="`第 ${i + 1} 株菌種`" :options="[{ label: '請選', value: '' }, ...ORGANISMS.map((o) => ({ label: o.name, value: o.id }))]" :error="err[`organism${i}`]" /></div>
        <UButton size="sm" variant="ghost" @click="f.isolates.splice(i, 1)">移除</UButton>
      </div>
      <div v-if="panelOf(x.organism).length" class="mt-2 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
        <USelect v-for="k in panelOf(x.organism)" :key="k" v-model="x.ast[k]" :label="astName(k)" :options="SIR" />
      </div>
      <p v-if="err[`ast${i}`]" class="mt-1 text-xs text-red-600">{{ err[`ast${i}`] }}</p>
    </div>
    <p v-if="err.isolates" class="text-xs text-red-600">{{ err.isolates }}</p>
    <div class="flex gap-2">
      <UButton size="sm" variant="secondary" :disabled="f.isolates.length >= 3" @click="addIsolate">加一株菌</UButton>
      <UButton size="sm" class="ml-auto" :loading="act.pending.value" @click="submit">發報告</UButton>
    </div>
    <p class="text-xs text-slate-500">多重抗藥菌（MRSA、VRE、Meropenem 抗藥的腸道菌＝CRE）會提醒醫師開接觸隔離；血液培養有長菌是危急值。</p>
  </div>
</template>
