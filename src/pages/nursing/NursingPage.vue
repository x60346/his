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
import DrgStrip from '@/components/DrgStrip.vue'
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
import WardLinesPanel from './components/WardLinesPanel.vue'
import LinePanel from '@/components/LinePanel.vue'
import BedsidePanel from '@/components/BedsidePanel.vue'
import DoctorCallPanel from '@/components/DoctorCallPanel.vue'
import NutritionPanel from '@/components/NutritionPanel.vue'
import TubeFeedPanel from '@/components/TubeFeedPanel.vue'
import SafetyPanel from '@/components/SafetyPanel.vue'
import DischargePlanPanel from '@/components/DischargePlanPanel.vue'
import PcaPanel from '@/components/PcaPanel.vue'
import InfectionPanel from '@/components/InfectionPanel.vue'
import AdrPanel from '@/components/AdrPanel.vue'
import MedRecPanel from '@/components/MedRecPanel.vue'
import SpecimenPanel from '@/components/SpecimenPanel.vue'
import AdmissionExams from '@/components/AdmissionExams.vue'
import InfusionPanel from '@/components/InfusionPanel.vue'
import WoundPanel from '@/components/WoundPanel.vue'
import FlowsheetPanel from '@/components/FlowsheetPanel.vue'
import VentPanel from '@/components/VentPanel.vue'
import IcuBoardPanel from './components/IcuBoardPanel.vue'
import MarPanel from './components/MarPanel.vue'
import OrdersPanel from './components/OrdersPanel.vue'
import VitalsPanel from './components/VitalsPanel.vue'
import CodeBluePanel from '@/components/CodeBluePanel.vue'
import DeathPanel from '@/components/DeathPanel.vue'
import NegativeRoomPanel from './components/NegativeRoomPanel.vue'
import NursingNotesPanel from './components/NursingNotesPanel.vue'
import HandoverPanel from './components/HandoverPanel.vue'
import WardTasksPanel from './components/WardTasksPanel.vue'
import WardStockPanel from './components/WardStockPanel.vue'
import { bloodApi, dutyApi, masterApi, pressureApi, nursingApi, staffingApi, suggestAssign, wardStockApi } from '@/services'
import { UDialog, USelect } from '@/components/ui'
import { useAction } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { useQuery } from '@/composables/useService'
import { useNow } from '@/composables/useNow'

const clock = useNow()
// 急診留觀區照病房的方式照顧（給藥、生命徵象、護理紀錄）
// 加護病房：病房層級多一個「床邊看板」、病人多一個「重症流程表」
const icuWard = masterApi.staticCodes.icuWard
// 有負壓隔離室的病房（綜合病房 705、加護病房 ICU9）：病房層級多一個「負壓室」分頁
const { data: negRooms } = useQuery(() => pressureApi.listNegativeRooms())
const negWards = computed(() => [...new Set((negRooms.value ?? []).map((r) => r.ward))])
// 日間手術：沒有床、沒有排班分床；報到後到回家（或轉住院）在這裡給藥、量生命徵象、寫護理紀錄
const dayWard = masterApi.staticCodes.dayWard
const wards = [...masterApi.staticCodes.wards, icuWard, masterApi.staticCodes.obsWard, dayWard]
// 從急診看板點過來帶 ?ward=急診留觀區&admission=…
const ward = ref(wards.includes(String(useRoute().query.ward)) ? String(useRoute().query.ward) : wards[0])
// 沒指定病房（從首頁待辦點進來）：開這位護理師這一班排的病房（加護病房護理師不會先看到 5A）
if (!wards.includes(String(useRoute().query.ward)) && useAuth().user?.role === 'nurse') {
  nursingApi.myWard().then((w) => { if (w && wards.includes(w) && ward.value === wards[0]) ward.value = w }).catch(() => {})
}

