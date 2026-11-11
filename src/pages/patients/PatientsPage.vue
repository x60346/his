<script setup lang="ts">
// 病患資料：左邊搜尋清單，右邊基本資料、就醫紀錄、住院紀錄（含出院病摘）、預防保健資格。
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { computed, ref } from 'vue'
import { Pencil, UserPlus } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UEmpty, UInput, UStatusBadge, UTable, UTabs, type Column } from '@/components/ui'
import PatientEditDialog from '@/components/PatientEditDialog.vue'
import DischargeSummaryView from '@/components/DischargeSummaryView.vue'
import { admissionApi, bookingApi, patientApi, preventApi, type VisitView } from '@/services'
import { useDebounced, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { ageText, periodLabel } from '@/utils/date'
import { genderLabel, visitStatus } from '@/utils/labels'
import type { Patient } from '@/types'

const auth = useAuth()

const keyword = ref('')
const kw = useDebounced(keyword, 250)
const { data: list, loading } = useQuery(() => patientApi.searchPatients(String(kw.value ?? '')), [kw])

const selectedId = ref<string>()
useRevealOnNarrow(selectedId) // 窄螢幕點選後把明細捲進畫面
// 選取後以 id 重新查詢，資料被修改（dbVersion 變動）時右側會自動更新
const { data: patient } = useQuery(async () => (selectedId.value ? patientApi.getPatient(selectedId.value) : null), [selectedId])

const tab = ref('visits')
const { data: visits } = useQuery(async () => (selectedId.value ? bookingApi.listVisits({ patientId: selectedId.value }) : []), [selectedId])
const { data: eligibility } = useQuery(async () => (selectedId.value ? preventApi.eligibilityFor(selectedId.value) : []), [selectedId])
const visitsDesc = computed(() => [...(visits.value ?? [])].reverse())
// 住院紀錄（取消的預約不列）：出院病摘以前存了卻沒有地方看
const { data: admissions } = useQuery(async () => (selectedId.value ? admissionApi.listAdmissions({ patientId: selectedId.value, status: ['reserved', 'admitted', 'discharged'] }) : []), [selectedId])
const admissionStatusLabel = { reserved: '待報到', admitted: '住院中', discharged: '已出院', cancelled: '已取消' } as const
const openSummary = ref<string>()

const listColumns: Column<Patient>[] = [
  { key: 'chartNo', label: '病歷號', width: '80px' },
  { key: 'name', label: '姓名' },
  { key: 'info', label: '性別／年齡', format: (p) => `${genderLabel[p.gender]}・${ageText(p.birthDate)}` },
]
const visitColumns: Column<VisitView>[] = [
  { key: 'date', label: '日期' },
  { key: 'period', label: '診別', format: (v) => periodLabel[v.period] },
  { key: 'dept', label: '科別／醫師', format: (v) => `${v.deptName} ${v.doctorName}` },
  { key: 'seqNo', label: '號', align: 'center' },
  { key: 'identityName', label: '身分' },
  { key: 'status', label: '狀態' },
]

const editOpen = ref(false)
const editing = ref<Patient | null>(null)
const canEdit = computed(() => ['admin', 'clerk', 'nurse', 'doctor'].includes(auth.user?.role ?? ''))

function openCreate() {
  editing.value = null
  editOpen.value = true
}
function openEdit() {
  editing.value = patient.value ?? null
  editOpen.value = true
}
function onSaved(p: Patient) {
  selectedId.value = p.id
}

const fields = computed(() => {
  const p = patient.value
  if (!p) return []
  return [
    ['身分證字號', p.idNo],
    ['出生日期', `${p.birthDate}（${ageText(p.birthDate)}）`],
    ['電話', p.phone || '—'],
    ['血型', p.bloodType || '未知'],
    ['地址', p.address || '—'],
    ['緊急聯絡人', p.emergencyContact ? `${p.emergencyContact} ${p.emergencyPhone}` : '—'],
    ['生活習慣', [p.smoking && '吸菸', p.betelNut && '嚼檳榔'].filter(Boolean).join('、') || '無'],
    ['建檔時間', p.createdAt],
  ]
})
</script>

<template>
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]">
    <UCard title="病患搜尋" :padded="false">
      <template #actions>
        <UButton v-if="canEdit" size="sm" :icon="UserPlus" @click="openCreate">新增</UButton>
      </template>
      <div class="p-3"><UInput v-model="keyword" placeholder="病歷號、姓名、身分證、電話" /></div>
      <div class="max-h-[calc(100vh-14rem)] overflow-y-auto">
        <UTable
          :columns="listColumns"
          :rows="list"
          :row-key="(p) => p.id"
          :loading="loading"
          :selected-key="selectedId"
          clickable
          dense
          empty-text="查無病患"
          @row-click="(p) => (selectedId = p.id)"
        />
      </div>
    </UCard>

    <div v-if="patient" data-detail class="space-y-4">
      <UCard>
        <template #title>
          <div class="flex items-baseline gap-2">
            <span class="text-lg font-bold text-slate-800">{{ patient.name }}</span>
            <span class="text-sm text-slate-500">{{ genderLabel[patient.gender] }}・病歷號 {{ patient.chartNo }}</span>
          </div>
        </template>
        <template #actions>
          <UButton v-if="canEdit" size="sm" variant="secondary" :icon="Pencil" @click="openEdit">修改</UButton>
        </template>
        <dl class="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div v-for="[k, v] in fields" :key="k" class="flex gap-3">
            <dt class="w-20 shrink-0 text-slate-500">{{ k }}</dt>
            <dd class="text-slate-800">{{ v }}</dd>
          </div>
        </dl>
        <div class="mt-3 flex flex-wrap gap-4 border-t border-slate-100 pt-3 text-sm">
          <div>
            <span class="mr-2 text-slate-500">藥物過敏</span>
            <UBadge v-for="a in patient.allergies" :key="a" tone="red" class="mr-1">{{ a }}</UBadge>
            <span v-if="!patient.allergies.length" class="text-slate-400">無已知過敏</span>
          </div>
          <div>
            <span class="mr-2 text-slate-500">家族病史</span>
            <UBadge v-for="f in patient.familyHistory" :key="f" class="mr-1">{{ f }}</UBadge>
            <span v-if="!patient.familyHistory.length" class="text-slate-400">無</span>
          </div>
        </div>
        <p v-if="patient.note" class="mt-2 text-sm text-slate-600">備註：{{ patient.note }}</p>
      </UCard>

      <UCard :padded="false">
        <div class="px-4 pt-2">
          <UTabs v-model="tab" :tabs="[{ key: 'visits', label: '就醫紀錄', count: visits?.length }, { key: 'admissions', label: '住院紀錄', count: admissions?.length }, { key: 'prevent', label: '預防保健資格' }]" />
        </div>
        <UTable v-if="tab === 'visits'" :columns="visitColumns" :rows="visitsDesc" :row-key="(v) => v.id" dense empty-text="沒有就醫紀錄">
          <template #cell-status="{ row }"><UStatusBadge :map="visitStatus" :value="row.status" /></template>
        </UTable>
        <template v-else-if="tab === 'admissions'">
          <p v-if="!admissions?.length" class="px-4 py-8 text-center text-sm text-slate-400">沒有住院紀錄</p>
          <ul v-else class="divide-y divide-slate-100">
            <li v-for="a in admissions" :key="a.id" class="px-4 py-2.5 text-sm">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <UBadge :tone="a.status === 'admitted' ? 'blue' : a.status === 'reserved' ? 'yellow' : 'gray'">{{ admissionStatusLabel[a.status] }}</UBadge>
                <span class="tabular text-slate-600">{{ (a.admittedAt ?? a.expectedDate).slice(0, 10) }}<template v-if="a.dischargedAt"> ～ {{ a.dischargedAt.slice(0, 10) }}（{{ a.days }} 天）</template></span>
                <span class="text-slate-800">{{ a.diagnosis }}</span>
                <span class="text-xs text-slate-500">{{ a.deptName }}・{{ a.doctorName }}</span>
                <button v-if="a.dischargeSummary" type="button" class="ml-auto text-xs text-brand-600 hover:underline" @click="openSummary = openSummary === a.id ? undefined : a.id">
                  {{ openSummary === a.id ? '收起病摘' : a.dischargeSummary.signedAt ? '出院病摘' : '出院病摘（草稿）' }}
                </button>
              </div>
              <div v-if="openSummary === a.id && a.dischargeSummary" class="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3">
                <DischargeSummaryView :summary="a.dischargeSummary" :doctor-name="a.summaryDoctorName" />
              </div>
            </li>
          </ul>
        </template>
        <ul v-else class="divide-y divide-slate-100">
          <li v-for="e in eligibility" :key="e.itemCode" class="flex items-center gap-3 px-4 py-2.5 text-sm">
            <UBadge :tone="e.eligible ? 'green' : 'gray'">{{ e.eligible ? '符合' : '不符合' }}</UBadge>
            <div class="min-w-0 flex-1">
              <div class="font-medium text-slate-800">{{ e.itemName }}</div>
              <div class="text-xs text-slate-500">{{ e.ruleText }}</div>
            </div>
            <div class="text-right text-xs text-slate-500">
              <div>{{ e.reason }}</div>
              <div v-if="e.lastDate">上次 {{ e.lastDate }}<template v-if="e.nextDate">・下次 {{ e.nextDate }} 起</template></div>
            </div>
          </li>
        </ul>
      </UCard>
    </div>
    <UCard v-else data-detail><UEmpty title="請從清單選擇病患" description="可用病歷號、姓名、身分證或電話搜尋" /></UCard>

    <PatientEditDialog v-model="editOpen" :patient="editing" @saved="onSaved" />
  </div>
</template>
