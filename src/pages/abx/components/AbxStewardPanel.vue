<script setup lang="ts">
// 抗生素每日審視（感染科）：全院住院中在用的抗生素，系統依規則標建議（藥敏無效、重疊、可降階、可改口服、超過 7 天）。
// 左邊四個分頁：待審視（有還沒處理的建議）、全部在用、待主治回覆、最近處理（7 天）；右邊看病人、藥敏、這筆的每條建議，
// 「發出建議」（寫給主治）或「不用介入」（寫理由）。主治在住院醫囑停止或修改＝接受，不接受要寫原因。規則都在服務層
import { computed, ref, watch } from 'vue'
import { UBadge, UButton, UCard, UEmpty, UQueryState, UTabs } from '@/components/ui'
import PatientFlags from '@/components/PatientFlags.vue'
import CultureView from '@/components/CultureView.vue'
import AbxTimeline from '@/components/AbxTimeline.vue'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { abxStewardApi, type AbxInterventionView, type StewardFindingView, type StewardItem } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'

const { data, loading } = useQuery(() => abxStewardApi.listAbxStewardship())
type Tab = 'todo' | 'all' | 'sent' | 'done'
const tab = ref<Tab>('todo')
const todo = computed(() => (data.value?.items ?? []).filter((x) => x.open > 0))
const sent = computed(() => (data.value?.interventions ?? []).filter((x) => x.status === 'sent'))
const done = computed(() => (data.value?.interventions ?? []).filter((x) => x.status !== 'sent'))
const tabs = computed(() => [
  { key: 'todo', label: '待審視', count: todo.value.length },
  { key: 'all', label: '全部在用', count: data.value?.items.length },
  { key: 'sent', label: '待主治回覆', count: sent.value.length },
  { key: 'done', label: '最近處理', count: done.value.length },
])
const items = computed<StewardItem[]>(() => (tab.value === 'todo' ? todo.value : data.value?.items ?? []))
const ivs = computed<AbxInterventionView[]>(() => (tab.value === 'sent' ? sent.value : done.value))
const isOrderTab = computed(() => tab.value === 'todo' || tab.value === 'all')

// 選取：醫囑分頁選醫囑、介入分頁選介入（醫囑還在用就一起顯示病人與藥敏）
const selId = ref<string>()
useRevealOnNarrow(selId)
watch(tab, () => (selId.value = undefined))
const selIv = computed(() => (isOrderTab.value ? undefined : ivs.value.find((x) => x.id === selId.value)))
const item = computed(() => data.value?.items.find((x) => x.order.id === (isOrderTab.value ? selId.value : selIv.value?.orderId)))

const KIND_TONE = { ineffective: 'red', overlap: 'red', renal: 'red', prophylaxis: 'yellow', deescalate: 'yellow', ivpo: 'blue', duration: 'yellow' } as const
const STATUS_TONE = { sent: 'blue', accepted: 'green', declined: 'red', dismissed: 'gray' } as const

const acting = ref<{ f: StewardFindingView; kind: 'sent' | 'dismissed' }>()
const actingOpen = computed({ get: () => !!acting.value, set: (v) => !v && (acting.value = undefined) })
const send = useAction(abxStewardApi.sendAbxAdvice, { success: '已發出建議，主治首頁會看到「抗生素建議待回覆」' })
const dismiss = useAction(abxStewardApi.dismissAbxFinding, { success: '已標不用介入' })
const act = computed(() => (acting.value?.kind === 'sent' ? send : dismiss))
async function confirmAct(note: string) {
  const x = acting.value
  if (x && (await act.value.run(x.f.orderId, x.f.kind, note))) acting.value = undefined
}
const presets = computed(() => {
  const f = acting.value?.f
  if (acting.value?.kind === 'dismissed') return ['已和主治討論，維持原用藥', '感染部位需較長療程', '病人仍在發燒、尚未穩定']
  return f?.kind === 'ineffective' ? ['藥敏抗藥，建議依藥敏改藥'] : f?.kind === 'overlap' ? ['範圍重疊，建議停用較窄效的那一支'] : f?.kind === 'renal' ? ['腎功能下降，建議依 CrCl 調整頻率'] : f?.kind === 'prophylaxis' ? ['手術預防用藥已超過 24 小時，建議停藥'] : f?.kind === 'deescalate' ? ['培養結果已出，建議降階'] : f?.kind === 'ivpo' ? ['臨床穩定、可進食，建議改口服'] : ['療程已足，建議停藥']
})
</script>