// 現在的值班醫師（下班時間）：只列這個病房有病人的科
const { data: onCall } = useQuery(() => dutyApi.onCallNow(), [() => clock.value.slice(0, 13)])
const wardOnCall = computed(() => (onCall.value?.offHours ? onCall.value.list.filter((x) => (data.value?.list ?? []).some((p) => p.deptId === x.deptId)) : []))
const { data, loading, reload } = useQuery(
  async () => {
    const w = ward.value
    return { w, list: await nursingApi.listWardPatients(w) }
  },
  [ward],
)
const allPatients = computed(() => (data.value?.w === ward.value ? data.value.list : undefined))

// ---------- 責任分床：這一班誰上班、病人分給誰；「我的病人」 ----------
const auth = useAuth()
const { data: asgData, reload: reloadAsg } = useQuery(async () => ({ w: ward.value, v: ward.value === dayWard ? undefined : await staffingApi.getAssignments(ward.value) }), [ward, () => clock.value.slice(0, 13)])
const asg = computed(() => (asgData.value?.w === ward.value ? asgData.value.v : undefined))
const myCount = computed(() => (allPatients.value ?? []).filter((p) => p.nurseId === auth.user?.id).length)
// 這一班有分到病人：預設只看自己的；可以切回全病房
const mineOnly = ref(true)
const showMine = computed(() => mineOnly.value && myCount.value > 0)
const patients = computed(() => (showMine.value ? allPatients.value?.filter((p) => p.nurseId === auth.user?.id) : allPatients.value))
const taskScope = computed(() => (showMine.value ? (allPatients.value ?? []).filter((p) => p.nurseId === auth.user?.id).map((p) => p.id) : undefined))
const asgOpen = ref(false)
const asgMap = ref<Record<string, string | number | undefined>>({})
function openAsg() {
  asgMap.value = Object.fromEntries((asg.value?.patients ?? []).map((p) => [p.admissionId, p.nurseId ?? '']))
  asgAct.fieldErrors.value = {}
  asgOpen.value = true
}
function autoAsg() {
  const s = suggestAssign((asg.value?.patients ?? []).map((p) => p.admissionId), (asg.value?.nurses ?? []).map((n) => n.id))
  asgMap.value = { ...asgMap.value, ...s }
}
const asgAct = useAction(staffingApi.assignPatients, { success: '已分床' })
async function submitAsg() {
  if (await asgAct.run(ward.value, Object.fromEntries(Object.entries(asgMap.value).map(([k, v]) => [k, String(v ?? '')])))) {
    asgOpen.value = false
    reloadAsg()
    reload()
  }
}
// 逾時數由服務層依「查詢當下」計算，每分鐘重新查一次
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => (timer = setInterval(reload, 60_000)))
onBeforeUnmount(() => clearInterval(timer))

const admissionId = ref<string | undefined>(typeof useRoute().query.admission === 'string' ? String(useRoute().query.admission) : undefined)
const wristbandOpen = ref(false)
useRevealOnNarrow(admissionId) // 窄螢幕點選後把明細捲進畫面
const adm = computed(() => allPatients.value?.find((p) => p.id === admissionId.value))
// 換病房或病人出院後，取消選取
watch(allPatients, (list) => {
  if (list && admissionId.value && !list.some((p) => p.id === admissionId.value)) admissionId.value = undefined
})

