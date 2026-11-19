<script setup lang="ts">
// 病理（權限「病理」；示範 lab01 收件、dr10 發報告）：
//   - 待收件：手術完成送出的檢體，逐件勾收到的；少了要寫原因（主刀與手術室看得到）；送出超過 4 小時標紅
//   - 待發報告：病理診斷、良惡性、和術前診斷是否相符（惡性或不符 → 主刀必須確認）
//   - 近 14 天的報告（主刀還沒確認的惡性、不符排前面）
// 誰能收件、發報告與欄位檢查都在服務層（pathology.ts、pathology-rules）
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UPageHeader, UQueryState, USelect, UTextarea } from '@/components/ui'
import { PATH_STAGE_LABEL, pathologyApi, type PathItem } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => pathologyApi.pathBoard())
const wait = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ''}` : `${m} 分`)

// 收件
const receiving = ref<PathItem>()
const recOpen = computed({ get: () => !!receiving.value, set: (x) => !x && (receiving.value = undefined) })
const got = ref<string[]>([])
const recNote = ref('')
function openReceive(x: PathItem) {
  got.value = x.specimens.map((s) => s.id)
  recNote.value = ''
  recAct.fieldErrors.value = {}
  receiving.value = x
}
const recAct = useAction(pathologyApi.receivePath, { success: (x) => `已收件：${x.no}` })
async function receive() {
  if (receiving.value && (await recAct.run(receiving.value.surgeryId, { received: got.value, note: recNote.value }))) receiving.value = undefined
}
const missingNow = computed(() => (receiving.value?.specimens ?? []).filter((s) => !got.value.includes(s.id)).map((s) => s.label))

// 報告
const reporting = ref<PathItem>()
const repOpen = computed({ get: () => !!reporting.value, set: (x) => !x && (reporting.value = undefined) })
const rf = reactive({ diagnosis: '', malignant: '' as string | number | undefined, consistent: '' as string | number | undefined, note: '' })
function openReport(x: PathItem) {
  Object.assign(rf, { diagnosis: '', malignant: '', consistent: '', note: '' })
  repAct.fieldErrors.value = {}
  reporting.value = x
}
const repAct = useAction(pathologyApi.reportPath, { success: (x) => `已發報告：${x.no}${x.critical ? '（主刀要確認）' : ''}` })
const bool = (v: string | number | undefined) => (v === 'yes' ? true : v === 'no' ? false : (undefined as unknown as boolean))
async function report() {
  if (reporting.value && (await repAct.run(reporting.value.surgeryId, { diagnosis: rf.diagnosis, malignant: bool(rf.malignant), consistent: bool(rf.consistent), note: rf.note }))) reporting.value = undefined
}
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="病理" description="手術檢體收件（逐件核對）、病理報告；惡性或和術前診斷不符，主刀要確認" />
    <UQueryState :loading="loading && !data" :ready="!!data">
      <template v-if="data">
        <section class="rounded-md border border-slate-200 bg-white p-3 text-sm">
          <h3 class="mb-2 font-semibold text-slate-700">待收件 {{ data.toReceive.length }}<span class="ml-2 text-xs font-normal text-slate-500">送出超過 {{ data.receiveHours }} 小時標紅</span></h3>
          <p v-if="!data.toReceive.length" class="text-xs text-slate-400">沒有待收件的檢體</p>
          <ul class="divide-y divide-slate-100">
            <li v-for="x in data.toReceive" :key="x.surgeryId" class="flex flex-wrap items-center gap-2 py-1.5">
              <b>{{ x.patientName }}</b><span class="text-xs text-slate-500">{{ x.chartNo }}・{{ x.no }}</span>
              <span class="text-slate-700">{{ x.procName }}・主刀 {{ x.surgeonName }}</span>
              <span class="text-xs text-slate-600">{{ x.specimens.length }} 件：{{ x.specimens.map((s) => s.text).join('；') }}</span>
              <span class="tabular text-xs" :class="x.overdue ? 'font-semibold text-red-700' : 'text-slate-500'">{{ x.sentAt.slice(5) }} 送出・已 {{ wait(x.minutes) }}</span>
              <UButton v-if="x.canReceive" size="sm" class="ml-auto" @click="openReceive(x)">收件</UButton>
            </li>
          </ul>
        </section>

        <section class="rounded-md border border-slate-200 bg-white p-3 text-sm">
          <h3 class="mb-2 font-semibold text-slate-700">待發報告 {{ data.toReport.length }}</h3>
          <p v-if="!data.toReport.length" class="text-xs text-slate-400">沒有待發報告的檢體</p>
          <ul class="divide-y divide-slate-100">
            <li v-for="x in data.toReport" :key="x.surgeryId" class="flex flex-wrap items-center gap-2 py-1.5">
              <b>{{ x.patientName }}</b><span class="text-xs text-slate-500">{{ x.chartNo }}・{{ x.no }}</span>
              <span class="text-slate-700">{{ x.procName }}・術前診斷 {{ x.diagnosis }}</span>
              <span class="text-xs" :class="x.missing.length ? 'font-semibold text-red-700' : 'text-slate-500'">{{ x.receivedText }}</span>
              <UButton v-if="x.canReport" size="sm" class="ml-auto" @click="openReport(x)">發報告</UButton>
            </li>
          </ul>
          <p v-if="data.toReport.length && !data.toReport.some((x) => x.canReport)" class="mt-1 text-xs text-slate-500">報告由有「病理」權限的醫師發。</p>
        </section>

        <section class="rounded-md border border-slate-200 bg-white p-3 text-sm">
          <h3 class="mb-2 font-semibold text-slate-700">近 14 天的報告</h3>
          <p v-if="!data.reported.length" class="text-xs text-slate-400">沒有報告</p>
          <ul class="divide-y divide-slate-100">
            <li v-for="x in data.reported" :key="x.surgeryId" class="space-y-0.5 py-1.5">
              <div class="flex flex-wrap items-center gap-2">
                <UBadge :tone="x.stage === 'acked' ? 'green' : x.critical ? 'red' : 'purple'">{{ x.critical && x.stage === 'reported' ? '主刀待確認' : PATH_STAGE_LABEL[x.stage] }}</UBadge>
                <b>{{ x.patientName }}</b><span class="text-xs text-slate-500">{{ x.no }}・{{ x.procName }}・主刀 {{ x.surgeonName }}</span>
              </div>
              <div :class="x.critical ? 'font-medium text-red-700' : 'text-slate-700'">{{ x.report!.diagnosis }}<span class="ml-1 text-xs font-normal text-slate-500">{{ x.report!.malignant ? '惡性' : '良性' }}・{{ x.report!.consistent ? '相符' : '和術前診斷不符' }}・{{ x.report!.byName }} {{ x.report!.at.slice(5) }}</span></div>
              <div v-if="x.ackText" class="text-xs text-emerald-700">{{ x.ackText }}</div>
            </li>
          </ul>
        </section>
      </template>
    </UQueryState>

    <UDialog v-model="recOpen" :title="`收件：${receiving?.patientName ?? ''}`" size="sm" @submit="receive">
      <div v-if="receiving" class="space-y-2 text-sm">
        <p class="text-slate-600">{{ receiving.no }}・{{ receiving.procName }}：逐件核對病人姓名與標籤，勾收到的。</p>
        <UCheckbox v-for="s in receiving.specimens" :key="s.id" :model-value="got.includes(s.id)" :label="s.text" @update:model-value="(on: boolean) => (got = on ? [...got, s.id] : got.filter((x) => x !== s.id))" />
        <p v-if="recAct.fieldErrors.value.received" class="text-xs text-red-700">{{ recAct.fieldErrors.value.received }}</p>
        <UInput v-if="missingNow.length" v-model="recNote" :label="`少了 ${missingNow.join('、')}：原因與處理`" required :error="recAct.fieldErrors.value.note" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="recOpen = false">取消</UButton>
        <UButton type="submit" :loading="recAct.pending.value">收件</UButton>
      </template>
    </UDialog>

    <UDialog v-model="repOpen" :title="`病理報告：${reporting?.patientName ?? ''}`" @submit="report">
      <div v-if="reporting" class="space-y-3 text-sm">
        <p class="text-slate-600">{{ reporting.procName }}・術前診斷 {{ reporting.diagnosis }}・{{ reporting.specimens.map((s) => s.text).join('；') }}</p>
        <UTextarea v-model="rf.diagnosis" label="病理診斷" :rows="3" required :error="repAct.fieldErrors.value.diagnosis" />
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <USelect v-model="rf.malignant" label="良惡性" required :options="[{ label: '良性', value: 'no' }, { label: '惡性', value: 'yes' }]" placeholder="選擇" :error="repAct.fieldErrors.value.malignant" />
          <USelect v-model="rf.consistent" label="和術前診斷" required :options="[{ label: '相符', value: 'yes' }, { label: '不符', value: 'no' }]" placeholder="選擇" :error="repAct.fieldErrors.value.consistent" />
        </div>
        <p v-if="rf.malignant === 'yes' || rf.consistent === 'no'" class="rounded bg-red-50 px-2 py-1 text-xs text-red-800">惡性或不符：發出後主刀首頁會出現「病理報告待確認」，要確認看過。</p>
        <UInput v-model="rf.note" label="備註（選填，例：切緣、建議）" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="repOpen = false">取消</UButton>
        <UButton type="submit" :loading="repAct.pending.value">發報告</UButton>
      </template>
    </UDialog>
  </div>
</template>
