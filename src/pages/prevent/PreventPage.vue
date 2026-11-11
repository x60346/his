<script setup lang="ts">
// 預防保健：今日工作（掛號時勾選的項目、待補登報告）→ 病人資格與登錄 → 月統計。
// 資格判斷全部來自服務層的 checkEligibility：卡片上的「可做」是查詢當下的結果，
// 按下登錄時服務層會用同一條規則再判斷一次——畫面判斷是為了體驗，服務層判斷才算數。
import { computed, ref } from 'vue'
import { Check, ClipboardCheck, FileClock } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UEmpty, UQueryState, USearchSelect, UTable, UTabs, type Column } from '@/components/ui'
import PatientBanner from '@/components/PatientBanner.vue'
import ReasonDialog from '@/components/ReasonDialog.vue'
import RecordDialog from '@/components/PreventRecordDialog.vue'
import ReportDialog from './components/ReportDialog.vue'
import StatsPanel from './components/StatsPanel.vue'
import { FIELD_FORMATS, patientApi, preventApi, type Eligibility, type PreventRecordView, type WorklistRow } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { toRoc } from '@/utils/date'
import type { Patient } from '@/types'

const tab = ref('today')
const { data: items } = useQuery(() => preventApi.listPreventItems())
const itemOf = (code?: string) => items.value?.find((i) => i.code === code)

// ---------- 今日工作 ----------
const { data: worklist, loading: wlLoading } = useQuery(() => preventApi.todayWorklist())
const { data: pendingReports, loading: prLoading } = useQuery(() => preventApi.listPreventRecords({ result: '待報告' }))
const todoCount = computed(() => (worklist.value ?? []).filter((w) => w.items.some((i) => !i.done)).length)

// ---------- 病人 ----------
const patientId = ref<string>()
/**
 * 從今日工作點進來時，帶著這次掛號（登錄時連結 visitId、預設執行醫師）。
 * 只記 id，資料每次從最新的 worklist 取——若存整筆 row，登錄後 worklist 重新查詢了，
 * 這裡還是點擊當下的舊快照，卡片會一直顯示「掛號時已勾選」。
 */
const fromVisitId = ref<string>()
const fromVisit = computed(() => worklist.value?.find((w) => w.visit.id === fromVisitId.value))

function openPatient(id: string, row?: WorklistRow) {
  patientId.value = id
  fromVisitId.value = row?.visit.id
  tab.value = 'patient'
}
function onSearch(p: Patient) {
  openPatient(p.id)
}

const { data, loading } = useQuery(
  async () => {
    const id = patientId.value
    return id ? { id, profile: await preventApi.getPreventProfile(id) } : undefined
  },
  [patientId],
)
const profile = computed(() => (data.value?.id === patientId.value ? data.value?.profile : undefined))
const planned = (code: string) => fromVisit.value?.items.some((i) => i.code === code && !i.done)
// 符合資格的排前面，掛號時勾選的最前面
const cards = computed(() =>
  [...(profile.value?.eligibility ?? [])].sort((a, b) => Number(!!planned(b.itemCode)) - Number(!!planned(a.itemCode)) || Number(b.eligible) - Number(a.eligible)),
)

const recordOpen = ref(false)
const recordItem = ref<string>()
function startRecord(e: Eligibility) {
  recordItem.value = e.itemCode
  recordOpen.value = true
}

const reportOpen = ref(false)
const reportTarget = ref<PreventRecordView>()
function startReport(r: PreventRecordView) {
  reportTarget.value = r
  reportOpen.value = true
}

// 作廢：登錄錯誤時使用。紀錄不會消失，只加上作廢註記（刪除線＋原因），日後查得到原本記了什麼
const voidTarget = ref<PreventRecordView>()
const voidOpen = computed({ get: () => !!voidTarget.value, set: (v) => !v && (voidTarget.value = undefined) })
const voidPresets = ['登錄錯誤', '選錯病人', '選錯項目', '數值輸入錯誤']
const doVoid = useAction(preventApi.voidPreventRecord, { success: '已作廢，可重新登錄正確的紀錄' })
async function confirmVoid(reason: string) {
  if (voidTarget.value && (await doVoid.run(voidTarget.value.id, reason))) voidTarget.value = undefined
}

