<script setup lang="ts">
// 根本原因分析（RCA）：時間序列、原因分類（人員、設備、流程、環境、溝通、病人因素，可複選）、根本原因、行動計畫（負責人、期限、完成）。
// SAC 1–2 結案前一定要做完（計畫都完成），3–4 可選。結案後唯讀。服務層 incident.saveRca／completeRcaPlan
import { reactive, watch } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'
import { UBadge, UButton, UTextarea } from '@/components/ui'
import { incidentApi, RCA_CAUSE_LABEL, type IncidentView } from '@/services'
import type { RcaCause } from '@/types'
import { useAction } from '@/composables/useService'
import { addDays, now, today } from '@/utils/date'

const props = defineProps<{ x: IncidentView }>()
const ro = () => props.x.status === 'closed'
const form = reactive({ timeline: [] as { at: string; event: string }[], causes: [] as RcaCause[], rootCause: '', plans: [] as { id?: string; action: string; owner: string; due: string; status?: string; doneAt?: string }[] })
// 只在換了通報、或存檔後內容真的變了才重新帶入：任何存檔都會重新查詢、給新的物件，不能蓋掉還沒存的編輯
watch(() => `${props.x.id}|${props.x.status}|${JSON.stringify(props.x.rca ?? null)}`, () => {
  const x = props.x
  const r = x.rca
  Object.assign(form, {
    timeline: r ? r.timeline.map((t) => ({ ...t })) : [{ at: x.occurredAt, event: '' }],
    causes: r ? [...r.causes] : [], rootCause: r?.rootCause ?? '',
    plans: r ? r.plans.map((p) => ({ ...p })) : [{ action: '', owner: '', due: addDays(today(), 14) }],
  })
}, { immediate: true })
const save = useAction(incidentApi.saveRca, { success: (v) => `${v.no} RCA 已儲存` })
const done = useAction(incidentApi.completeRcaPlan, { success: '行動計畫已完成' })
const toggle = (c: RcaCause) => (form.causes = form.causes.includes(c) ? form.causes.filter((x) => x !== c) : [...form.causes, c])
function submit() {
  save.run(props.x.id, { timeline: form.timeline, causes: form.causes, rootCause: form.rootCause, plans: form.plans.map((p) => ({ ...(p.id ? { id: p.id } : {}), action: p.action, owner: p.owner, due: p.due })) })
}
const t = today()
</script>

<template>
  <div class="space-y-2 rounded border border-violet-200 bg-violet-50/40 p-2">
    <div class="flex flex-wrap items-center gap-2"><b>根本原因分析（RCA）</b>
      <UBadge v-if="x.rcaRequired" :tone="x.rcaDone ? 'green' : 'red'">{{ x.rcaDone ? '已完成' : 'SAC 1–2 結案前必做' }}</UBadge>
      <UBadge v-else tone="gray">可選</UBadge>
      <UBadge v-if="x.overduePlans" tone="red">{{ x.overduePlans }} 項計畫過期</UBadge></div>
    <div>
      <div class="mb-1 font-semibold text-slate-600">時間序列</div>
      <div v-for="(r, i) in form.timeline" :key="i" class="mb-1 flex flex-wrap items-center gap-1">
        <input v-model="r.at" class="form-control w-36 px-1 py-0.5 text-xs" :disabled="ro()" placeholder="YYYY-MM-DD HH:mm" :aria-label="`第 ${i + 1} 列時間`" />
        <input v-model="r.event" class="form-control min-w-[12rem] flex-1 px-1 py-0.5 text-xs" :disabled="ro()" placeholder="發生的事" :aria-label="`第 ${i + 1} 列事件`" />
        <UButton v-if="!ro() && form.timeline.length > 1" size="sm" variant="ghost" :icon="Trash2" @click="form.timeline.splice(i, 1)" />
      </div>
      <UButton v-if="!ro()" size="sm" variant="ghost" :icon="Plus" @click="form.timeline.push({ at: now(), event: '' })">加一列</UButton>
      <p v-if="save.fieldErrors.value.timeline" class="text-red-600">{{ save.fieldErrors.value.timeline }}</p>
    </div>
    <div>
      <div class="mb-1 font-semibold text-slate-600">原因分類</div>
      <label v-for="(label, k) in RCA_CAUSE_LABEL" :key="k" class="mr-3 inline-flex items-center gap-1"><input type="checkbox" :checked="form.causes.includes(k)" :disabled="ro()" @change="toggle(k)" />{{ label }}</label>
      <p v-if="save.fieldErrors.value.causes" class="text-red-600">{{ save.fieldErrors.value.causes }}</p>
    </div>
    <UTextarea v-model="form.rootCause" label="根本原因（為什麼會發生，不只是誰做錯）" :rows="2" :disabled="ro()" :error="save.fieldErrors.value.rootCause" />
    <div>
      <div class="mb-1 font-semibold text-slate-600">行動計畫</div>
      <div v-for="(p, i) in form.plans" :key="p.id ?? `n${i}`" class="mb-1 flex flex-wrap items-center gap-1">
        <input v-model="p.action" class="form-control min-w-[12rem] flex-1 px-1 py-0.5 text-xs" :disabled="ro() || p.status === 'done'" placeholder="改善行動" :aria-label="`計畫 ${i + 1}`" />
        <input v-model="p.owner" class="form-control w-28 px-1 py-0.5 text-xs" :disabled="ro() || p.status === 'done'" placeholder="負責人" :aria-label="`計畫 ${i + 1} 負責人`" />
        <input v-model="p.due" type="date" class="form-control w-36 px-1 py-0.5 text-xs" :disabled="ro() || p.status === 'done'" :aria-label="`計畫 ${i + 1} 期限`" />
        <UBadge v-if="p.status === 'done'" tone="green">已完成 {{ p.doneAt?.slice(5, 10) }}</UBadge>
        <UBadge v-else-if="p.id && p.due < t" tone="red">過期</UBadge>
        <UButton v-if="!ro() && p.id && p.status !== 'done'" size="sm" variant="secondary" :loading="done.pending.value" @click="done.run(x.id, p.id)">完成</UButton>
        <UButton v-if="!ro() && !p.id && form.plans.length > 1" size="sm" variant="ghost" :icon="Trash2" @click="form.plans.splice(i, 1)" />
      </div>
      <UButton v-if="!ro()" size="sm" variant="ghost" :icon="Plus" @click="form.plans.push({ action: '', owner: '', due: addDays(today(), 14) })">加一項</UButton>
      <p v-if="save.fieldErrors.value.plans" class="text-red-600">{{ save.fieldErrors.value.plans }}</p>
    </div>
    <div v-if="!ro()" class="flex justify-end"><UButton size="sm" :loading="save.pending.value" @click="submit">儲存 RCA</UButton></div>
  </div>
</template>
