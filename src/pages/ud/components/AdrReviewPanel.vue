<script setup lang="ts">
// 藥師評估藥物不良反應：上面最近 30 天統計（通報數、嚴重度、判定）；左邊待評估（逾時、嚴重型在前）與最近評估；
// 右邊看通報與病人過敏，Naranjo 10 題（是／否／不知道）即時算分與判定，很可能以上可勾「加入過敏」（過敏原由系統依藥的類別決定）。
// 規則在服務層（adr-rules、adr.ts）
import { computed, reactive, ref, watch } from 'vue'
import { UBadge, UButton, UCard, UCheckbox, UEmpty, UQueryState, UTabs, UTextarea } from '@/components/ui'
import { adrApi, CAUSALITY_LABEL, canAddAllergy, causalityOf, NARANJO, naranjoScore, type AdrView, type NaranjoAnswer } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'

const { data, loading } = useQuery(() => adrApi.listAdrReview())
const tab = ref<'pending' | 'done'>('pending')
const tabs = computed(() => [
  { key: 'pending', label: '待評估', count: data.value?.pending.length },
  { key: 'done', label: '最近評估', count: data.value?.done.length },
])
const list = computed<AdrView[]>(() => data.value?.[tab.value] ?? [])
const selId = ref<string>()
useRevealOnNarrow(selId)
watch(tab, () => (selId.value = undefined))
const item = computed(() => list.value.find((x) => x.id === selId.value))

const answers = reactive<(NaranjoAnswer | '')[]>(NARANJO.map(() => ''))
const form = reactive({ note: '', addAllergy: false })
watch(selId, () => {
  answers.splice(0, answers.length, ...NARANJO.map(() => '' as const))
  Object.assign(form, { note: '', addAllergy: false })
})
const score = computed(() => naranjoScore(answers as NaranjoAnswer[]))
const causality = computed(() => causalityOf(score.value))
const allAnswered = computed(() => answers.every((x) => x))
watch(causality, (c) => !canAddAllergy(c) && (form.addAllergy = false))
const assess = useAction(adrApi.assessAdr, { success: (r) => `已評估：${r.causalityLabel}（${r.assessment?.score} 分）${r.assessment?.allergyAdded ? `，已加入過敏 ${r.assessment.allergyAdded}` : ''}` })
async function submit() {
  if (item.value && (await assess.run(item.value.id, { answers: answers as NaranjoAnswer[], note: form.note, addAllergy: form.addAllergy }))) selId.value = undefined
}
const ANS: { key: NaranjoAnswer; label: string }[] = [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }, { key: 'unknown', label: '不知道' }]
</script>

