<script setup lang="ts">
// 護理站：病房病人總覽 → 給藥紀錄、生命徵象、護理紀錄、交班。
// 時間是這一頁的核心維度，有兩種「跟著時間更新」的方式：
//   1. 頁面自己算的（給藥列的逾時顏色）：用 useNow 的時鐘，時鐘走就重新計算，不必查詢
//   2. 服務層算好的（病人清單上的逾時數）：資料是查詢當下算的，所以要定時重新查詢
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AlertTriangle, ListChecks } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UQueryState, UTabs } from '@/components/ui'
import PatientBanner from '@/components/PatientBanner.vue'
import MarPanel from './components/MarPanel.vue'
import OrdersPanel from './components/OrdersPanel.vue'
import VitalsPanel from './components/VitalsPanel.vue'
import NursingNotesPanel from './components/NursingNotesPanel.vue'
import HandoverPanel from './components/HandoverPanel.vue'
import WardTasksPanel from './components/WardTasksPanel.vue'
import { masterApi, nursingApi } from '@/services'
import { useQuery } from '@/composables/useService'
import { useNow } from '@/composables/useNow'

const clock = useNow()
const wards = masterApi.staticCodes.wards
const ward = ref(wards[0])

const { data, loading, reload } = useQuery(
  async () => {
    const w = ward.value
    return { w, list: await nursingApi.listWardPatients(w) }
  },
  [ward],
)
const patients = computed(() => (data.value?.w === ward.value ? data.value.list : undefined))
// 逾時數由服務層依「查詢當下」計算，每分鐘重新查一次
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => (timer = setInterval(reload, 60_000)))
onBeforeUnmount(() => clearInterval(timer))

const admissionId = ref<string>()
useRevealOnNarrow(admissionId) // 窄螢幕點選後把明細捲進畫面
const adm = computed(() => patients.value?.find((p) => p.id === admissionId.value))
// 換病房或病人出院後，取消選取
watch(patients, (list) => {
  if (list && admissionId.value && !list.some((p) => p.id === admissionId.value)) admissionId.value = undefined
})

// 分頁分兩組：沒選病人時是病房層級（本班待辦、交班）；選了病人才有個人的五個分頁。
// 以前沒選病人時也顯示「給藥紀錄、醫囑…」，點了只會看到同一張待辦清單，看起來能按卻沒作用。
const tab = ref('tasks')
const tabs = computed(() =>
  !adm.value
    ? [
        { key: 'tasks', label: '本班待辦' },
        { key: 'handover', label: '交班' },
      ]
    : [
        { key: 'mar', label: '給藥紀錄', count: adm.value.overdueCount + adm.value.dueCount || undefined },
        { key: 'orders', label: '醫囑', count: adm.value.unackedCount || undefined },
        { key: 'vitals', label: '生命徵象' },
        { key: 'notes', label: '護理紀錄' },
        { key: 'handover', label: '交班' },
      ],
)
// 兩組之間切換：選了病人（從待辦切過來）→ 給藥紀錄；病人取消選取 → 本班待辦。交班兩組都有，保留不動
watch(admissionId, (id) => {
  if (id && tab.value === 'tasks') tab.value = 'mar'
  else if (!id && tab.value !== 'handover') tab.value = 'tasks'
})

// 本班待辦：取消選取病人就回到全病房清單；點清單的一列跳到該病人的對應分頁
function showTasks() {
  admissionId.value = undefined
  tab.value = 'tasks'
}
function openTask(id: string, t: string) {
  admissionId.value = id
  tab.value = t
}

const wardTotals = computed(() => ({
  overdue: (patients.value ?? []).reduce((s, p) => s + p.overdueCount, 0),
  stat: (patients.value ?? []).reduce((s, p) => s + p.pendingStatCount, 0),
  unacked: (patients.value ?? []).reduce((s, p) => s + p.unackedCount, 0),
}))
</script>

