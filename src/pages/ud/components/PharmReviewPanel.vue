<script setup lang="ts">
// 藥師住院醫囑審核：左邊待審（臨時、有嚴重問題的在前）、疑義待醫師回覆、最近 24 小時通過；右邊看病人（過敏、腎功能）、
// 醫囑內容與系統列出的問題（過敏、交互作用、重複、劑量、腎功能、管制性抗生素），「通過」（可寫備註）或「疑義」（寫內容）。
// 長期排程的藥通過才會出現在調劑清單；臨時、需要時先給後審。規則都在服務層 pharm.ts
import { computed, ref, watch } from 'vue'
import { Check, MessageCircleQuestion } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UEmpty, UQueryState, UTabs, UTextarea } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { pharmApi, type PharmItem } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'

const { data, loading } = useQuery(() => pharmApi.listPharmReview())
type Tab = 'pending' | 'queried' | 'recent'
const tab = ref<Tab>('pending')
const tabs = computed(() => [
  { key: 'pending', label: '待審核', count: data.value?.pending.length },
  { key: 'queried', label: '疑義待回覆', count: data.value?.queried.length },
  { key: 'recent', label: '最近通過', count: data.value?.recent.length },
])
const list = computed<PharmItem[]>(() => data.value?.[tab.value] ?? [])
const selId = ref<string>()
useRevealOnNarrow(selId)
watch(tab, () => (selId.value = undefined))
const item = computed(() => list.value.find((x) => x.order.id === selId.value))
const note = ref('')
watch(selId, () => (note.value = ''))

const approve = useAction(pharmApi.approvePharm, { success: (o) => `已通過：${o.content}` })
async function onApprove() {
  if (item.value && (await approve.run(item.value.order.id, note.value))) selId.value = undefined
}
const querying = ref(false)
const ask = useAction(pharmApi.queryPharm, { success: '已送出疑義，主治首頁會看到；回覆前暫停給藥' })
async function confirmQuery(text: string) {
  if (item.value && (await ask.run(item.value.order.id, text))) {
    querying.value = false
    selId.value = undefined
  }
}
const typeLabel = (x: PharmItem) => (x.order.type === 'stat' ? '臨時' : x.order.freq === 'PRN' ? '需要時' : '長期')
const RES = { kept: '維持原醫囑', modified: '已修改', stopped: '已停止' } as const
</script>