<template>
  <div class="space-y-4">
    <div v-if="data" class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <UCard><div class="text-xs text-slate-500">最近 30 天通報</div><div class="tabular text-2xl font-bold">{{ data.stats.total }}</div></UCard>
      <UCard><div class="text-xs text-slate-500">嚴重型</div><div class="tabular text-2xl font-bold" :class="data.stats.serious ? 'text-red-700' : ''">{{ data.stats.serious }}</div></UCard>
      <UCard><div class="text-xs text-slate-500">嚴重度</div><div class="tabular text-sm">{{ data.stats.bySeverity.map((x) => `${x.label} ${x.count}`).join('・') }}</div></UCard>
      <UCard><div class="text-xs text-slate-500">藥師判定</div><div class="tabular text-sm">{{ data.stats.byCausality.map((x) => `${x.label} ${x.count}`).join('・') }}</div></UCard>
    </div>
    <div class="grid grid-cols-1 gap-4 xl:grid-cols-[22rem_1fr]">
      <UCard :padded="false" class="self-start">
        <div class="px-4 pt-1"><UTabs v-model="tab" :tabs="tabs" /></div>
        <UQueryState :loading="loading && !data" :ready="list.length > 0" :empty-title="tab === 'pending' ? '沒有待評估的不良反應' : '最近 30 天沒有評估紀錄'">
          <ul class="divide-y divide-slate-100">
            <li v-for="x in list" :key="x.id">
              <button type="button" :class="['w-full px-4 py-2.5 text-left text-sm hover:bg-slate-50', x.id === selId && '!bg-brand-50']" @click="selId = x.id">
                <div class="flex items-center gap-2">
                  <span class="tabular rounded bg-slate-100 px-1.5 text-xs">{{ x.bedNo || '已出院' }}</span>
                  <span class="font-medium text-slate-800">{{ x.patientName }}</span>
                  <UBadge v-if="x.seriousLabel" tone="red" class="ml-auto">{{ x.overdue ? '逾時・' : '' }}{{ x.seriousLabel }}</UBadge>
                  <UBadge v-else-if="x.assessment" :tone="canAddAllergy(x.assessment.causality) ? 'red' : 'gray'" class="ml-auto">{{ x.causalityLabel }}</UBadge>
                </div>
                <div class="mt-0.5 text-xs text-slate-700">{{ x.drugName }}・{{ x.severityLabel }}・{{ x.symptoms }}</div>
                <div class="tabular text-xs text-slate-500">{{ x.reportedByName }} {{ x.reportedAt.slice(5) }} 通報<template v-if="x.dueAt && !x.assessment">・期限 {{ x.dueAt.slice(5) }}</template></div>
              </button>
            </li>
          </ul>
        </UQueryState>
      </UCard>

      <UCard v-if="!item" data-detail><UEmpty title="請從左邊選一筆" description="用 Naranjo 量表評估藥物與反應的因果關係" /></UCard>
      <div v-else data-detail class="min-w-0 space-y-3">
        <UCard :title="`${item.patientName}・${item.drugName}`" :subtitle="`${item.bedNo || '已出院'}・住院號 ${item.admitNo}・發生 ${item.onsetAt.slice(5)}`">
          <div class="space-y-1 text-sm">
            <div><UBadge :tone="item.severity === 'severe' ? 'red' : item.severity === 'moderate' ? 'yellow' : 'gray'">{{ item.severityLabel }}</UBadge> <UBadge v-if="item.seriousLabel" tone="red">{{ item.seriousLabel }}</UBadge> {{ item.symptoms }}</div>
            <div class="text-slate-600">處置：{{ item.action }}</div>
            <div :class="item.allergies.length ? 'text-red-700' : 'text-slate-500'">目前過敏紀錄：{{ item.allergies.join('、') || '無' }}</div>
          </div>
        </UCard>
        <UCard v-if="item.assessment" title="評估結果">
          <p class="text-sm">{{ item.assessedByName }} {{ item.assessment.at.slice(5) }}：Naranjo {{ item.assessment.score }} 分，<b>{{ item.causalityLabel }}</b>{{ item.assessment.note ? `；${item.assessment.note}` : '' }}<template v-if="item.assessment.allergyAdded">；已加入過敏 <b class="text-red-700">{{ item.assessment.allergyAdded }}</b></template></p>
        </UCard>
        <UCard v-else title="Naranjo 因果關係量表" :subtitle="`目前 ${score} 分：${CAUSALITY_LABEL[causality]}（≥9 確定、5–8 很可能、1–4 可能、≤0 存疑）`">
          <ol class="space-y-1.5 text-sm">
            <li v-for="(q, i) in NARANJO" :key="i" class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span class="min-w-0 flex-1">{{ i + 1 }}. {{ q.q }}<span class="ml-1 text-xs text-slate-400">（是 {{ q.yes > 0 ? '+' : '' }}{{ q.yes }}／否 {{ q.no > 0 ? '+' : '' }}{{ q.no }}）</span></span>
              <span class="flex gap-2">
                <label v-for="a in ANS" :key="a.key" class="flex items-center gap-1 text-xs"><input v-model="answers[i]" type="radio" :name="`nar-${i}`" :value="a.key" class="h-3.5 w-3.5" />{{ a.label }}</label>
              </span>
            </li>
          </ol>
          <p v-if="assess.fieldErrors.value.answers" class="mt-1 text-xs text-red-600">{{ assess.fieldErrors.value.answers }}</p>
          <UTextarea v-model="form.note" class="mt-3" label="評估說明" :rows="2" placeholder="例：給藥後 2 小時出現、停藥後改善" />
          <UCheckbox v-model="form.addAllergy" class="mt-2" :disabled="!canAddAllergy(causality)" :label="`加入病人過敏紀錄：${item.allergen}${canAddAllergy(causality) ? '' : '（很可能以上才能加）'}`" />
          <p v-if="assess.fieldErrors.value.addAllergy" class="text-xs text-red-600">{{ assess.fieldErrors.value.addAllergy }}</p>
          <div class="mt-3 flex justify-end"><UButton :disabled="!allAnswered" :loading="assess.pending.value" @click="submit">完成評估</UButton></div>
        </UCard>
      </div>
    </div>
  </div>
</template>
