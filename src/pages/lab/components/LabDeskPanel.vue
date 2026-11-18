<script setup lang="ts">
// 門診抽血櫃台（醫檢師）：左邊「已批價、還沒報到」的病人 → 報到取號；右邊今天報到的（依號碼）：
// 還沒印條碼的檢驗依容器合併 → 印條碼（尿液、痰液是發容器給病人）→ 採檢（容器是病人交回）→ 送檢驗科收件。
// 被退件的回到「待印條碼」，紅字請病人回來重新採檢。規則在服務層 lab-desk.ts
import { computed, ref } from 'vue'
import { Printer, ScanLine, Ticket } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UDialog, UInput, UQueryState } from '@/components/ui'
import Barcode39 from '@/components/Barcode39.vue'
import { labDeskApi, TUBE_COLOR, type DeskPatient, type DeskSpecimen } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => labDeskApi.labDesk())
const checkIn = useAction(labDeskApi.checkInLab, { success: (c) => `已報到：${c.no} 號` })
const labels = ref<{ p: DeskPatient; xs: DeskSpecimen[] }>()
const print = useAction(labDeskApi.printDeskLabels, { success: (xs) => `已產生 ${xs.length} 支條碼${xs.some((x) => x.selfCollect) ? '（含發給病人的容器）' : ''}` })
async function onPrint(p: DeskPatient) {
  const xs = await print.run(p.patientId)
  if (xs) labels.value = { p, xs }
}
const code = ref('')
const collect = useAction(labDeskApi.collectDeskSpecimen, { success: (s) => `${s.selfCollect ? '已交回' : '已採檢'} ${s.barcode}：${s.tests.join('、')}，送檢驗科` })
async function onScan() {
  if (code.value.trim() && (await collect.run(code.value.trim()))) code.value = ''
}
const doPrint = () => window.print()
const TONE: Record<string, 'blue' | 'yellow' | 'green' | 'red' | 'gray'> = { printed: 'blue', collected: 'yellow', received: 'green', rejected: 'red' }
const open = computed(() => data.value?.checkedIn.filter((p) => p.toPrint.length || p.specimens.some((s) => s.stage === 'printed')) ?? [])
const finished = computed(() => data.value?.checkedIn.filter((p) => !open.value.includes(p)) ?? [])
</script>