<template>
  <div class="grid grid-cols-1 gap-4 xl:grid-cols-[24rem_1fr]">
    <UCard :padded="false" class="self-start">
      <div class="px-4 pt-1"><UTabs v-model="tab" :tabs="tabs" /></div>
      <UQueryState :loading="loading && !data" :ready="list.length > 0" :empty-title="tab === 'pending' ? '沒有待審核的醫囑' : tab === 'queried' ? '沒有等醫師回覆的疑義' : '最近 24 小時沒有通過的'">
        <ul class="divide-y divide-slate-100">
          <li v-for="x in list" :key="x.order.id">
            <button type="button" :class="['w-full px-4 py-2.5 text-left text-sm hover:bg-slate-50', x.order.id === selId && '!bg-brand-50']" @click="selId = x.order.id">
              <div class="flex items-center gap-2">
                <span class="tabular rounded bg-slate-100 px-1.5 text-xs">{{ x.bedNo }}</span>
                <span class="font-medium text-slate-800">{{ x.patientName }}</span>
                <UBadge :tone="x.order.type === 'stat' ? 'red' : 'gray'" class="ml-auto">{{ typeLabel(x) }}</UBadge>
              </div>
              <div class="mt-0.5 text-xs text-slate-700">{{ x.order.content }}・每次 {{ x.order.dose }} {{ x.order.unit }} {{ x.order.freq }} {{ x.order.route }}</div>
              <div v-if="x.issues.length" class="mt-1 flex flex-wrap gap-1">
                <UBadge v-for="(i, k) in x.issues" :key="k" :tone="i.level === 'severe' ? 'red' : 'yellow'">{{ i.kind }}</UBadge>
              </div>
              <div class="tabular text-xs text-slate-500">送審 {{ x.order.pharm?.at.slice(5) }}・{{ x.order.doctorName }}</div>
            </button>
          </li>
        </ul>
      </UQueryState>
    </UCard>

    <UCard v-if="!item" data-detail><UEmpty title="請從左邊選一筆" description="看病人狀況與系統列出的問題，通過或提出疑義" /></UCard>
    <div v-else data-detail class="min-w-0 space-y-3">
      <UCard>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span class="text-lg font-bold text-slate-800">{{ item.patientName }}</span>
          <span class="text-sm text-slate-500">{{ item.age }}・{{ item.bedNo }}・住院號 {{ item.admitNo }}</span>
          <span :class="['ml-auto rounded px-2 py-0.5 text-sm', item.allergies.length ? 'bg-red-50 font-medium text-red-700' : 'text-slate-500']">過敏：{{ item.allergies.join('、') || '無已知過敏' }}</span>
        </div>
        <div class="mt-1 text-sm text-slate-700">{{ item.diagnosis }}・主治 {{ item.attendingName }}</div>
        <div class="mt-1 text-xs text-slate-600">{{ item.renal }}</div>
      </UCard>
      <UCard :title="`${item.order.content}　每次 ${item.order.dose} ${item.order.unit} ${item.order.freq} ${item.order.route}`" :subtitle="`${typeLabel(item)}醫囑・${item.order.doctorName} ${item.order.startAt.slice(5)} 開立${item.order.replacesText ? `・修改自 ${item.order.replacesText}` : ''}`">
        <p v-if="item.givenBeforeReview" class="mb-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">先給後審：已給 {{ item.givenBeforeReview }} 劑</p>
        <p v-if="!item.issues.length" class="text-sm text-emerald-700">系統沒有找到問題（過敏、交互作用、重複、劑量、腎功能）。</p>
        <ul v-else class="space-y-1.5">
          <li v-for="(i, k) in item.issues" :key="k" :class="['rounded border px-2 py-1 text-sm', i.level === 'severe' ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-900']">
            <UBadge :tone="i.level === 'severe' ? 'red' : 'yellow'" class="mr-1">{{ i.kind }}</UBadge>{{ i.text }}
          </li>
        </ul>
        <ul v-if="item.queries.length" class="mt-3 divide-y divide-slate-100 rounded border border-slate-100 text-xs">
          <li v-for="(q, k) in item.queries" :key="k" class="px-2 py-1">
            <div><span class="tabular text-slate-500">{{ q.at.slice(5) }}</span> 疑義（{{ q.byName }}）：{{ q.text }}</div>
            <div v-if="q.replyAt" class="text-slate-700"><span class="tabular text-slate-500">{{ q.replyAt.slice(5) }}</span> {{ q.resolution ? RES[q.resolution] : '回覆' }}（{{ q.replyByName }}）：{{ q.reply }}</div>
            <div v-else class="text-amber-800">等醫師回覆（回覆前暫停給藥）</div>
          </li>
        </ul>
        <template v-if="tab === 'pending'">
          <UTextarea v-model="note" class="mt-3" label="備註（選填，通過時記下）" :rows="2" placeholder="例：已和醫師確認劑量" />
          <div class="mt-3 flex justify-end gap-2">
            <UButton variant="secondary" :icon="MessageCircleQuestion" @click="querying = true">疑義</UButton>
            <UButton variant="success" :icon="Check" :loading="approve.pending.value" @click="onApprove">通過</UButton>
          </div>
        </template>
        <p v-else-if="tab === 'recent'" class="mt-2 text-xs text-slate-500">{{ item.approvedByName }} {{ item.order.pharm?.doneAt?.slice(5) }} 通過{{ item.order.pharm?.note ? `：${item.order.pharm.note}` : '' }}</p>
      </UCard>
    </div>

    <ReasonDialog
      v-model="querying"
      title="藥師疑義"
      :subject="item ? `${item.patientName}・${item.order.content}` : ''"
      label="疑義內容（主治會看到，回覆前暫停給藥）"
      :presets="['腎功能不佳，建議調整劑量或頻率', '病人有過敏紀錄，請確認', '與其他藥物有交互作用，建議更換', '與執行中的藥同類重複，建議擇一', '劑量偏高，請確認']"
      ok-text="送出疑義"
      :pending="ask.pending.value"
      :error="ask.fieldErrors.value.text"
      @confirm="confirmQuery"
    />
  </div>
</template>
