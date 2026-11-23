<script setup lang="ts">
// 門診抽血櫃台（醫檢師）：左邊「已批價、還沒報到」的病人 → 報到取號；右邊今天報到的（依號碼）：
// 還沒印條碼的檢驗依容器合併 → 印條碼（尿液、痰液是發容器給病人）→ 採檢（容器是病人交回）→ 送檢驗科收件。
// 被退件的回到「待印條碼」，紅字請病人回來重新採檢。上方叫號看板：叫下一位、重叫（最多 3 次）、過號、過號的回來重新排隊；
// 叫到號才能印條碼採檢。規則在服務層 lab-desk.ts、lab-queue-rules
import { computed, reactive, ref } from 'vue'
import { BellRing, ExternalLink, Printer, ScanLine, SkipForward, Ticket, Undo2 } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UDialog, UInput, UQueryState } from '@/components/ui'
import Barcode39 from '@/components/Barcode39.vue'
import FastingCollect from '@/components/FastingCollect.vue'
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
// 叫號
const callNext = useAction(labDeskApi.callNextLab, { success: (c) => `叫號：${c.no} 號 → ${c.window} 號窗口` })
// 多窗口：開窗（一人一個窗口）、關窗；沒開窗按「叫下一位」會自動開最小的空窗口
const openWin = useAction(labDeskApi.openLabWindow, { success: (r) => `已開 ${r.window} 號窗口` })
const closeWin = useAction(labDeskApi.closeLabWindow, { success: (r) => `已關 ${r.window} 號窗口` })
const recall = useAction(labDeskApi.recallLab, { success: (c) => `重叫 ${c.no} 號` })
const skip = useAction(labDeskApi.skipLab, { success: (c) => `${c.no} 號過號` })
const back = useAction(labDeskApi.returnLab, { success: (c) => `${c.no} 號回來了，重新排隊` })
const QTONE = { waiting: 'gray', called: 'blue', served: 'green', skipped: 'red' } as const
// 優先：報到時選（75 歲以上自動）；報到後也能改
const prio = reactive<Record<string, '' | 'disabled' | 'mobility'>>({})
async function onCheckIn(p: DeskPatient) {
  const x = prio[p.patientId]
  await checkIn.run(p.patientId, x ? { priority: x } : {})
}
const setPrio = useAction(labDeskApi.setLabPriority, { success: (c) => (c.priority ? `${c.no} 號改為優先` : `${c.no} 號取消優先`) })
const screenUrl = `${location.origin}${location.pathname}#/queue`
const TONE: Record<string, 'blue' | 'yellow' | 'green' | 'red' | 'gray'> = { printed: 'blue', collected: 'yellow', received: 'green', rejected: 'red' }
const open = computed(() => data.value?.checkedIn.filter((p) => p.toPrint.length || p.specimens.some((s) => s.stage === 'printed')) ?? [])
const finished = computed(() => data.value?.checkedIn.filter((p) => !open.value.includes(p)) ?? [])
</script>