// 分頁分兩組：沒選病人時是病房層級（本班待辦、交班）；選了病人才有個人的五個分頁。
// 以前沒選病人時也顯示「給藥紀錄、醫囑…」，點了只會看到同一張待辦清單，看起來能按卻沒作用。
// 首頁待辦可以直接帶到某個病房層級的分頁（例：本班未點班 → 常備點班）
// 呼叫醫師回覆了 → 帶入護理紀錄（切到護理紀錄分頁、填好 F／D／A）
const noteDraft = ref<{ callId: string; focus: string; data: string; action: string }>()
function takeCallNote(d: { callId: string; focus: string; data: string; action: string }) { noteDraft.value = { ...d }; tab.value = 'notes' }
const tab = ref(['stock', 'handover', 'icuboard', 'code', 'negative'].includes(String(useRoute().query.tab)) ? String(useRoute().query.tab) : 'tasks')
// 輸血：已發血待輸、輸血中（分頁上的數字）
const { data: blood } = useQuery(async () => (admissionId.value ? bloodApi.patientBlood(admissionId.value) : undefined), [admissionId])
const bloodTodo = computed(() => (blood.value && blood.value.admissionId === admissionId.value ? blood.value.requests.reduce((n, r) => n + r.rows.filter((x) => x.state === 'issued' || x.state === 'transfusing').length, 0) : 0))
// 有病房常備的病房才有「常備點班」（加護病房、留觀區沒有常備藥車，點進去只會報錯）
const { data: stockOf } = useQuery(async () => ({ ward: ward.value, has: !!(await wardStockApi.wardStockIfAny(ward.value)) }), [ward])
const hasStock = computed(() => stockOf.value?.ward === ward.value && stockOf.value.has)
const tabs = computed(() =>
  !adm.value
    ? [
        { key: 'tasks', label: '本班待辦' },
        ...(ward.value === icuWard ? [{ key: 'icuboard', label: '床邊看板' }] : []),
        ...(negWards.value.includes(ward.value) ? [{ key: 'negative', label: '負壓室' }] : []),
        // 日間手術沒有常備藥車、病房層級的隔離與品質指標
        ...(ward.value === dayWard
          ? []
          : [
              ...(hasStock.value ? [{ key: 'stock', label: '常備點班' }] : []),
              { key: 'scan', label: '給藥掃描' },
              { key: 'isoward', label: '隔離與 DNR', count: (allPatients.value ?? []).reduce((s, p) => s + p.isolationTodo, 0) || undefined },
              { key: 'lineward', label: '品質指標' },
            ]),
        { key: 'handover', label: '交班' },
      ]
    : [
        ...(adm.value.icu ? [{ key: 'flowsheet', label: '重症流程表', count: (adm.value.icu.late ? 1 : 0) + (adm.value.vent?.todo ?? 0) || undefined }, { key: 'vent', label: '呼吸器與鎮靜' }] : []),
        { key: 'mar', label: '給藥紀錄', count: adm.value.overdueCount + adm.value.dueCount || undefined },
        { key: 'orders', label: '醫囑', count: adm.value.unackedCount || undefined },
        { key: 'vitals', label: '生命徵象' },
        { key: 'code', label: '急救' },
        ...(adm.value.death ? [{ key: 'death', label: '死亡・遺體護理', count: adm.value.death.care ? undefined : 1 }] : []),
        { key: 'risk', label: '風險評估', count: adm.value.riskOverdue + adm.value.riskDue || undefined },
        { key: 'calls', label: '呼叫醫師' },
        { key: 'lines', label: '管路', count: adm.value.lineTodo || undefined },
        { key: 'bedside', label: '床邊處置' },
        { key: 'wounds', label: '傷口', count: adm.value.woundTodo || undefined },
        { key: 'infection', label: '感染通報' },
        { key: 'adr', label: '不良反應' },
        { key: 'medrec', label: '用藥整合' },
        { key: 'specimen', label: '檢體' },
        { key: 'exams', label: '檢查' },
        { key: 'safety', label: '譫妄與約束', count: (adm.value.deliriumDue ? 1 : 0) + (adm.value.restraint && adm.value.restraint.check !== 'ok' ? 1 : 0) || undefined },
        ...(adm.value.infusion ? [{ key: 'infusion', label: '點滴', count: adm.value.infusion.todo || undefined }] : []),
        ...(adm.value.pca ? [{ key: 'pca', label: 'PCA', count: (adm.value.pca.status === 'ordered' || adm.value.pca.record !== 'ok' || adm.value.pca.alert ? 1 : 0) || undefined }] : []),
        ...(adm.value.tube ? [{ key: 'tube', label: '管灌', count: adm.value.tube.due + adm.value.tube.overdue || undefined }] : []),
        { key: 'plan', label: '出院準備', count: adm.value.planDue && adm.value.planDue !== 'todo' ? 1 : undefined },
        { key: 'nutrition', label: '營養', count: adm.value.nutritionDue && adm.value.nutritionDue !== 'todo' ? 1 : undefined },
        { key: 'blood', label: '輸血', count: bloodTodo.value || undefined },
        { key: 'surgery', label: '手術' },
        { key: 'flags', label: '隔離與 DNR', count: adm.value.isolationTodo || undefined },
        { key: 'notes', label: '護理紀錄' },
        { key: 'handover', label: '交班' },
      ],
)
// 兩組之間切換：選了病人（從待辦切過來）→ 給藥紀錄；病人取消選取 → 本班待辦。交班兩組都有，保留不動
// 停在病房層級的分頁（常備點班、給藥掃描）時點病人，也換到給藥紀錄（以前會落到護理紀錄）
const WARD_ONLY = ['tasks', 'stock', 'scan', 'isoward', 'lineward', 'icuboard', 'negative']
watch(admissionId, (id) => {
  if (id && WARD_ONLY.includes(tab.value)) tab.value = adm.value?.icu ? 'flowsheet' : 'mar'
  else if (!id && tab.value !== 'handover' && !WARD_ONLY.includes(tab.value)) tab.value = 'tasks'
})

