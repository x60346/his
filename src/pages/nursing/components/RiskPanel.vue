<script setup lang="ts">
// 風險評估（護理站病人分頁）：跌倒（Morse）、壓傷（Braden）各一張卡——目前等級、下次該評（入院 24 小時內、高風險每天、
// 中低風險每週、轉床轉科後 24 小時內）、評估、歷次紀錄（可當班作廢）。
// 評估對話框逐題選，分數與等級即時算（risk-rules，和服務層同一份）；高風險要勾預防措施，可一併寫護理紀錄
import { computed, reactive, ref, watch } from 'vue'
import { ClipboardCheck } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UQueryState } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import {
  riskApi, RISK_ITEMS, RISK_LEVEL_LABEL, RISK_MEASURES, RISK_REASON_LABEL, RISK_SCALE_LABEL, RISK_SCALE_NAME, riskLevel, riskScore,
  type AdmissionView, type RiskAssessmentView,
} from '@/services'
import type { RiskLevel, RiskScale } from '@/types'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ admission: AdmissionView }>()
const { data, loading } = useQuery(() => riskApi.getRiskOverview(props.admission.id), [() => props.admission.id])
const ov = computed(() => (data.value?.admissionId === props.admission.id ? data.value : undefined))
const SCALES: RiskScale[] = ['fall', 'pressure']
const levelTone: Record<RiskLevel, 'red' | 'yellow' | 'green'> = { high: 'red', moderate: 'yellow', low: 'green' }
const dueText = (d: { dueAt: string; status: string; reason: string }) =>
  `${d.status === 'overdue' ? '逾時' : d.status === 'due' ? '該評了' : '下次'}：${d.dueAt.slice(5).replace('-', '/')} 前（${RISK_REASON_LABEL[d.reason as keyof typeof RISK_REASON_LABEL]}）`

// ---------- 評估 ----------
const scale = ref<RiskScale>()
const answers = reactive<Record<string, number>>({})
const measures = ref<string[]>([])
const writeNote = ref(true)
const change = ref(false)
function openAssess(s: RiskScale) {
  for (const k of Object.keys(answers)) delete answers[k]
  // 預設帶上一次的答案（大部分題目不會每天變），護理師逐題確認
  Object.assign(answers, ov.value?.scales[s].latest?.answers ?? {})
  measures.value = [...(ov.value?.scales[s].latest?.measures ?? [])]
  change.value = false
  save.fieldErrors.value = {}
  scale.value = s
  // 高風險預設一併寫護理紀錄
  writeNote.value = liveLevel.value === 'high'
}
const open = computed({ get: () => !!scale.value, set: (v) => !v && (scale.value = undefined) })
const live = computed(() => (scale.value ? riskScore(scale.value, answers) : undefined))
const liveLevel = computed(() => (scale.value && live.value && !live.value.missing.length ? riskLevel(scale.value, live.value.score, ov.value?.settings) : undefined))
// 改答案讓等級變成（或不再是）高風險時，跟著改預設要不要寫護理紀錄
watch(liveLevel, (l, old) => {
  if (old !== undefined && l !== old) writeNote.value = l === 'high'
})
const save = useAction(riskApi.saveRiskAssessment, { success: (r) => `已存 ${RISK_SCALE_NAME[r.scale]} ${r.score} 分（${RISK_LEVEL_LABEL[r.level]}）${r.noteId ? '，並寫了護理紀錄' : ''}` })
async function submit() {
  if (!scale.value) return
  if (await save.run({ admissionId: props.admission.id, scale: scale.value, answers: { ...answers }, measures: measures.value, writeNote: writeNote.value, change: change.value })) scale.value = undefined
}
function toggleMeasure(k: string, on: boolean) {
  measures.value = on ? [...new Set([...measures.value, k])] : measures.value.filter((x) => x !== k)
}

// ---------- 作廢 ----------
const voiding = ref<RiskAssessmentView>()
const voidOpen = computed({ get: () => !!voiding.value, set: (v) => !v && (voiding.value = undefined) })
const doVoid = useAction(riskApi.voidRiskAssessment, { success: '已作廢這次評估' })
async function confirmVoid(reason: string) {
  if (voiding.value && (await doVoid.run(voiding.value.id, reason))) voiding.value = undefined
}
</script>