<template>
  <UQueryState :loading="loading && !data" :ready="!!data">
    <div v-if="data" class="grid grid-cols-1 gap-4 lg:grid-cols-[18rem_1fr]">
      <UCard :padded="false">
        <template #title><span class="flex items-center gap-2 text-sm font-semibold"><Ticket class="h-4 w-4" />已批價、待報到 <UBadge v-if="data.notCheckedIn.length" tone="yellow">{{ data.notCheckedIn.length }}</UBadge></span></template>
        <p v-if="!data.notCheckedIn.length" class="px-4 py-3 text-sm text-slate-400">沒有待報到的病人</p>
        <ul v-else class="divide-y divide-slate-100 text-sm">
          <li v-for="p in data.notCheckedIn" :key="p.patientId" class="flex items-center gap-2 px-4 py-2">
            <span class="min-w-0 flex-1"><b>{{ p.patientName }}</b> <span class="text-xs text-slate-500">{{ p.chartNo }}</span>
              <span class="block text-xs text-slate-600">{{ p.toPrint.flatMap((g) => g.tests).join('、') }}</span></span>
            <UButton size="sm" :loading="checkIn.pending.value" @click="checkIn.run(p.patientId)">報到</UButton>
          </li>
        </ul>
      </UCard>

      <UCard :padded="false">
        <template #title><span class="flex items-center gap-2 text-sm font-semibold">今天報到（{{ data.date.slice(5) }}）</span></template>
        <div class="space-y-3 p-3 text-sm">
          <form class="flex items-end gap-2" @submit.prevent="onScan">
            <UInput v-model="code" class="flex-1" label="掃條碼採檢／收回容器" placeholder="S2026…" :error="collect.fieldErrors.value.barcode" />
            <UButton type="submit" :icon="ScanLine" :loading="collect.pending.value">採檢</UButton>
          </form>
          <p v-if="!open.length" class="text-xs text-slate-400">報到的病人都採檢完了</p>
          <ul v-else class="divide-y divide-slate-100 rounded border border-slate-200">
            <li v-for="p in open" :key="p.patientId" class="space-y-1 px-3 py-2">
              <div class="flex flex-wrap items-center gap-2">
                <span class="tabular rounded bg-slate-800 px-1.5 text-xs font-bold text-white">{{ p.checkin?.no }} 號</span>
                <b>{{ p.patientName }}</b><span class="text-xs text-slate-500">{{ p.chartNo }}・報到 {{ p.checkin?.at.slice(11) }}</span>
                <UButton v-if="p.toPrint.length" size="sm" class="ml-auto" :icon="Printer" :loading="print.pending.value" @click="onPrint(p)">印條碼</UButton>
              </div>
              <p v-if="p.recollect" class="text-xs font-semibold text-red-700" role="alert">檢體被退件（{{ p.specimens.filter((s) => s.rejectedReason).map((s) => s.rejectedReason).join('、') }}），請病人回來重新採檢</p>
              <ul v-if="p.toPrint.length" class="space-y-0.5 text-xs text-slate-700">
                <li v-for="g in p.toPrint" :key="g.tube" class="flex items-center gap-2"><span :class="['h-3 w-3 rounded-full', TUBE_COLOR[g.tube as keyof typeof TUBE_COLOR]]" />待印條碼・{{ g.tubeLabel }}：{{ g.tests.join('、') }}{{ g.selfCollect ? '（發容器）' : '' }}</li>
              </ul>
              <ul v-if="p.specimens.length" class="space-y-0.5 text-xs">
                <li v-for="s in p.specimens" :key="s.id" class="flex flex-wrap items-center gap-2">
                  <span :class="['h-3 w-3 rounded-full', TUBE_COLOR[s.tube as keyof typeof TUBE_COLOR]]" /><span class="tabular">{{ s.barcode }}</span><span class="min-w-0 flex-1">{{ s.tests.join('、') }}</span>
                  <UBadge :tone="TONE[s.stage] ?? 'gray'">{{ s.stageLabel }}</UBadge>
                  <UButton v-if="s.stage === 'printed'" size="sm" variant="secondary" :loading="collect.pending.value" @click="collect.run(s.barcode)">{{ s.selfCollect ? '收回' : '採檢' }}</UButton>
                </li>
              </ul>
            </li>
          </ul>
          <p v-if="finished.length" class="text-xs text-slate-500">櫃台已處理完（檢體送檢驗科）：{{ finished.map((p) => `${p.checkin?.no} 號 ${p.patientName}`).join('、') }}</p>
        </div>
      </UCard>
    </div>
  </UQueryState>

  <UDialog :model-value="!!labels" title="檢體條碼標籤" size="lg" @update:model-value="(x: boolean) => !x && (labels = undefined)">
    <div v-if="labels" class="print-area grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div v-for="s in labels.xs" :key="s.id" class="rounded border border-slate-800 p-2 text-xs">
        <div class="flex items-center gap-2"><span :class="['h-3 w-6 rounded', TUBE_COLOR[s.tube as keyof typeof TUBE_COLOR]]" /><b>{{ s.tubeLabel }}</b><span class="ml-auto">門診 {{ labels.p.checkin?.no }} 號</span></div>
        <div class="mt-1"><b>{{ labels.p.patientName }}</b>・病歷號 {{ labels.p.chartNo }}</div>
        <div class="flex justify-center"><Barcode39 :value="s.barcode" :height="34" /></div>
        <div class="mt-1">{{ s.tests.join('、') }}{{ s.selfCollect ? '（容器交給病人）' : '' }}</div>
      </div>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="labels = undefined">關閉</UButton>
      <UButton :icon="Printer" @click="doPrint">列印標籤</UButton>
    </template>
  </UDialog>
</template>