<template>
  <div class="space-y-3">
    <!-- 病房切換 -->
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
        <button
          v-for="w in wards"
          :key="w"
          :class="['rounded-md px-3 py-1.5 text-sm', ward === w ? 'bg-brand-600 font-medium text-white' : 'text-slate-600 hover:bg-slate-100']"
          @click="ward = w"
        >{{ w }}</button>
      </div>
      <UButton size="sm" :variant="!admissionId && tab !== 'handover' ? 'primary' : 'secondary'" :icon="ListChecks" @click="showTasks">本班待辦</UButton>
      <UBadge v-if="wardTotals.overdue" tone="red">全病房逾時給藥 {{ wardTotals.overdue }}</UBadge>
      <UBadge v-if="wardTotals.stat" tone="yellow">待執行臨時醫囑 {{ wardTotals.stat }}</UBadge>
      <UBadge v-if="wardTotals.unacked" tone="cyan">待核對醫囑 {{ wardTotals.unacked }}</UBadge>
      <span class="tabular ml-auto text-sm text-slate-500">現在 {{ clock.slice(11) }}</span>
    </div>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-[19rem_1fr]">
      <!-- 病房病人 -->
      <UCard :padded="false" class="self-start">
        <template #title>
          <div class="text-sm font-semibold text-slate-800">{{ ward }}</div>
          <div class="text-xs text-slate-500">住院中 {{ patients?.length ?? 0 }} 位</div>
        </template>
        <UQueryState :loading="loading && !patients" :ready="!!patients?.length" empty-title="這個病房目前沒有住院病人">
          <ul class="max-h-[calc(100vh-14rem)] divide-y divide-slate-100 overflow-y-auto">
            <li v-for="p in patients" :key="p.id">
              <button :class="['w-full px-3 py-2.5 text-left hover:bg-slate-50', p.id === admissionId && '!bg-brand-50']" @click="admissionId = p.id">
                <div class="flex items-center gap-2">
                  <span class="tabular rounded bg-slate-100 px-1.5 text-xs font-medium text-slate-700">{{ p.bed?.bedNo }}</span>
                  <span class="font-medium text-slate-800">{{ p.patientName }}</span>
                  <AlertTriangle v-if="p.allergies.length" class="h-3.5 w-3.5 text-red-600" :title="`過敏：${p.allergies.join('、')}`" />
                  <span class="ml-auto flex gap-1">
                    <UBadge v-if="p.overdueCount" tone="red">逾時 {{ p.overdueCount }}</UBadge>
                    <UBadge v-if="p.dueCount" tone="yellow">待給 {{ p.dueCount }}</UBadge>
                    <UBadge v-if="p.pendingStatCount" tone="blue">臨時 {{ p.pendingStatCount }}</UBadge>
                    <UBadge v-if="p.unackedCount" tone="cyan">新醫囑 {{ p.unackedCount }}</UBadge>
                  </span>
                </div>
                <div class="mt-0.5 truncate text-xs text-slate-500">{{ p.diagnosis }}・第 {{ p.days }} 天</div>
                <div v-if="p.latestVitals" class="tabular mt-0.5 text-xs text-slate-500">
                  {{ p.latestVitals.at.slice(11) }}　T {{ p.latestVitals.temp ?? '—' }}・P {{ p.latestVitals.pulse ?? '—' }}・BP {{ p.latestVitals.sbp ?? '—' }}/{{ p.latestVitals.dbp ?? '—' }}・SpO2 {{ p.latestVitals.spo2 ?? '—' }}
                  <span v-if="p.abnormal.length" class="font-medium text-red-600">（{{ p.abnormal.join('、') }}異常）</span>
                </div>
              </button>
            </li>
          </ul>
        </UQueryState>
      </UCard>

      <!-- 護理工作區 -->
      <div data-detail class="min-w-0 space-y-3">
        <template v-if="adm">
          <PatientBanner :patient="adm">
            <UBadge tone="blue">{{ adm.bed?.bedNo }}</UBadge>
            <span class="tabular text-sm text-slate-600">住院號 {{ adm.admitNo }}・第 {{ adm.days }} 天・{{ adm.doctorName }}</span>
          </PatientBanner>
        </template>

        <UCard :padded="false">
          <div class="px-4 pt-1"><UTabs v-model="tab" :tabs="tabs" /></div>
          <!-- 交班是病房層級，不必先選病人 -->
          <HandoverPanel v-if="tab === 'handover'" :ward="ward" :patients="patients ?? []" :selected-id="admissionId" :clock="clock" />
          <!-- 沒選病人時顯示全病房的本班待辦（以前是空白的「請選擇病人」）；點一列跳到該病人的對應分頁 -->
          <WardTasksPanel v-else-if="!adm" :ward="ward" :clock="clock" @open="openTask" />
          <MarPanel v-else-if="tab === 'mar'" :admission="adm" :clock="clock" />
          <OrdersPanel v-else-if="tab === 'orders'" :admission="adm" />
          <VitalsPanel v-else-if="tab === 'vitals'" :admission="adm" />
          <NursingNotesPanel v-else :admission="adm" />
        </UCard>
      </div>
    </div>
  </div>
</template>
