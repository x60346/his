<script setup lang="ts">
// 護理站：病房病人總覽 → 給藥紀錄、生命徵象、護理紀錄、交班。
// 時間是這一頁的核心維度，有兩種「跟著時間更新」的方式：
//   1. 頁面自己算的（給藥列的逾時顏色）：用 useNow 的時鐘，時鐘走就重新計算，不必查詢
//   2. 服務層算好的（病人清單上的逾時數）：資料是查詢當下算的，所以要定時重新查詢
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { AlertTriangle, ListChecks } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UQueryState, UTabs } from '@/components/ui'
import PatientBanner from '@/components/PatientBanner.vue'
import IpdFeeStrip from '@/components/IpdFeeStrip.vue'
import AfterDischargePanel from '@/components/AfterDischargePanel.vue'
import WristbandDialog from '@/components/WristbandDialog.vue'
import ScanStatsPanel from './components/ScanStatsPanel.vue'
import RiskPanel from './components/RiskPanel.vue'
import RiskBadges from '@/components/RiskBadges.vue'
import PatientFlags from '@/components/PatientFlags.vue'
import PatientFlagsPanel from '@/components/PatientFlagsPanel.vue'
import BloodPanel from '@/components/blood/BloodPanel.vue'
import SurgeryPanel from '@/components/surgery/SurgeryPanel.vue'
import WardFlagsPanel from './components/WardFlagsPanel.vue'
import MarPanel from './components/MarPanel.vue'
import OrdersPanel from './components/OrdersPanel.vue'
import VitalsPanel from './components/VitalsPanel.vue'
import NursingNotesPanel from './components/NursingNotesPanel.vue'
import HandoverPanel from './components/HandoverPanel.vue'
import WardTasksPanel from './components/WardTasksPanel.vue'
import WardStockPanel from './components/WardStockPanel.vue'
import { bloodApi, masterApi, nursingApi } from '@/services'
import { useQuery } from '@/composables/useService'
import { useNow } from '@/composables/useNow'

const clock = useNow()
// 急診留觀區照病房的方式照顧（給藥、生命徵象、護理紀錄）
const wards = [...masterApi.staticCodes.wards, masterApi.staticCodes.obsWard]
// 從急診看板點過來帶 ?ward=急診留觀區&admission=…
const ward = ref(wards.includes(String(useRoute().query.ward)) ? String(useRoute().query.ward) : wards[0])

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

const admissionId = ref<string | undefined>(typeof useRoute().query.admission === 'string' ? String(useRoute().query.admission) : undefined)
const wristbandOpen = ref(false)
useRevealOnNarrow(admissionId) // 窄螢幕點選後把明細捲進畫面
const adm = computed(() => patients.value?.find((p) => p.id === admissionId.value))
// 換病房或病人出院後，取消選取
watch(patients, (list) => {
  if (list && admissionId.value && !list.some((p) => p.id === admissionId.value)) admissionId.value = undefined
})

