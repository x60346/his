<script setup lang="ts">
// 病安通報：所有臨床人員都能通報（可匿名：審查的人看不到通報人，自己看得到）；從護理站掃描統計的「掃描不符」按「通報」會帶入（?fromScan=）。
// 有「病安事件審查」權限的人（預設管理員，示範 nurse02 護理長）在下方審查：評定 SAC、原因分析、改善措施、結案；近 30 天統計。服務層 incident.ts
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ShieldAlert } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UCheckbox, UInput, UPageHeader, UQueryState, USelect, UTextarea } from '@/components/ui'
import { INCIDENT_CATEGORY_LABEL, INCIDENT_HARM_LABEL, incidentApi, patientApi, SAC_LABEL, type IncidentView } from '@/services'
import type { IncidentCategory, IncidentHarm } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { now } from '@/utils/date'

const route = useRoute()
const blank = () => ({ category: '' as IncidentCategory | '', d: now().slice(0, 10), tm: now().slice(11), location: '', chartNo: '', description: '', harm: '' as IncidentHarm | '', immediateAction: '', anonymous: false, fromScanMismatchId: '' })
const form = reactive(blank())
const patientId = ref<string>()
const patientName = ref('')
// 從掃描不符帶入
watch(() => route.query.fromScan, async (id) => {
  if (!id) return
  const d = await incidentApi.incidentDraftFromScan(String(id)).catch(() => undefined)
  if (!d) return
  Object.assign(form, { category: d.category, d: d.occurredAt.slice(0, 10), tm: d.occurredAt.slice(11), location: d.location, description: d.description, harm: d.harm, immediateAction: d.immediateAction ?? '', fromScanMismatchId: d.fromScanMismatchId ?? '' })
  patientId.value = d.patientId
  patientName.value = ''
}, { immediate: true })
async function lookup() {
  patientId.value = undefined
  patientName.value = ''
  const kw = form.chartNo.trim()
  if (!kw) return
  const hit = (await patientApi.searchPatients(kw)).find((p) => p.chartNo === kw)
  if (hit) {
    patientId.value = hit.id
    patientName.value = hit.name
  } else patientName.value = '找不到這個病歷號'
}
const report = useAction(incidentApi.reportIncident, { success: (x) => `已通報 ${x.no}${x.anonymous ? '（匿名）' : ''}，謝謝您的通報` })
async function submit() {
  const r = await report.run({
    category: form.category as IncidentCategory, occurredAt: `${form.d} ${form.tm}`, location: form.location, ...(patientId.value ? { patientId: patientId.value } : {}),
    description: form.description, harm: form.harm as IncidentHarm, immediateAction: form.immediateAction, anonymous: form.anonymous, ...(form.fromScanMismatchId ? { fromScanMismatchId: form.fromScanMismatchId } : {}),
  })
  if (r) {
    Object.assign(form, blank())
    patientId.value = undefined
    patientName.value = ''
  }
}
const { data: mine } = useQuery(() => incidentApi.myIncidents())
const { data: access } = useQuery(() => incidentApi.incidentAccess())
const { data: board, loading } = useQuery(async () => (access.value?.canReview ? incidentApi.listIncidents() : undefined), [() => access.value?.canReview])
// 審查
const rv = reactive<Record<string, { sac: number; cause: string; actions: string }>>({})
const rvOf = (x: IncidentView) => (rv[x.id] ??= { sac: x.review?.sac ?? x.sacSuggested, cause: x.review?.cause ?? '', actions: x.review?.actions ?? '' })
const review = useAction(incidentApi.reviewIncident, { success: (x) => (x.status === 'closed' ? `${x.no} 已結案` : `${x.no} 已儲存審查`) })
const opened = ref<string>()
const STATUS_TONE = { reported: 'red', reviewing: 'yellow', closed: 'green' } as const
const catOptions = computed(() => Object.entries(INCIDENT_CATEGORY_LABEL).map(([value, label]) => ({ value, label })))
const harmOptions = computed(() => Object.entries(INCIDENT_HARM_LABEL).map(([value, label]) => ({ value, label })))
const sacOptions = [1, 2, 3, 4].map((v) => ({ value: v, label: SAC_LABEL[v as 1 | 2 | 3 | 4] }))
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="病安通報" description="跌倒、給藥、管路、檢體或其他異常事件：通報是為了改善流程，不是追究個人；可以匿名" />
    <UCard>
      <template #title><span class="flex items-center gap-2 text-sm font-semibold"><ShieldAlert class="h-4 w-4" />通報事件</span></template>
      <div class="space-y-3 text-sm">
        <p v-if="form.fromScanMismatchId" class="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-900">由掃描不符帶入（跡近錯失）：請確認內容後送出</p>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <USelect v-model="form.category" label="類別" placeholder="請選擇" :options="catOptions" :error="report.fieldErrors.value.category" />
          <UInput v-model="form.d" type="date" label="發生日期" :error="report.fieldErrors.value.occurredAt" />
          <UInput v-model="form.tm" type="time" label="時間" />
          <UInput v-model="form.location" label="地點" placeholder="例：5A 病房 502 床" :error="report.fieldErrors.value.location" />
        </div>
        <div class="flex flex-wrap items-end gap-2">
          <UInput v-model="form.chartNo" class="w-40" label="病人病歷號（可不填）" @blur="lookup" @keydown.enter.prevent="lookup" />
          <span class="pb-2 text-xs" :class="patientId ? 'text-slate-700' : 'text-red-600'">{{ patientId && !patientName ? '（已帶入病人）' : patientName }}</span>
          <USelect v-model="form.harm" class="min-w-[16rem]" label="對病人的影響" placeholder="請選擇" :options="harmOptions" :error="report.fieldErrors.value.harm" />
        </div>
        <UTextarea v-model="form.description" label="事件經過（發生什麼、怎麼發現的）" :rows="3" :error="report.fieldErrors.value.description" />
        <UInput v-model="form.immediateAction" label="當下的處置（選填）" placeholder="例：通知醫師評估、重新核對後給藥" />
        <div class="flex flex-wrap items-center gap-3">
          <UCheckbox v-model="form.anonymous" label="匿名通報（審查的人看不到是誰）" />
          <UButton class="ml-auto" :loading="report.pending.value" @click="submit">送出通報</UButton>
        </div>
      </div>
    </UCard>

    <UCard v-if="mine?.length" title="我通報的" :padded="false">
      <ul class="divide-y divide-slate-100 text-sm">
        <li v-for="x in mine" :key="x.id" class="flex flex-wrap items-center gap-2 px-4 py-2">
          <span class="tabular text-xs text-slate-500">{{ x.no }}</span><UBadge :tone="STATUS_TONE[x.status]">{{ x.statusLabel }}</UBadge>
          <b>{{ x.categoryLabel }}</b><span class="text-xs text-slate-600">{{ x.harmLabel }}</span><span v-if="x.anonymous" class="text-xs text-slate-500">（匿名）</span>
          <span class="min-w-0 flex-1 truncate text-xs text-slate-600">{{ x.description }}</span>
          <span v-if="x.review?.actions && x.status === 'closed'" class="w-full text-xs text-emerald-800">改善措施：{{ x.review.actions }}</span>
        </li>
      </ul>
    </UCard>

    <UQueryState v-if="access?.canReview" :loading="loading && !board" :ready="!!board">
      <UCard v-if="board" :padded="false">
        <template #title>
          <span class="flex flex-wrap items-center gap-2 text-sm font-semibold">審查 <UBadge v-if="board.pending" tone="red">待處理 {{ board.pending }}</UBadge>
            <span class="text-xs font-normal text-slate-500">近 30 天 {{ board.stats.total }} 件（{{ board.stats.byCategory.filter((c) => c.count).map((c) => `${c.label} ${c.count}`).join('、') || '—' }}）・結案率 {{ board.stats.closeRate }}%</span></span>
        </template>
        <ul class="divide-y divide-slate-100 text-sm">
          <li v-for="x in board.items" :key="x.id" class="space-y-1 px-4 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <UBadge :tone="STATUS_TONE[x.status]">{{ x.statusLabel }}</UBadge><span class="tabular text-xs text-slate-500">{{ x.no }}</span>
              <b>{{ x.categoryLabel }}</b><span class="text-xs">{{ x.harmLabel }}</span>
              <span class="text-xs text-slate-600">{{ x.occurredAt.slice(5) }}・{{ x.location }}{{ x.patientName ? `・${x.patientName}` : '' }}</span>
              <span class="text-xs text-slate-500">通報：{{ x.reporterName }}</span>
              <UBadge v-if="x.sacLabel" tone="purple">{{ x.sacLabel }}</UBadge>
              <UButton size="sm" variant="ghost" class="ml-auto" @click="opened = opened === x.id ? undefined : x.id">{{ opened === x.id ? '收起' : x.status === 'closed' ? '看內容' : '審查' }}</UButton>
            </div>
            <div v-if="opened === x.id" class="space-y-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs">
              <p>{{ x.description }}</p>
              <p v-if="x.immediateAction" class="text-slate-600">當下處置：{{ x.immediateAction }}</p>
              <template v-if="x.status !== 'closed'">
                <USelect v-model="rvOf(x).sac" class="w-48" label="嚴重度" :options="sacOptions" :error="review.fieldErrors.value.sac" />
                <UTextarea v-model="rvOf(x).cause" label="原因分析" :rows="2" :error="review.fieldErrors.value.cause" />
                <UTextarea v-model="rvOf(x).actions" label="改善措施" :rows="2" :error="review.fieldErrors.value.actions" />
                <div class="flex justify-end gap-2">
                  <UButton size="sm" variant="secondary" :loading="review.pending.value" @click="review.run(x.id, { ...rvOf(x) })">儲存審查</UButton>
                  <UButton size="sm" :loading="review.pending.value" @click="review.run(x.id, { ...rvOf(x), close: true })">結案</UButton>
                </div>
              </template>
              <template v-else>
                <p><b>原因分析：</b>{{ x.review?.cause }}</p>
                <p><b>改善措施：</b>{{ x.review?.actions }}</p>
                <p class="text-slate-500">{{ x.reviewerName }} {{ x.review?.closedAt?.slice(5) }} 結案</p>
              </template>
            </div>
          </li>
        </ul>
      </UCard>
    </UQueryState>
  </div>
</template>