<template>
  <div class="space-y-4 p-4 text-sm">
    <UQueryState :loading="loading && !ov" :ready="!!ov">
      <div v-if="ov" class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section v-for="s in SCALES" :key="s" class="space-y-2 rounded-md border border-slate-200 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="font-semibold text-slate-700">{{ RISK_SCALE_NAME[s] }}</h3>
            <UBadge v-if="ov.scales[s].latest" :tone="levelTone[ov.scales[s].latest!.level]">{{ ov.scales[s].latest!.score }} 分・{{ RISK_LEVEL_LABEL[ov.scales[s].latest!.level] }}</UBadge>
            <UBadge v-else tone="gray">還沒評估</UBadge>
            <UButton size="sm" class="ml-auto" :icon="ClipboardCheck" @click="openAssess(s)">評估</UButton>
          </div>
          <p :class="['text-xs', ov.scales[s].due.status === 'overdue' ? 'font-semibold text-red-700' : ov.scales[s].due.status === 'due' ? 'font-semibold text-amber-700' : 'text-slate-500']">{{ dueText(ov.scales[s].due) }}</p>
          <p v-if="ov.scales[s].latest?.measures?.length" class="text-xs text-slate-600">預防措施：{{ ov.scales[s].latest!.measures!.map((k) => RISK_MEASURES[s].find((m) => m.key === k)?.label).join('、') }}</p>
          <ul v-if="ov.scales[s].history.length" class="tabular divide-y divide-slate-100 rounded border border-slate-100 text-xs">
            <li v-for="r in ov.scales[s].history" :key="r.id" :class="['flex flex-wrap items-center gap-x-2 px-2 py-1', r.voided && 'text-slate-400']">
              <span :class="r.voided && 'line-through'">{{ r.at.slice(5).replace('-', '/') }}</span>
              <span :class="['w-16', r.voided && 'line-through']">{{ r.score }} 分 {{ RISK_LEVEL_LABEL[r.level].replace('風險', '') }}</span>
              <span class="text-slate-500">{{ RISK_REASON_LABEL[r.reason] }}・{{ r.nurseName }}</span>
              <span v-if="r.voided" class="text-red-600">已作廢：{{ r.voided.reason }}</span>
              <button v-else-if="!r.cantVoid" type="button" class="ml-auto text-slate-500 underline hover:text-red-700" @click="voiding = r">作廢</button>
            </li>
          </ul>
        </section>
      </div>
    </UQueryState>

    <UDialog v-model="open" :title="scale ? `${RISK_SCALE_NAME[scale]}：${admission.bed?.bedNo ?? ''} ${admission.patientName}` : ''" size="lg" @submit="submit">
      <div v-if="scale" class="space-y-3 text-sm">
        <p v-if="ov?.scales[scale].latest" class="text-xs text-slate-500">已帶入上次（{{ ov.scales[scale].latest!.at.slice(5).replace('-', '/') }}）的答案，請逐題確認。</p>
        <fieldset v-for="it in RISK_ITEMS[scale]" :key="it.key" class="rounded-md border border-slate-200 px-3 py-2">
          <legend class="px-1 font-medium text-slate-700">{{ it.label }}</legend>
          <div class="flex flex-wrap gap-x-4 gap-y-1">
            <label v-for="o in it.options" :key="o.score" class="flex items-center gap-1.5">
              <input v-model="answers[it.key]" type="radio" :name="it.key" :value="o.score" class="h-4 w-4 text-brand-600" />
              {{ o.text }}<span class="tabular text-xs text-slate-400">（{{ o.score }}）</span>
            </label>
          </div>
        </fieldset>
        <div class="flex flex-wrap items-center gap-3 rounded-md bg-slate-50 px-3 py-2">
          <span>總分 <b class="tabular text-lg">{{ live?.score ?? 0 }}</b></span>
          <UBadge v-if="liveLevel" :tone="levelTone[liveLevel]">{{ RISK_LEVEL_LABEL[liveLevel] }}</UBadge>
          <span v-else class="text-xs text-slate-500">還有 {{ live?.missing.length }} 題沒選</span>
          <span class="ml-auto text-xs text-slate-500">{{ scale === 'fall' ? `≥${ov?.settings.fallHigh} 高風險、≥${ov?.settings.fallModerate} 中度` : `≤${ov?.settings.pressureHigh} 高風險、≤${ov?.settings.pressureModerate} 中度（越低越危險）` }}</span>
        </div>
        <p v-if="save.fieldErrors.value.answers" class="text-xs text-red-600">{{ save.fieldErrors.value.answers }}</p>
        <section v-if="liveLevel === 'high' || measures.length" class="rounded-md border border-red-200 bg-red-50/40 px-3 py-2">
          <div class="mb-1 font-medium text-red-800">已採取的預防措施<span v-if="liveLevel === 'high'">（高風險至少勾一項）</span></div>
          <div class="flex flex-wrap gap-x-4 gap-y-1">
            <UCheckbox v-for="m in RISK_MEASURES[scale]" :key="m.key" :model-value="measures.includes(m.key)" :label="m.label" @update:model-value="(v) => toggleMeasure(m.key, v)" />
          </div>
          <p v-if="save.fieldErrors.value.measures" class="mt-1 text-xs text-red-600">{{ save.fieldErrors.value.measures }}</p>
        </section>
        <div class="flex flex-wrap gap-x-6 gap-y-1">
          <UCheckbox v-model="writeNote" label="同時寫一筆護理紀錄（焦點、分數與高風險因子、措施）" />
          <UCheckbox v-model="change" label="病情變化加評（例：跌倒後、術後）" />
        </div>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton type="submit" :disabled="!liveLevel" :loading="save.pending.value">儲存評估</UButton>
      </template>
    </UDialog>

    <ReasonDialog
      v-model="voidOpen"
      title="作廢風險評估"
      :subject="voiding ? `${RISK_SCALE_LABEL[voiding.scale]} ${voiding.at.slice(5).replace('-', '/')} ${voiding.score} 分` : ''"
      label="作廢原因（紀錄會留著、劃線）"
      :presets="['選錯題目', '評錯病人']"
      ok-text="作廢"
      danger
      :pending="doVoid.pending.value"
      :error="doVoid.fieldErrors.value.reason"
      @confirm="confirmVoid"
    />
  </div>
</template>