// 分頁分兩組：沒選病人時是病房層級（本班待辦、交班）；選了病人才有個人的五個分頁。
// 以前沒選病人時也顯示「給藥紀錄、醫囑…」，點了只會看到同一張待辦清單，看起來能按卻沒作用。
// 首頁待辦可以直接帶到某個病房層級的分頁（例：本班未點班 → 常備點班）
const tab = ref(['stock', 'handover'].includes(String(useRoute().query.tab)) ? String(useRoute().query.tab) : 'tasks')
// 輸血：已發血待輸、輸血中（分頁上的數字）
const { data: blood } = useQuery(async () => (admissionId.value ? bloodApi.patientBlood(admissionId.value) : undefined), [admissionId])
const bloodTodo = computed(() => (blood.value && blood.value.admissionId === admissionId.value ? blood.value.requests.reduce((n, r) => n + r.rows.filter((x) => x.state === 'issued' || x.state === 'transfusing').length, 0) : 0))
const tabs = computed(() =>
  !adm.value
    ? [
        { key: 'tasks', label: '本班待辦' },
        { key: 'stock', label: '常備點班' },
        { key: 'scan', label: '給藥掃描' },
        { key: 'isoward', label: '隔離與 DNR', count: (patients.value ?? []).reduce((s, p) => s + p.isolationTodo, 0) || undefined },
        { key: 'handover', label: '交班' },
      ]
    : [
        { key: 'mar', label: '給藥紀錄', count: adm.value.overdueCount + adm.value.dueCount || undefined },
        { key: 'orders', label: '醫囑', count: adm.value.unackedCount || undefined },
        { key: 'vitals', label: '生命徵象' },
        { key: 'risk', label: '風險評估', count: adm.value.riskOverdue + adm.value.riskDue || undefined },
        { key: 'blood', label: '輸血', count: bloodTodo.value || undefined },
        { key: 'surgery', label: '手術' },
        { key: 'flags', label: '隔離與 DNR', count: adm.value.isolationTodo || undefined },
        { key: 'notes', label: '護理紀錄' },
        { key: 'handover', label: '交班' },
      ],
)
// 兩組之間切換：選了病人（從待辦切過來）→ 給藥紀錄；病人取消選取 → 本班待辦。交班兩組都有，保留不動
// 停在病房層級的分頁（常備點班、給藥掃描）時點病人，也換到給藥紀錄（以前會落到護理紀錄）
const WARD_ONLY = ['tasks', 'stock', 'scan', 'isoward']
watch(admissionId, (id) => {
  if (id && WARD_ONLY.includes(tab.value)) tab.value = 'mar'
  else if (!id && tab.value !== 'handover' && !WARD_ONLY.includes(tab.value)) tab.value = 'tasks'
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
                    <UBadge v-if="p.dischargeReady" tone="green">准出院</UBadge>
                    <UBadge v-if="!p.wristband" tone="red" title="腕帶還沒印：給藥掃描要用">未印腕帶</UBadge>
                    <UBadge v-if="p.bloodTransfusing" :tone="p.bloodUrgency ? 'red' : 'purple'" :title="p.bloodUrgency ? '輸血中：該量 15 分鐘生命徵象（或已超過 4 小時）' : '輸血中'">輸血中</UBadge>
                    <UBadge v-else-if="p.bloodIssued" :tone="p.bloodUrgency === 'overdue' ? 'red' : 'yellow'" title="血庫已發血，請床邊雙人核對開始輸血">已發血</UBadge>
                    <UBadge v-if="p.riskOverdue" tone="red" title="跌倒或壓傷評估過了期限">評估逾時</UBadge>
                    <UBadge v-else-if="p.riskDue" tone="yellow" title="跌倒或壓傷評估快到期">待評估</UBadge>
                  </span>
                </div>
                <div class="mt-0.5 flex items-center gap-1 truncate text-xs text-slate-500">{{ p.diagnosis }}・第 {{ p.days }} 天<RiskBadges :levels="p.riskLevels" compact /><PatientFlags :flags="p.flags" compact /></div>
                <div v-if="p.latestVitals" class="tabular mt-0.5 text-xs text-slate-500">
                  <!-- 不是今天量的要帶日期：以前只顯示時分，昨天 20:00 和今天 20:00 看起來一樣 -->
                  {{ p.latestVitals.at.slice(0, 10) === clock.slice(0, 10) ? p.latestVitals.at.slice(11) : `${p.latestVitals.at.slice(5, 10).replace('-', '/')} ${p.latestVitals.at.slice(11)}` }}　T {{ p.latestVitals.temp ?? '—' }}・P {{ p.latestVitals.pulse ?? '—' }}・BP {{ p.latestVitals.sbp ?? '—' }}/{{ p.latestVitals.dbp ?? '—' }}・SpO2 {{ p.latestVitals.spo2 ?? '—' }}
                  <span v-if="p.abnormal.length" class="font-medium text-red-600">（{{ p.abnormal.join('、') }}異常）</span>
                  <span v-if="!p.measuredThisShift" class="ml-1 whitespace-nowrap rounded bg-amber-50 px-1 font-medium text-amber-700">本班未量</span>
                </div>
                <div v-else class="mt-0.5 text-xs font-medium text-amber-700">尚無生命徵象紀錄</div>
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
            <RiskBadges :levels="adm.riskLevels" />
            <UButton size="sm" :variant="adm.wristband ? 'ghost' : 'secondary'" :class="!adm.wristband && 'text-red-700'" @click="wristbandOpen = true">{{ adm.wristband ? '重印腕帶' : '未印腕帶：列印' }}</UButton>
          </PatientBanner>
          <WristbandDialog v-model="wristbandOpen" :admission-id="adm.id" />
          <!-- 家屬常問「到今天多少錢」：護理站看得到、可印明細，繳費在櫃台 -->
          <!-- 留觀中不顯示住院費用：留觀結束才算（離院在批價、收住院併入住院帳單） -->
          <IpdFeeStrip v-if="adm.obsStage !== 'open'" :admission-id="adm.id" />
          <p v-else class="rounded-md bg-sky-50 px-3 py-1.5 text-xs text-sky-800">急診留觀：費用等急診醫師結束留觀後再算（離院在批價結、收住院併入住院帳單）</p>
          <!-- 醫師約好的出院後回診（有約才顯示）：出院衛教時提醒病人 -->
          <AfterDischargePanel :admission-id="adm.id" class="bg-white" />
        </template>

        <UCard :padded="false">
          <div class="px-4 pt-1"><UTabs v-model="tab" :tabs="tabs" /></div>
          <!-- 交班是病房層級，不必先選病人 -->
          <HandoverPanel v-if="tab === 'handover'" :ward="ward" :patients="patients ?? []" :selected-id="admissionId" :clock="clock" />
          <!-- 沒選病人時顯示全病房的本班待辦（以前是空白的「請選擇病人」）；點一列跳到該病人的對應分頁 -->
          <WardStockPanel v-else-if="!adm && tab === 'stock'" :ward="ward" :clock="clock" />
          <ScanStatsPanel v-else-if="!adm && tab === 'scan'" :ward="ward" />
          <WardFlagsPanel v-else-if="!adm && tab === 'isoward'" :ward="ward" @open="openTask" />
          <WardTasksPanel v-else-if="!adm" :ward="ward" :clock="clock" @open="openTask" />
          <MarPanel v-else-if="tab === 'mar'" :admission="adm" :clock="clock" />
          <OrdersPanel v-else-if="tab === 'orders'" :admission="adm" />
          <RiskPanel v-else-if="tab === 'risk'" :admission="adm" />
          <BloodPanel v-else-if="tab === 'blood'" :admission-id="adm.id" />
          <SurgeryPanel v-else-if="tab === 'surgery'" :admission-id="adm.id" />
          <PatientFlagsPanel v-else-if="tab === 'flags'" :patient-id="adm.patientId" />
          <VitalsPanel v-else-if="tab === 'vitals'" :admission="adm" />
          <NursingNotesPanel v-else :admission="adm" />
        </UCard>
      </div>
    </div>
  </div>
</template>