const resultTone = { 正常: 'green', 異常需追蹤: 'red', 待報告: 'yellow' } as const
const recordColumns: Column<PreventRecordView>[] = [
  { key: 'date', label: '日期', width: '7rem', format: (r) => toRoc(r.date) },
  { key: 'itemName', label: '項目' },
  { key: 'result', label: '結果', width: '7rem' },
  { key: 'data', label: '檢查內容' },
  { key: 'doctorName', label: '醫師', width: '6rem' },
  { key: 'act', label: '', width: '10rem', align: 'right' },
]
const pendingColumns: Column<PreventRecordView>[] = [
  { key: 'date', label: '執行日', width: '7rem', format: (r) => toRoc(r.date) },
  { key: 'patientName', label: '病人', format: (r) => `${r.patientName}（${r.chartNo}）` },
  { key: 'itemName', label: '項目' },
  { key: 'doctorName', label: '醫師', width: '6rem' },
  { key: 'act', label: '', width: '6rem', align: 'right' },
]
/** 檢查內容：數值加上單位（單位來自 FIELD_FORMATS，和登錄時的提示同一個來源） */
const dataText = (d: Record<string, string>) => Object.entries(d).map(([k, v]) => `${k} ${v}${FIELD_FORMATS[k]?.unit ? ' ' + FIELD_FORMATS[k].unit : ''}`).join('・') || '—'
</script>