<template>
  <UQueryState :loading="loading && !data" :ready="!!data">
    <div v-if="data" class="space-y-4">
    <!-- 窗口：誰開著、正在叫幾號、今天採了幾位 -->
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <div v-for="w in data.queue.windows" :key="w.window" :class="['flex min-w-[11rem] items-center gap-2 rounded-md border px-3 py-1.5', w.mine ? 'border-brand-400 bg-brand-50' : 'border-slate-200 bg-white']">
        <b class="tabular text-slate-800">{{ w.window }} 號窗口</b><span v-if="w.label" class="rounded bg-amber-100 px-1 text-xs text-amber-800">{{ w.label }}</span>
        <span v-if="w.userName" class="text-xs text-slate-600">{{ w.userName }}{{ w.mine ? '（我）' : '' }}・{{ w.current ? `叫 ${w.current.no} 號` : '空著' }}・已採 {{ w.served }}</span>
        <span v-else class="text-xs text-slate-400">沒開</span>
        <UButton v-if="!w.userName && !data.queue.myWindow" size="sm" variant="secondary" class="ml-auto" :loading="openWin.pending.value" @click="openWin.run(w.window)">開窗</UButton>
        <UButton v-if="w.mine" size="sm" variant="ghost" class="ml-auto" :loading="closeWin.pending.value" @click="closeWin.run()">關窗</UButton>
      </div>
    </div>
    <!-- 叫號看板 -->
    <div class="flex flex-wrap items-stretch gap-3 rounded-md border border-slate-200 bg-white p-3 text-sm">
      <div class="flex min-w-[9rem] flex-col items-center justify-center rounded bg-slate-800 px-4 py-2 text-white">
        <span class="text-xs text-slate-300">{{ data.queue.myWindow ? `${data.queue.myWindow} 號窗口叫號` : '目前叫號' }}</span>
        <span class="tabular text-3xl font-bold">{{ data.queue.current ? data.queue.current.no : '—' }}</span>
        <span v-if="data.queue.current" class="text-xs">{{ data.queue.current.patientName }}・第 {{ data.queue.current.calls }} 次</span>
      </div>
      <div class="flex min-w-[14rem] flex-1 flex-col gap-2">
        <div class="flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <span>等候 <b class="tabular text-base text-slate-900">{{ data.queue.waiting.length }}</b> 位</span>
          <span v-for="l in data.queue.lanes.filter((x) => x.called)" :key="l.lane" class="text-xs text-slate-500">{{ l.label }}：叫了 {{ l.called }} 位・平均等 {{ l.avgWait ?? '—' }} 分</span>
          <span>今天平均等候 <b class="tabular text-base text-slate-900">{{ data.queue.avgWait ?? '—' }}</b> 分鐘</span>
          <a :href="screenUrl" target="_blank" rel="noopener" class="ml-auto inline-flex items-center gap-1 text-blue-700 hover:underline"><ExternalLink class="h-3.5 w-3.5" />候診螢幕</a>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton :icon="BellRing" :loading="callNext.pending.value" :disabled="!!data.queue.current || !data.queue.waiting.length" @click="callNext.run()">叫下一位</UButton>
          <template v-if="data.queue.current">
            <UButton variant="secondary" :icon="BellRing" :loading="recall.pending.value" :disabled="data.queue.current.calls >= data.queue.maxCalls" @click="recall.run(data.queue.current.patientId)">重叫</UButton>
            <UButton variant="ghost" :icon="SkipForward" :loading="skip.pending.value" @click="skip.run(data.queue.current.patientId)">過號</UButton>
          </template>
        </div>
        <p v-if="data.queue.current" class="text-xs text-slate-500">病人來了就在下方按「印條碼」開始採檢；叫了 {{ data.queue.maxCalls }} 次沒來請過號</p>
        <p v-if="data.queue.waiting.length" class="flex flex-wrap items-center gap-1 text-xs text-slate-600">接下來：
          <span v-for="w in data.queue.waiting" :key="w.no" :class="['rounded px-1', w.priorityLabel ? 'bg-violet-100 text-violet-800' : w.drop ? 'bg-amber-100 text-amber-800' : 'bg-slate-100']">{{ w.no }} 號{{ w.drop ? '（交檢體）' : '' }}{{ w.priorityLabel ? `（優先・${w.priorityLabel}）` : '' }}{{ w.returned ? '（過號回來）' : '' }}</span>
        </p>
        <p v-if="data.queue.waiting.some((w) => w.priorityLabel)" class="text-xs text-slate-400">優先排在一般前面；連續叫兩位優先後輪一位一般</p>
        <p v-if="data.queue.waiting.some((w) => w.drop)" class="text-xs text-slate-400">{{ data.queue.dropOpen ? '只交檢體（尿液、痰液）的走 3 號檢體窗口；抽血窗口抽血的叫完才幫忙叫' : '3 號檢體窗口沒開：交檢體的和抽血的排同一條' }}</p>
        <p v-if="data.queue.skipped.length" class="flex flex-wrap items-center gap-2 text-xs text-red-700">過號：
          <span v-for="s in data.queue.skipped" :key="s.no" class="inline-flex items-center gap-1">{{ s.no }} 號 {{ s.patientName }}
            <UButton size="sm" variant="secondary" :icon="Undo2" :loading="back.pending.value" @click="back.run(s.patientId)">回來了</UButton></span>
        </p>
      </div>
    </div>
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-[18rem_1fr]">
      <UCard :padded="false">
        <template #title><span class="flex items-center gap-2 text-sm font-semibold"><Ticket class="h-4 w-4" />已批價、待報到 <UBadge v-if="data.notCheckedIn.length" tone="yellow">{{ data.notCheckedIn.length }}</UBadge></span></template>
        <p v-if="!data.notCheckedIn.length" class="px-4 py-3 text-sm text-slate-400">沒有待報到的病人</p>
        <ul v-else class="divide-y divide-slate-100 text-sm">
          <li v-for="p in data.notCheckedIn" :key="p.patientId" class="flex items-center gap-2 px-4 py-2">
            <span class="min-w-0 flex-1"><b>{{ p.patientName }}</b> <span class="text-xs text-slate-500">{{ p.chartNo }}</span>
              <span class="block text-xs text-slate-600">{{ p.toPrint.flatMap((g) => g.tests).join('、') }}</span></span>
            <UBadge v-if="p.autoPriority" tone="purple">75 歲以上・優先</UBadge>
            <select v-else v-model="prio[p.patientId]" class="form-control w-24 py-1 text-xs" aria-label="優先">
              <option value="">一般</option><option value="disabled">身心障礙</option><option value="mobility">行動不便</option>
            </select>
            <UButton size="sm" :loading="checkIn.pending.value" @click="onCheckIn(p)">報到</UButton>
          </li>
        </ul>
      </UCard>

      <UCard :padded="false">
        <template #title><span class="flex items-center gap-2 text-sm font-semibold">今天報到（{{ data.date.slice(5) }}）</span></template>
        <div class="space-y-3 p-3 text-sm">
          <form class="flex items-end gap-2" @submit.prevent="onScan">
            <UInput v-model="code" class="flex-1" label="掃條碼採檢／收回容器" placeholder="S2026…" :error="collect.fieldErrors.value.barcode ?? (collect.fieldErrors.value.fasting ? `${collect.fieldErrors.value.fasting}：請在下方按「採檢（空腹）」或「非空腹」` : undefined)" />
            <UButton type="submit" :icon="ScanLine" :loading="collect.pending.value">採檢</UButton>
          </form>
          <p v-if="!open.length" class="text-xs text-slate-400">報到的病人都採檢完了</p>
          <ul v-else class="divide-y divide-slate-100 rounded border border-slate-200">
            <li v-for="p in open" :key="p.patientId" class="space-y-1 px-3 py-2">
              <div class="flex flex-wrap items-center gap-2">
                <span class="tabular rounded bg-slate-800 px-1.5 text-xs font-bold text-white">{{ p.checkin?.no }} 號</span>
                <b>{{ p.patientName }}</b><span class="text-xs text-slate-500">{{ p.chartNo }}・報到 {{ p.checkin?.at.slice(11) }}</span>
                <UBadge v-if="p.queue" :tone="QTONE[p.queue]">{{ p.queueLabel }}</UBadge>
                <UBadge v-if="p.laneLabel" tone="yellow">{{ p.laneLabel }}</UBadge>
                <UBadge v-if="p.priorityLabel" tone="purple">優先・{{ p.priorityLabel }}</UBadge>
                <select v-else-if="p.queue && p.queue !== 'served'" class="form-control w-28 py-0.5 text-xs" aria-label="改為優先" @change="(ev) => { const v = (ev.target as HTMLSelectElement).value; if (v) setPrio.run(p.patientId, v as 'disabled' | 'mobility') }">
                  <option value="">設為優先…</option><option value="disabled">身心障礙</option><option value="mobility">行動不便</option>
                </select>
                <UButton v-if="p.priorityLabel && p.checkin?.priority !== 'elderly' && p.queue !== 'served'" size="sm" variant="ghost" :loading="setPrio.pending.value" @click="setPrio.run(p.patientId, null)">取消優先</UButton>
                <UButton v-if="p.toPrint.length" size="sm" class="ml-auto" :icon="Printer" :loading="print.pending.value" :disabled="p.queue === 'waiting' || p.queue === 'skipped'" :title="p.queue === 'waiting' ? '還沒叫到號' : p.queue === 'skipped' ? '已過號' : ''" @click="onPrint(p)">印條碼</UButton>
              </div>
              <p v-if="p.recollect" class="text-xs font-semibold text-red-700" role="alert">檢體被退件（{{ p.specimens.filter((s) => s.rejectedReason).map((s) => s.rejectedReason).join('、') }}），請病人回來重新採檢</p>
              <ul v-if="p.toPrint.length" class="space-y-0.5 text-xs text-slate-700">
                <li v-for="g in p.toPrint" :key="g.tube" class="flex items-center gap-2"><span :class="['h-3 w-3 rounded-full', TUBE_COLOR[g.tube as keyof typeof TUBE_COLOR]]" />待印條碼・{{ g.tubeLabel }}：{{ g.tests.join('、') }}{{ g.selfCollect ? '（發容器）' : '' }}</li>
              </ul>
              <ul v-if="p.specimens.length" class="space-y-0.5 text-xs">
                <li v-for="s in p.specimens" :key="s.id" class="flex flex-wrap items-center gap-2">
                  <span :class="['h-3 w-3 rounded-full', TUBE_COLOR[s.tube as keyof typeof TUBE_COLOR]]" /><span class="tabular">{{ s.barcode }}</span><span class="min-w-0 flex-[1_1_10rem]">{{ s.tests.join('、') }}</span>
                  <UBadge :tone="TONE[s.stage] ?? 'gray'">{{ s.stageLabel }}</UBadge>
                  <UBadge v-if="s.fastingLabel" :tone="s.fastingLabel === '空腹' ? 'gray' : 'yellow'">{{ s.fastingLabel }}</UBadge>
                  <FastingCollect v-if="s.stage === 'printed'" :needs-fasting="s.needsFasting" :label="s.selfCollect ? '收回' : '採檢'" :pending="collect.pending.value" @collect="(o) => collect.run(s.barcode, o)" />
                </li>
              </ul>
            </li>
          </ul>
          <p v-if="finished.length" class="text-xs text-slate-500">櫃台已處理完（檢體送檢驗科）：{{ finished.map((p) => `${p.checkin?.no} 號 ${p.patientName}`).join('、') }}</p>
        </div>
      </UCard>
    </div>
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
