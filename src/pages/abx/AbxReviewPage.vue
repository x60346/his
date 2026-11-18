<script setup lang="ts">
// 管制性抗生素審核（感染科）：先用後審，開立（或申覆、續用申請）後 48 小時內審。
// 左邊「待審核」（逾時的在前）與「最近審核」（7 天內）；右邊看病人（診斷、過敏、隔離、生命徵象、檢驗、
// 目前所有的抗生素與天數）和這次的理由、送審紀錄，核准（到療程第幾天）或不核准（要寫建議）。
// 不是感染科的醫師也能看（知道在等誰審），但不能審。規則都在服務層 abx.ts。
// 上方切換「管制性抗生素審核」與「每日審視」（全院在用的抗生素、系統標的建議，元件 AbxStewardPanel；首頁帶 ?tab=steward）
import { computed, reactive, ref, watch } from 'vue'
import { Check, X } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UEmpty, UInput, UQueryState, UTabs, UTextarea } from '@/components/ui'
import PatientFlags from '@/components/PatientFlags.vue'
import { abxApi, ABX_DEFAULT_DAYS, ABX_MAX_DAYS, type AbxReviewItem } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { useRoute, useRouter } from 'vue-router'
import AbxStewardPanel from './components/AbxStewardPanel.vue'

const route = useRoute()
const router = useRouter()
const mode = ref<'review' | 'steward'>(route.query.tab === 'steward' ? 'steward' : 'review')
watch(mode, (m) => router.replace({ query: m === 'steward' ? { tab: 'steward' } : {} }))
const modes = [{ key: 'review', label: '管制性抗生素審核' }, { key: 'steward', label: '每日審視' }]

const { data, loading } = useQuery(() => abxApi.listAbxReviews())
const tab = ref<'pending' | 'decided'>('pending')
const tabs = computed(() => [
  { key: 'pending', label: '待審核', count: data.value?.pending.length },
  { key: 'decided', label: '最近審核', count: data.value?.decided.length },
])
const list = computed<AbxReviewItem[]>(() => (tab.value === 'pending' ? data.value?.pending : data.value?.decided) ?? [])
const selId = ref<string>()
useRevealOnNarrow(selId)
watch(tab, () => (selId.value = undefined))
const item = computed(() => list.value.find((x) => x.order.id === selId.value))
const decision = computed(() => (tab.value === 'decided' ? data.value?.decided.find((x) => x.order.id === selId.value)?.decision : undefined))

const form = reactive({ days: ABX_DEFAULT_DAYS as number | undefined, note: '' })
watch(selId, () => Object.assign(form, { days: Math.max(ABX_DEFAULT_DAYS, item.value?.abx.day ?? 1), note: '' }))
const review = useAction(abxApi.reviewAbx, { success: (o) => `已${o.abx?.status === 'approved' ? `核准 ${o.content}（至第 ${o.abx.approvedDays} 天）` : `不核准 ${o.content}，主治會收到通知`}` })
async function decide(approve: boolean) {
  if (!item.value) return
  if (await review.run(item.value.order.id, { approve, days: form.days, note: form.note })) selId.value = undefined
}
const STEP: Record<string, string> = { request: '開立', approve: '核准', reject: '不核准', appeal: '申覆', extend: '申請續用' }
</script>