// 換病房後原本的病房層級分頁不存在（例：5A 的常備點班 → 加護病房沒有常備）：回到本班待辦。
// 等常備查好、而且沒選病人才判斷（病人資料載入中分頁清單會暫時是病房層級的，不能誤切）
watch([tabs, () => stockOf.value?.ward], ([ts]) => {
  if (admissionId.value || stockOf.value?.ward !== ward.value) return
  if (!ts.some((t) => t.key === tab.value)) tab.value = 'tasks'
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
  overdue: (allPatients.value ?? []).reduce((s, p) => s + p.overdueCount, 0),
  stat: (allPatients.value ?? []).reduce((s, p) => s + p.pendingStatCount, 0),
  unacked: (allPatients.value ?? []).reduce((s, p) => s + p.unackedCount, 0),
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
    <!-- 下班時間：這個病房病人各科的值班醫師（找人用） -->
    <div v-if="onCall?.offHours" class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-sm text-indigo-900">
      <span class="font-medium">值班醫師</span>
      <span v-for="x in wardOnCall" :key="x.deptId">{{ x.deptName }} {{ x.name }}</span>
      <span v-if="!wardOnCall.length" class="text-amber-800">這個病房病人的科今晚沒有排值班（請找主治）</span>
    </div>
    <!-- 這一班的人力與分床 -->
    <div v-if="asg && ward !== masterApi.staticCodes.obsWard" class="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm">
      <span class="font-medium text-slate-700">{{ asg.shift }}</span>
      <span class="text-slate-600">{{ asg.nurses.map((n) => `${n.name}${n.count ? `（${n.count}）` : ''}`).join('、') || '沒有排護理師' }}</span>
      <span :class="['tabular text-xs', asg.ratio.over ? 'font-semibold text-red-700' : 'text-slate-500']">護病比 {{ asg.ratio.text }}</span>
      <span v-if="asg.patients.some((p) => !p.nurseId)" class="text-xs text-amber-800">未分床 {{ asg.patients.filter((p) => !p.nurseId).length }} 位</span>
      <span class="ml-auto flex gap-1.5">
        <template v-if="myCount">
          <UButton size="sm" :variant="showMine ? 'primary' : 'secondary'" @click="mineOnly = true">我的病人 {{ myCount }}</UButton>
          <UButton size="sm" :variant="!showMine ? 'primary' : 'secondary'" @click="mineOnly = false">全病房 {{ allPatients?.length ?? 0 }}</UButton>
        </template>
        <UButton v-if="asg.canAssign" size="sm" variant="secondary" @click="openAsg">分床</UButton>
      </span>
    </div>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-[19rem_1fr]">
      <!-- 病房病人 -->
      <UCard :padded="false" class="self-start">
        <template #title>
          <div class="text-sm font-semibold text-slate-800">{{ ward }}</div>
          <div class="text-xs text-slate-500">{{ showMine ? `我的病人 ${patients?.length ?? 0} 位（全病房 ${allPatients?.length ?? 0}）` : `住院中 ${patients?.length ?? 0} 位` }}</div>
        </template>
        <UQueryState :loading="loading && !patients" :ready="!!patients?.length" empty-title="這個病房目前沒有住院病人">
          <ul class="max-h-[calc(100vh-14rem)] divide-y divide-slate-100 overflow-y-auto">
            <li v-for="p in patients" :key="p.id">
              <button :class="['w-full px-3 py-2.5 text-left hover:bg-slate-50', p.id === admissionId && '!bg-brand-50']" @click="admissionId = p.id">
                <div class="flex items-center gap-2">
                  <span class="tabular shrink-0 whitespace-nowrap rounded bg-slate-100 px-1.5 text-xs font-medium text-slate-700">{{ p.bed?.bedNo ?? '日間' }}</span>
                  <span class="shrink-0 whitespace-nowrap font-medium text-slate-800">{{ p.patientName }}</span>
                  <!-- 責任護理師：自己的不寫（「我的病人」時每一列都是自己，只會擠壓姓名）；別人的寫名字、沒分的標「未分床」 -->
                  <span v-if="asg && ward !== masterApi.staticCodes.obsWard && p.nurseId !== auth.user?.id" :class="['shrink-0 whitespace-nowrap text-xs', p.nurseId ? 'text-slate-500' : 'text-amber-700']">{{ p.nurseName ?? '未分床' }}</span>
                  <AlertTriangle v-if="p.allergies.length" class="h-3.5 w-3.5 text-red-600" :title="`過敏：${p.allergies.join('、')}`" />
                  <span class="ml-auto flex flex-wrap justify-end gap-1">
                    <UBadge v-if="p.ppe.length" tone="red" :title="`防護：${p.ppe.join('、')}`">{{ p.ppe.includes('N95') ? 'N95' : p.ppe.includes('外科口罩') ? '口罩' : '隔離衣' }}</UBadge>
                    <UBadge v-if="p.death" tone="gray" title="已宣告死亡：遺體護理、送太平間">已宣告死亡</UBadge>
                    <UBadge v-if="p.rrtPending" tone="red" title="已呼叫快速反應小組，等到場評估">快速反應</UBadge>
                    <UBadge v-if="p.news && p.news.level !== 'low'" :tone="p.news.level === 'high' || p.news.recheck === 'overdue' ? 'red' : 'yellow'" :title="`NEWS2 ${p.news.score} 分（${p.news.at.slice(11)}）：${p.news.recheck === 'overdue' ? '1 小時內再量已逾時' : '1 小時內再量'}`">NEWS {{ p.news.score }}</UBadge>
                    <UBadge v-if="p.icu?.late" tone="red" title="重症流程表超過 75 分鐘沒記">流程表 {{ p.icu.minutes }} 分</UBadge>
                    <UBadge v-if="p.vent?.on" tone="blue" title="使用呼吸器">呼吸器</UBadge>
                    <UBadge v-if="p.vent?.todo" :tone="p.vent.overdue ? 'red' : 'yellow'" title="呼吸器實測、RASS 每 4 小時（記在重症流程表）">實測／RASS {{ p.vent.todo }}</UBadge>
                    <UBadge v-if="p.vent?.rassOut" tone="red" title="最近一次 RASS 超出鎮靜目標">RASS 超出目標</UBadge>
                    <UBadge v-if="p.overdueCount" tone="red">逾時 {{ p.overdueCount }}</UBadge>
                    <UBadge v-if="p.dueCount" tone="yellow">待給 {{ p.dueCount }}</UBadge>
                    <UBadge v-if="p.pendingStatCount" tone="blue">臨時 {{ p.pendingStatCount }}</UBadge>
                    <UBadge v-if="p.unackedCount" tone="cyan">新醫囑 {{ p.unackedCount }}</UBadge>
                    <UBadge v-if="p.dischargeReady" tone="green">准出院</UBadge>
                    <UBadge v-if="!p.wristband" tone="red" title="腕帶還沒印：給藥掃描要用">未印腕帶</UBadge>
                    <UBadge v-if="p.bloodTransfusing" :tone="p.bloodUrgency ? 'red' : 'purple'" :title="p.bloodUrgency ? '輸血中：該量 15 分鐘生命徵象（或已超過 4 小時）' : '輸血中'">輸血中</UBadge>
                    <UBadge v-if="p.bloodIssued" :tone="p.bloodIssuedLate ? 'red' : 'yellow'" title="血庫已發血，請床邊雙人核對開始輸血">已發血</UBadge>
                    <UBadge v-if="p.painReassess === 'overdue'" tone="red" title="疼痛 ≥4 處置後 1 小時沒重評">疼痛重評逾時</UBadge>
                    <UBadge v-if="p.infusion?.todo" :tone="p.infusion.overdue ? 'red' : 'yellow'" title="點滴：待接上、快滴完或已滴完要換瓶、醫囑停了還在滴">點滴 {{ p.infusion.todo }}</UBadge>
                    <UBadge v-if="p.pca" :tone="p.pca.alert || p.pca.record === 'overdue' ? 'red' : 'blue'" :title="p.pca.alert ? 'PCA 警示待醫師處理' : p.pca.status === 'ordered' ? 'PCA 已開，待雙人核對架設' : 'PCA 使用中'">PCA</UBadge>
                    <UBadge v-if="p.restraint" :tone="p.restraint.check === 'overdue' || p.restraint.orderProblem ? 'red' : 'purple'" :title="p.restraint.check === 'overdue' ? '約束查核逾時' : p.restraint.orderProblem ? '約束醫囑待補或到期' : '約束中'">約束中</UBadge>
                    <UBadge v-if="p.deliriumPositive" tone="red" title="最近一次 CAM 陽性">譫妄</UBadge>
                    <UBadge v-if="p.tube?.highResidual" tone="red" title="最近一次管灌反抽超過 200 ml">反抽過多</UBadge>
                    <UBadge v-else-if="p.tube?.overdue" tone="red" title="管灌該灌沒記">管灌逾時</UBadge>
                    <UBadge v-if="p.nutritionDue === 'overdue'" tone="red" title="入院 48 小時內要做營養篩檢">營養篩檢逾時</UBadge>
                    <UBadge v-if="p.lineTodo" tone="cyan" title="管路：今天還沒評估還需要嗎、評估可移除、留置針滿 96 小時">管路 {{ p.lineTodo }}</UBadge>
                    <UBadge v-if="p.riskOverdue" tone="red" title="跌倒或壓傷評估過了期限">評估逾時</UBadge>
                    <UBadge v-else-if="p.riskDue" tone="yellow" title="跌倒或壓傷評估快到期">待評估</UBadge>
                  </span>
                </div>
                <div class="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-slate-500"><span class="max-w-full truncate">{{ p.diagnosis }}・第 {{ p.days }} 天</span><span v-if="p.lines.length" class="rounded bg-slate-100 px-1 text-slate-600" title="在身上的管路">{{ p.lines.join(' ') }}</span><span v-if="p.painScore !== undefined && p.painScore >= 4" class="font-medium text-red-700">疼痛 {{ p.painScore }}</span><RiskBadges :levels="p.riskLevels" compact /><PatientFlags :flags="p.flags" compact /></div>
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
            <UBadge tone="blue">{{ adm.bed?.bedNo ?? '日間手術' }}</UBadge>
            <span class="tabular text-sm text-slate-600">住院號 {{ adm.admitNo }}・第 {{ adm.days }} 天・{{ adm.doctorName }}</span>
            <RiskBadges :levels="adm.riskLevels" />
            <UButton size="sm" :variant="adm.wristband ? 'ghost' : 'secondary'" :class="!adm.wristband && 'text-red-700'" @click="wristbandOpen = true">{{ adm.wristband ? '重印腕帶' : '未印腕帶：列印' }}</UButton>
          </PatientBanner>
          <WristbandDialog v-model="wristbandOpen" :admission-id="adm.id" />
          <p v-if="adm.ppe.length" class="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-semibold text-red-800">隔離中：進病室前穿戴 {{ adm.ppe.join('、') }}</p>
          <!-- 家屬常問「到今天多少錢」：護理站看得到、可印明細，繳費在櫃台 -->
          <!-- 留觀中不顯示住院費用：留觀結束才算（離院在批價、收住院併入住院帳單） -->
          <IpdFeeStrip v-if="adm.obsStage !== 'open'" :admission-id="adm.id" />
          <DrgStrip v-if="adm.obsStage !== 'open'" :admission-id="adm.id" />
          <p v-else class="rounded-md bg-sky-50 px-3 py-1.5 text-xs text-sky-800">急診留觀：費用等急診醫師結束留觀後再算（離院在批價結、收住院併入住院帳單）</p>
          <!-- 醫師約好的出院後回診（有約才顯示）：出院衛教時提醒病人 -->
          <AfterDischargePanel :admission-id="adm.id" class="bg-white" />
        </template>

        <UCard :padded="false">
          <div class="px-4 pt-1"><UTabs v-model="tab" :tabs="tabs" /></div>
          <!-- 交班是病房層級，不必先選病人 -->
          <HandoverPanel v-if="tab === 'handover'" :ward="ward" :patients="allPatients ?? []" :selected-id="admissionId" :clock="clock" />
          <!-- 沒選病人時顯示全病房的本班待辦（以前是空白的「請選擇病人」）；點一列跳到該病人的對應分頁 -->
          <WardStockPanel v-else-if="!adm && tab === 'stock'" :ward="ward" :clock="clock" />
          <ScanStatsPanel v-else-if="!adm && tab === 'scan'" :ward="ward" />
          <WardFlagsPanel v-else-if="!adm && tab === 'isoward'" :ward="ward" @open="openTask" />
          <WardLinesPanel v-else-if="!adm && tab === 'lineward'" :ward="ward" />
          <IcuBoardPanel v-else-if="!adm && tab === 'icuboard' && ward === icuWard" @open="openTask" />
          <NegativeRoomPanel v-else-if="!adm && tab === 'negative'" :ward="ward" :can-record="auth.user?.role === 'nurse'" />
          <WardTasksPanel v-else-if="!adm" :ward="ward" :clock="clock" :only="taskScope" @open="openTask" />
          <FlowsheetPanel :key="adm.id" v-else-if="tab === 'flowsheet'" :admission-id="adm.id" />
          <VentPanel :key="adm.id" v-else-if="tab === 'vent'" :admission-id="adm.id" @open-flowsheet="tab = 'flowsheet'" />
          <MarPanel :key="adm.id" v-else-if="tab === 'mar'" :admission="adm" :clock="clock" />
          <OrdersPanel :key="adm.id" v-else-if="tab === 'orders'" :admission="adm" />
          <RiskPanel :key="adm.id" v-else-if="tab === 'risk'" :admission="adm" />
          <LinePanel :key="adm.id" v-else-if="tab === 'lines'" :admission-id="adm.id" />
          <BedsidePanel :key="adm.id" v-else-if="tab === 'bedside'" :admission-id="adm.id" />
          <DoctorCallPanel :key="adm.id" v-else-if="tab === 'calls'" :admission-id="adm.id" @note="takeCallNote" />
          <NutritionPanel :key="adm.id" v-else-if="tab === 'nutrition'" :admission-id="adm.id" />
          <TubeFeedPanel :key="adm.id" v-else-if="tab === 'tube'" :admission-id="adm.id" />
          <SafetyPanel :key="adm.id" v-else-if="tab === 'safety'" :admission-id="adm.id" />
          <DischargePlanPanel :key="adm.id" v-else-if="tab === 'plan'" :admission-id="adm.id" />
          <PcaPanel :key="adm.id" v-else-if="tab === 'pca'" :admission-id="adm.id" />
          <InfectionPanel :key="adm.id" v-else-if="tab === 'infection'" :admission-id="adm.id" />
          <div :key="adm.id" v-else-if="tab === 'adr'" class="p-4"><AdrPanel :admission-id="adm.id" /></div>
          <div :key="adm.id" v-else-if="tab === 'medrec'" class="p-4"><MedRecPanel :admission-id="adm.id" /></div>
          <div :key="adm.id" v-else-if="tab === 'exams'" class="p-4"><AdmissionExams :admission-id="adm.id" /></div>
          <div :key="adm.id" v-else-if="tab === 'specimen'" class="p-4"><SpecimenPanel :admission-id="adm.id" /></div>
          <InfusionPanel :key="adm.id" v-else-if="tab === 'infusion'" :admission-id="adm.id" />
          <WoundPanel :key="adm.id" v-else-if="tab === 'wounds'" :admission-id="adm.id" @open-risk="tab = 'risk'" />
          <BloodPanel :key="adm.id" v-else-if="tab === 'blood'" :admission-id="adm.id" />
          <SurgeryPanel :key="adm.id" v-else-if="tab === 'surgery'" :admission-id="adm.id" />
          <PatientFlagsPanel :key="adm.id" v-else-if="tab === 'flags'" :patient-id="adm.patientId" />
          <VitalsPanel :key="adm.id" v-else-if="tab === 'vitals'" :admission="adm" />
          <CodeBluePanel :key="adm.id" v-else-if="tab === 'code'" :admission-id="adm.id" />
          <DeathPanel :key="adm.id" v-else-if="tab === 'death'" :admission-id="adm.id" @changed="reload" />
          <NursingNotesPanel :key="adm.id" v-else :admission="adm" :draft="noteDraft" @draft-used="noteDraft = undefined" />
        </UCard>
      </div>
    </div>
    <UDialog v-model="asgOpen" :title="`分床：${ward} ${asg?.date ?? ''} ${asg?.shift ?? ''}`" @submit="submitAsg">
      <div class="space-y-2 text-sm">
        <div class="flex items-center gap-2">
          <span class="text-slate-600">這班上班：{{ asg?.nurses.map((n) => n.name).join('、') || '沒有排護理師（請先排班）' }}</span>
          <UButton v-if="asg?.nurses.length" class="ml-auto" size="sm" variant="secondary" @click="autoAsg">依床號平均分</UButton>
        </div>
        <div v-for="p in asg?.patients ?? []" :key="p.admissionId" class="flex items-center gap-2">
          <span class="tabular w-14 text-slate-600">{{ p.bedNo }}</span>
          <span class="w-20 truncate">{{ p.patientName }}</span>
          <USelect v-model="asgMap[p.admissionId]" class="flex-1" :options="[{ label: '未分床', value: '' }, ...(asg?.nurses ?? []).map((n) => ({ label: n.name, value: n.id }))]" />
        </div>
        <p v-if="asgAct.fieldErrors.value.nurseId" class="text-xs text-red-600">{{ asgAct.fieldErrors.value.nurseId }}</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="asgOpen = false">取消</UButton>
        <UButton type="submit" :loading="asgAct.pending.value">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