<template>
  <div class="grid grid-cols-1 gap-4 xl:grid-cols-[24rem_1fr]">
    <UCard :padded="false" class="self-start">
      <div class="px-4 pt-1"><UTabs v-model="tab" :tabs="tabs" /></div>
      <p v-if="data && !data.canReview" class="mx-4 mt-2 rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">每日審視由感染科醫師處理；您可以查看建議與回覆。</p>
      <UQueryState v-if="isOrderTab" :loading="loading && !data" :ready="items.length > 0" :empty-title="tab === 'todo' ? '沒有待審視的抗生素' : '住院中沒有在用的抗生素'">
        <ul class="divide-y divide-slate-100">
          <li v-for="x in items" :key="x.order.id">
            <button type="button" :class="['w-full px-4 py-2.5 text-left text-sm hover:bg-slate-50', x.order.id === selId && '!bg-brand-50']" @click="selId = x.order.id">
              <div class="flex items-center gap-2">
                <span class="tabular rounded bg-slate-100 px-1.5 text-xs">{{ x.bedNo }}</span>
                <span class="font-medium text-slate-800">{{ x.patientName }}</span>
                <span class="tabular ml-auto text-xs text-slate-500">第 {{ x.courseDay }} 天</span>
              </div>
              <div class="mt-0.5 text-xs text-slate-700">{{ x.order.content }}・{{ x.order.route }} {{ x.order.freq }}</div>
              <div v-if="x.findings.length" class="mt-1 flex flex-wrap gap-1">
                <UBadge v-for="f in x.findings" :key="f.kind" :tone="f.handled ? 'gray' : KIND_TONE[f.kind]">{{ f.label }}<template v-if="f.handled">・{{ f.handled.statusLabel }}</template></UBadge>
              </div>
            </button>
          </li>
        </ul>
      </UQueryState>
      <UQueryState v-else :loading="loading && !data" :ready="ivs.length > 0" :empty-title="tab === 'sent' ? '沒有等主治回覆的建議' : '最近 7 天沒有處理紀錄'">
        <ul class="divide-y divide-slate-100">
          <li v-for="v in ivs" :key="v.id">
            <button type="button" :class="['w-full px-4 py-2.5 text-left text-sm hover:bg-slate-50', v.id === selId && '!bg-brand-50']" @click="selId = v.id">
              <div class="flex items-center gap-2">
                <span class="tabular rounded bg-slate-100 px-1.5 text-xs">{{ v.bedNo }}</span>
                <span class="font-medium text-slate-800">{{ v.patientName }}</span>
                <UBadge :tone="STATUS_TONE[v.status]" class="ml-auto">{{ v.statusLabel }}</UBadge>
              </div>
              <div class="mt-0.5 text-xs text-slate-700">{{ v.orderText }}・{{ v.kindLabel }}</div>
              <div class="tabular text-xs text-slate-500">{{ v.at.slice(5) }} {{ v.byName }}・主治 {{ v.attendingName }}</div>
            </button>
          </li>
        </ul>
      </UQueryState>
    </UCard>

    <UCard v-if="!item && !selIv" data-detail><UEmpty title="請從左邊選一筆" description="看病人狀況、藥敏與系統的建議，發出建議或標不用介入" /></UCard>
    <div v-else data-detail class="min-w-0 space-y-3">
      <!-- 介入紀錄（待主治回覆、最近處理） -->
      <UCard v-if="selIv" :title="`${selIv.kindLabel}：${selIv.orderText}`" :subtitle="`${selIv.patientName}・${selIv.bedNo}・主治 ${selIv.attendingName}`">
        <div class="space-y-1 text-sm">
          <div><span class="text-slate-500">系統：</span>{{ selIv.finding }}</div>
          <div><span class="text-slate-500">{{ selIv.status === 'dismissed' ? '不用介入' : '建議' }}（{{ selIv.byName }} {{ selIv.at.slice(5) }}）：</span>{{ selIv.note }}</div>
          <div v-if="selIv.reply" :class="selIv.status === 'declined' ? 'text-red-700' : 'text-emerald-700'"><span class="text-slate-500">主治{{ selIv.statusLabel }}（{{ selIv.replyByName }} {{ selIv.reply.at.slice(5) }}）：</span>{{ selIv.reply.text }}</div>
          <div v-else-if="selIv.status === 'sent'" class="text-sky-700">等主治回覆（停止或修改醫囑＝接受）</div>
        </div>
        <p v-if="!item" class="mt-2 text-xs text-slate-500">這筆醫囑已停止或病人已出院。</p>
      </UCard>

      <template v-if="item">
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
          <div v-if="item.renal" class="mt-1 text-xs text-slate-600">{{ item.renal }}</div>
          <div class="mt-2 text-xs text-slate-700"><b>目前的抗生素：</b>{{ item.antibiotics.join('；') }}</div>
        </UCard>

        <UCard :title="`${item.order.content}　每次 ${item.order.dose} ${item.order.unit} ${item.order.freq} ${item.order.route}`" :subtitle="`療程第 ${item.courseDay} 天（${item.courseStart.slice(5, 10)} 起）${item.order.abxInfo ? `・管制性抗生素 ${item.order.abxInfo.statusLabel}` : ''}`">
          <p v-if="!item.findings.length" class="text-sm text-slate-500">系統沒有標出建議。</p>
          <ul v-else class="space-y-2">
            <li v-for="f in item.findings" :key="f.kind" class="rounded border border-slate-200 px-3 py-2 text-sm">
              <div class="flex flex-wrap items-center gap-2">
                <UBadge :tone="KIND_TONE[f.kind]">{{ f.label }}</UBadge>
                <span class="min-w-0 flex-[1_1_10rem] text-slate-800">{{ f.text }}</span>
              </div>
              <div v-if="f.handled" class="mt-1 text-xs text-slate-600">
                <UBadge :tone="STATUS_TONE[f.handled.status]">{{ f.handled.statusLabel }}</UBadge>
                {{ f.handled.byName }} {{ f.handled.at.slice(5) }}<template v-if="f.handled.orderId !== f.orderId">（對 {{ f.handled.orderText }}）</template>：{{ f.handled.note }}
                <template v-if="f.handled.reply">；主治 {{ f.handled.replyByName }}：{{ f.handled.reply.text }}</template>
              </div>
              <div v-else-if="data?.canReview" class="mt-2 flex justify-end gap-2">
                <UButton size="sm" variant="ghost" @click="acting = { f, kind: 'dismissed' }">不用介入</UButton>
                <UButton size="sm" @click="acting = { f, kind: 'sent' }">發出建議</UButton>
              </div>
            </li>
          </ul>
        </UCard>

        <UCard title="抗生素時間軸" subtitle="這次住院：用藥、培養、腎功能、谷濃度、感染科建議"><AbxTimeline :admission-id="item.admissionId" /></UCard>

        <UCard v-if="item.culture" title="最近一次長菌的培養" :subtitle="`報告 ${item.culture.reportedAt.slice(5)}`">
          <CultureView :culture="item.culture.culture" />
        </UCard>
      </template>
    </div>

    <ReasonDialog
      v-model="actingOpen"
      :title="acting?.kind === 'sent' ? '發出抗生素建議' : '不用介入'"
      :subject="acting ? `${acting.f.label}：${acting.f.text}` : ''"
      :label="acting?.kind === 'sent' ? '給主治的建議（主治會在住院醫囑看到）' : '不用介入的理由'"
      :presets="presets"
      :ok-text="acting?.kind === 'sent' ? '發出建議' : '確定'"
      :pending="send.pending.value || dismiss.pending.value"
      :error="act.fieldErrors.value.note"
      @confirm="confirmAct"
    />
  </div>
</template>