<template>
  <div class="space-y-3">
    <UTabs v-model="mode" :tabs="modes" />
    <AbxStewardPanel v-if="mode === 'steward'" />
    <div v-else class="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]">
      <UCard :padded="false" class="self-start">
        <div class="px-4 pt-1"><UTabs v-model="tab" :tabs="tabs" /></div>
        <p v-if="data && !data.canReview" class="mx-4 mt-2 rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">管制性抗生素由感染科醫師審核；您可以查看進度。</p>
        <UQueryState :loading="loading && !data" :ready="list.length > 0" :empty-title="tab === 'pending' ? '沒有待審核的管制性抗生素' : '最近 7 天沒有審核紀錄'">
          <ul class="divide-y divide-slate-100">
            <li v-for="x in list" :key="x.order.id">
              <button type="button" :class="['w-full px-4 py-2.5 text-left text-sm hover:bg-slate-50', x.order.id === selId && '!bg-brand-50']" @click="selId = x.order.id">
                <div class="flex items-center gap-2">
                  <span class="tabular rounded bg-slate-100 px-1.5 text-xs">{{ x.bedNo }}</span>
                  <span class="font-medium text-slate-800">{{ x.patientName }}</span>
                  <UBadge v-if="tab === 'pending' && x.abx.overdue" tone="red" class="ml-auto">逾時</UBadge>
                  <UBadge v-else-if="tab === 'decided'" :tone="data?.decided.find((d) => d.order.id === x.order.id)?.decision.action === 'approve' ? 'green' : 'red'" class="ml-auto">{{ data?.decided.find((d) => d.order.id === x.order.id)?.decision.action === 'approve' ? '核准' : '不核准' }}</UBadge>
                </div>
                <div class="mt-0.5 text-xs text-slate-700">{{ x.order.content }}・{{ x.abx.text.split('・')[0] }}</div>
                <div class="text-xs text-slate-500">{{ x.abx.reasonText }}・{{ x.deptName }} {{ x.attendingName }}</div>
                <div v-if="tab === 'pending'" class="tabular text-xs" :class="x.abx.overdue ? 'font-semibold text-red-700' : 'text-slate-500'">審核期限 {{ x.abx.reviewDueAt.slice(5) }}</div>
              </button>
            </li>
          </ul>
        </UQueryState>
      </UCard>

      <UCard v-if="!item" data-detail><UEmpty title="請從左邊選一筆" description="看病人狀況與使用理由後核准或不核准" /></UCard>
      <div v-else data-detail class="min-w-0 space-y-3">
        <UCard>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span class="text-lg font-bold text-slate-800">{{ item.patientName }}</span>
            <span class="text-sm text-slate-500">{{ item.age }}・病歷號 {{ item.chartNo }}・{{ item.bedNo }}・住院號 {{ item.admitNo }}</span>
            <PatientFlags :flags="item.flags" />
            <span :class="['ml-auto rounded px-2 py-0.5 text-sm', item.allergies.length ? 'bg-red-50 font-medium text-red-700' : 'text-slate-500']">過敏：{{ item.allergies.join('、') || '無已知過敏' }}</span>
          </div>
          <div class="mt-1 text-sm text-slate-700">{{ item.diagnosis }}・{{ item.deptName }} {{ item.attendingName }}</div>
          <div v-if="item.latestVitals" class="tabular mt-1 text-xs text-slate-600">
            生命徵象（{{ item.latestVitals.at.slice(5) }}）：T {{ item.latestVitals.temp ?? '—' }}・P {{ item.latestVitals.pulse ?? '—' }}・BP {{ item.latestVitals.sbp ?? '—' }}/{{ item.latestVitals.dbp ?? '—' }}・SpO2 {{ item.latestVitals.spo2 ?? '—' }}
          </div>
          <div v-if="item.labs.length" class="mt-1 space-y-0.5 text-xs text-slate-600">
            <div v-for="l in item.labs" :key="l.procName">{{ l.procName }}（{{ l.at.slice(5, 10) }}）：<span :class="l.abnormal.length ? 'font-medium text-red-700' : ''">{{ l.abnormal.join('、') || '正常' }}</span></div>
          </div>
          <div class="mt-2 text-xs text-slate-700"><b>目前的抗生素：</b>{{ item.antibiotics.join('；') }}</div>
        </UCard>

        <UCard :title="`${item.order.content}　每次 ${item.order.dose} ${item.order.unit} ${item.order.freq} ${item.order.route}`" :subtitle="item.abx.text">
          <div class="space-y-1 text-sm">
            <div><span class="text-slate-500">使用理由：</span>{{ item.abx.reasonText }}</div>
            <ul class="divide-y divide-slate-100 rounded border border-slate-100 text-xs">
              <li v-for="(s, i) in item.abx.steps" :key="i" class="flex flex-wrap gap-x-2 px-2 py-1">
                <span class="tabular text-slate-500">{{ s.at.slice(5) }}</span>
                <UBadge :tone="s.action === 'approve' ? 'green' : s.action === 'reject' ? 'red' : 'blue'">{{ STEP[s.action] }}</UBadge>
                <span class="text-slate-500">{{ s.byName }}</span>
                <span class="min-w-0 flex-1 text-slate-700">{{ s.text }}<template v-if="s.days">（至第 {{ s.days }} 天）</template></span>
              </li>
            </ul>
          </div>
          <template v-if="tab === 'pending' && data?.canReview">
            <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr]">
              <UInput v-model="form.days" type="number" :label="`核准到療程第幾天（1–${ABX_MAX_DAYS}）`" :error="review.fieldErrors.value.days" />
              <UTextarea v-model="form.note" label="意見（不核准必填：寫建議）" :rows="2" placeholder="例：同意使用，培養報告出來後請降階；建議改用 Ceftriaxone" :error="review.fieldErrors.value.note" />
            </div>
            <div class="mt-3 flex justify-end gap-2">
              <UButton variant="danger" :icon="X" :loading="review.pending.value" @click="decide(false)">不核准</UButton>
              <UButton variant="success" :icon="Check" :loading="review.pending.value" @click="decide(true)">核准</UButton>
            </div>
          </template>
          <p v-else-if="decision" class="mt-2 text-xs text-slate-500">{{ decision.at.slice(5) }} {{ decision.action === 'approve' ? '核准' : '不核准' }}：{{ decision.text }}</p>
        </UCard>
      </div>
    </div>
  </div>
</template>