<template>
  <div class="space-y-3">
    <UCard :padded="false">
      <div class="flex flex-wrap items-center gap-3 px-4 pt-1">
        <UTabs v-model="tab" :tabs="[{ key: 'today', label: '今日工作', count: todoCount || undefined }, { key: 'patient', label: '資格查詢・登錄' }, { key: 'stats', label: '月統計' }]" />
        <div class="ml-auto w-80 py-2">
          <USearchSelect
            placeholder="查詢病人：病歷號、姓名、身分證"
            :search="(kw) => patientApi.searchPatients(kw, 20)"
            :item-key="(p) => p.id"
            :item-label="(p) => `${p.chartNo}　${p.name}`"
            :item-sub="(p) => `${p.gender === 'M' ? '男' : '女'}・${p.birthDate}`"
            @select="onSearch"
          />
        </div>
      </div>

      <!-- 今日工作 -->
      <div v-if="tab === 'today'" class="space-y-6 p-4">
        <section>
          <h3 class="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700"><ClipboardCheck class="h-4 w-4" />今日掛號時勾選的預防保健</h3>
          <UQueryState :loading="wlLoading && !worklist" :ready="!!worklist?.length" empty-title="今天沒有掛號時勾選預防保健的病人">
            <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
              <li v-for="w in worklist" :key="w.visit.id">
                <button class="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-50" @click="openPatient(w.visit.patientId, w)">
                  <span class="tabular w-10 text-slate-500">#{{ w.visit.seqNo }}</span>
                  <span class="w-24 font-medium text-slate-800">{{ w.visit.patientName }}</span>
                  <span class="w-40 text-xs text-slate-500">{{ w.visit.deptName }}・{{ w.visit.doctorName }}</span>
                  <span class="flex flex-1 flex-wrap gap-1.5">
                    <UBadge v-for="i in w.items" :key="i.code" :tone="i.done ? 'green' : 'yellow'">
                      <Check v-if="i.done" class="mr-0.5 inline h-3 w-3" />{{ i.name }}{{ i.done ? '' : '・待執行' }}
                    </UBadge>
                  </span>
                </button>
              </li>
            </ul>
          </UQueryState>
        </section>

        <section>
          <h3 class="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700"><FileClock class="h-4 w-4" />待補登報告（{{ pendingReports?.length ?? 0 }}）</h3>
          <UQueryState :loading="prLoading && !pendingReports" :ready="!!pendingReports?.length" empty-title="沒有待補登的報告">
            <UTable :columns="pendingColumns" :rows="pendingReports" :row-key="(r) => r.id" dense>
              <template #cell-act="{ row }"><UButton size="sm" variant="secondary" @click="startReport(row)">補登報告</UButton></template>
            </UTable>
          </UQueryState>
        </section>
      </div>

      <!-- 資格查詢・登錄 -->
      <div v-else-if="tab === 'patient'" class="space-y-4 p-4">
        <UEmpty v-if="!patientId" title="請先查詢病人" description="右上角輸入病歷號或姓名，或從「今日工作」點選病人" />
        <UQueryState v-else :loading="loading && !profile" :ready="!!profile">
          <template v-if="profile">
            <PatientBanner :patient="profile.patient">
              <span v-if="fromVisit" class="text-sm text-slate-600">本次掛號：{{ fromVisit.visit.deptName }}・{{ fromVisit.visit.doctorName }} #{{ fromVisit.visit.seqNo }}</span>
            </PatientBanner>

            <div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              <article
                v-for="e in cards"
                :key="e.itemCode"
                :class="[
                  'flex flex-col rounded-lg border p-3',
                  e.eligible ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200 bg-slate-50',
                  planned(e.itemCode) && '!border-brand-500 ring-1 ring-brand-500',
                ]"
              >
                <header class="flex items-start gap-2">
                  <h4 :class="['flex-1 text-sm font-semibold', e.eligible ? 'text-slate-800' : 'text-slate-500']">{{ e.itemName }}</h4>
                  <UBadge :tone="e.eligible ? 'green' : 'gray'">{{ e.eligible ? '可做' : '不符合' }}</UBadge>
                </header>
                <p v-if="planned(e.itemCode)" class="mt-1 text-xs font-medium text-brand-700">掛號時已勾選</p>
                <p :class="['mt-1.5 text-sm', e.eligible ? 'text-emerald-800' : 'text-slate-600']">{{ e.reason }}</p>
                <p class="mt-1.5 flex-1 text-xs text-slate-400">{{ e.ruleText }}</p>
                <UButton v-if="e.eligible" size="sm" class="mt-2 self-end" @click="startRecord(e)">登錄</UButton>
              </article>
            </div>

            <section class="mt-5">
              <h3 class="mb-2 text-sm font-semibold text-slate-700">歷次預防保健紀錄</h3>
              <UTable :columns="recordColumns" :rows="profile.records" :row-key="(r) => r.id" dense empty-text="沒有預防保健紀錄">
                <template #cell-itemName="{ row }"><span :class="row.voided && 'text-slate-400 line-through'">{{ row.itemName }}</span></template>
                <template #cell-result="{ row }">
                  <UBadge v-if="row.voided" tone="gray">已作廢</UBadge>
                  <UBadge v-else :tone="resultTone[row.result]">{{ row.result }}</UBadge>
                </template>
                <template #cell-data="{ row }">
                  <span :class="row.voided ? 'text-slate-400 line-through' : 'text-slate-600'">{{ dataText(row.data) }}</span>
                  <span v-if="row.reportedAt" class="tabular ml-1 text-xs text-slate-400">（{{ toRoc(row.reportedAt) }} 補登）</span>
                  <p v-if="row.voided" class="mt-0.5 text-xs text-slate-500">作廢：{{ row.voided.reason }}（{{ row.voidedByName }}・{{ toRoc(row.voided.at) }}）</p>
                </template>
                <!-- slot 內容全部被 v-if 掉時，Vue 會改顯示預設內容（—），所以用空 span 佔位 -->
                <template #cell-act="{ row }">
                  <div v-if="!row.voided" class="flex justify-end gap-1.5">
                    <UButton v-if="row.result === '待報告'" size="sm" variant="secondary" @click="startReport(row)">補登報告</UButton>
                    <UButton size="sm" variant="ghost" @click="voidTarget = row">作廢</UButton>
                  </div>
                  <span v-else />
                </template>
              </UTable>
            </section>
          </template>
        </UQueryState>
      </div>

      <StatsPanel v-else />
    </UCard>

    <RecordDialog
      v-model="recordOpen"
      :item="itemOf(recordItem)"
      :patient="profile?.patient"
      :visit-id="fromVisit?.visit.id"
      :default-doctor-id="fromVisit?.visit.doctorId"
    />
    <ReportDialog v-model="reportOpen" :record="reportTarget" :item="itemOf(reportTarget?.itemCode)" />
    <ReasonDialog
      v-model="voidOpen"
      title="作廢預防保健紀錄"
      :subject="voidTarget && `${voidTarget.patientName}・${voidTarget.itemName}（${toRoc(voidTarget.date)}，${voidTarget.result}）`"
      label="作廢原因"
      :presets="voidPresets"
      ok-text="作廢"
      danger
      :pending="doVoid.pending.value"
      :error="doVoid.fieldErrors.value.reason"
      @confirm="confirmVoid"
    />
  </div>
</template>
