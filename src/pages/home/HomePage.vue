<script setup lang="ts">
// 首頁儀表板：今日營運指標、近 7 日趨勢、依角色顯示的待辦。
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import {
  AlertTriangle, BedDouble, ChevronRight, ClipboardCheck, Coins, DoorOpen, Package, PhoneCall, Pill, Receipt, Stethoscope, Truck, Users,
} from 'lucide-vue-next'
import { UBarChart, UCard, UEmpty, UStatCard } from '@/components/ui'
import { dashboardApi, opdApi } from '@/services'
import { useQuery } from '@/composables/useService'
import { useToday } from '@/composables/useClock'
import { useAuth } from '@/stores/auth'
import { useCan } from '@/composables/useCan'
import DiscountRequestsCard from '@/components/DiscountRequestsCard.vue'
import { money } from '@/utils/labels'

const auth = useAuth()
const can = useCan()
const router = useRouter()

const { data: s, reload } = useQuery(() => dashboardApi.getDashboard())

// 醫師才查自己的候診清單
const isDoctor = computed(() => auth.user?.role === 'doctor' && !!auth.user.doctorId)
const todayStr = useToday()
const { data: myQueue } = useQuery(async () => (isDoctor.value ? opdApi.listQueue({ date: todayStr.value, doctorId: auth.user!.doctorId! }) : []), [todayStr])
const myWaiting = computed(() => (myQueue.value ?? []).filter((v) => v.status === 'registered' || v.status === 'in-consult').length)

// 「時間經過」也會讓數字改變（例如給藥逾時），但資料沒變、dbVersion 不會動，所以每分鐘重查一次
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => (timer = setInterval(reload, 60_000)))
onBeforeUnmount(() => clearInterval(timer))

interface Todo {
  label: string
  count: number
  hint: string
  route: string
  query?: Record<string, string>
  icon: typeof Users
  urgent?: boolean
}

/** 依角色挑出「我現在該處理的事」 */
const todos = computed<Todo[]>(() => {
  if (!s.value) return []
  const role = auth.user?.role
  const list: (Todo & { roles: string[] })[] = [
    { roles: ['doctor'], label: '待回覆會診', count: s.value.consultIncoming ?? 0, hint: s.value.consultUrgent ? `其中急會診 ${s.value.consultUrgent} 張` : '他科請本科會診的住院病人', route: 'ipd', icon: Stethoscope, urgent: !!s.value.consultUrgent },
    { roles: ['doctor'], label: '轉入申請', count: s.value.transferIncoming ?? 0, hint: '他科申請轉入本科的住院病人，待接受', route: 'ipd', icon: Stethoscope, urgent: true },
    { roles: ['doctor'], label: '待回覆門診會診', count: s.value.opdConsultIncoming ?? 0, hint: '他科看診時請本科書面會診（病人不必在場）', route: 'opd', icon: Stethoscope, urgent: true },
    { roles: ['doctor'], label: '會診已回覆', count: s.value.consultReplies ?? 0, hint: '我申請的門診會診已回覆，看過按已閱', route: 'opd', icon: Stethoscope },
    { roles: ['doctor'], label: '會診醫師新開的醫囑', count: s.value.consultOrdersUnseen ?? 0, hint: '我的住院病人：會診醫師開了醫囑，看過後按「已閱」', route: 'ipd', icon: Stethoscope, urgent: true },
    { roles: ['doctor'], label: '護理師醫囑疑問', count: s.value.orderQueries ?? 0, hint: '我的住院病人，待回覆（回覆前給藥暫停）', route: 'ipd', icon: Stethoscope, urgent: true },
    { roles: ['doctor'], label: '我的候診病人', count: myWaiting.value, hint: '今日全部診次・含看診中', route: 'opd', icon: Stethoscope },
    { roles: ['clerk'], label: '待批價', count: s.value.opd.toCharge, hint: '看診完成，等待結帳', route: 'charge', icon: Receipt },
    { roles: ['clerk'], label: '待退費', count: s.value.pendingRefunds, hint: '部分退藥、檢驗處置未執行後，退還病人差額（可能是前幾天看的診）', route: 'charge', icon: Receipt, urgent: true },
    { roles: ['clerk'], label: '停診待通知', count: s.value.suspendNoticesPending, hint: '停診退掛的病人，需電話通知', route: 'booking', icon: PhoneCall, urgent: true },
    { roles: ['pharmacist'], label: '住院補調劑', count: s.value.udExtra, hint: '今天的劑量還沒調劑（新開的醫囑），護理師在等', route: 'ud', icon: Pill, urgent: true },
    { roles: ['pharmacist'], label: '住院待核對', count: s.value.udVerify, hint: '已調劑的藥盒，核對通過才送病房', route: 'ud', icon: Pill, urgent: true },
    { roles: ['pharmacist'], label: '住院待退藥', count: s.value.udReturns, hint: '病房已送回，待點收入庫', route: 'ud', icon: Pill },
    { roles: ['pharmacist'], label: '病房回報不符', count: s.value.udIssues, hint: '藥車點收時發現短少、破損，待藥局處理', route: 'ud', icon: AlertTriangle, urgent: true },
    { roles: ['nurse'], label: '藥車待點收', count: s.value.udToReceive, hint: '藥局已核對送出的藥盒（全院），在護理站本班待辦點收', route: 'nursing', icon: Pill },
    { roles: ['pharmacist'], label: '病房常備待補充', count: s.value.wardRefillDue, hint: '各病房低於基準量的品項，在住院藥局補充', route: 'ud', icon: Pill },
    { roles: ['nurse'], label: '本班未點班', count: s.value.wardCountDue, hint: '病房常備還沒點班的病房（全院），在護理站「常備點班」', route: 'nursing', query: { tab: 'stock' }, icon: Pill },
    { roles: ['nurse'], label: '待送回藥局', count: s.value.udSendBack, hint: '沒給的 UD 藥（含出院病人），在護理站本班待辦送回', route: 'nursing', icon: Pill },
    { roles: ['pharmacist'], label: '待領藥', count: s.value.opd.toDispense, hint: '已批價，等待調劑發藥', route: 'pharmacy', icon: Pill },
    { roles: ['nurse'], label: '逾時未給藥', count: s.value.ipd.overdueMar, hint: '已過預定時間尚未執行', route: 'nursing', icon: AlertTriangle, urgent: true },
    { roles: ['clerk', 'nurse'], label: '今日待報到住院', count: s.value.ipd.reservedToday, hint: '預約入院日為今天或更早（含逾期未報到）', route: 'admission', icon: DoorOpen },
    { roles: ['pharmacist'], label: '缺貨或低於安全庫存', count: s.value.lowStockDrugs, hint: '門診藥局需要補貨的藥品', route: 'drugs', query: { filter: 'short' }, icon: Package, urgent: true },
    { roles: ['pharmacist'], label: '補貨申請待到貨', count: s.value.restockOpen, hint: '已申請、還沒到貨入庫', route: 'drugs', query: { filter: 'restock' }, icon: Truck },
    ...(s.value.transferRequested !== undefined
      ? [
          { roles: ['pharmacist'], label: '撥補待撥發', count: s.value.transferRequested, hint: '藥局請領、等藥庫撥發', route: 'drugs', query: { tab: 'transfer' }, icon: Truck },
          { roles: ['pharmacist'], label: '撥補待簽收', count: s.value.transferIssued ?? 0, hint: '運送中，簽收才入帳', route: 'drugs', query: { tab: 'transfer' }, icon: Truck },
          { roles: ['pharmacist'], label: '退回待藥庫審核', count: s.value.returnToReview ?? 0, hint: '藥局申請退回藥庫，藥庫逐批同意、少收或不收', route: 'drugs', query: { tab: 'transfer' }, icon: Truck },
          { roles: ['pharmacist'], label: '退回已核准待送出', count: s.value.returnToShip ?? 0, hint: '藥庫已同意，藥局送出才扣帳', route: 'drugs', query: { tab: 'transfer' }, icon: Truck },
        ]
      : []),
    { roles: ['pharmacist'], label: '採購單待到貨', count: s.value.purchaseOrdered, hint: '已核准訂購，貨到了對品項入庫', route: 'drugs', query: { tab: 'purchase' }, icon: Truck },
    // 管理員唯一的待辦：核准採購（開單與核准分開，是給管理員做的事）
    { roles: ['admin'], label: '採購單待核准', count: s.value.purchasePending, hint: '藥師送出、等核准才算訂購', route: 'drugs', query: { tab: 'purchase' }, icon: Truck, urgent: true },
  ]
  // 管理員不做第一線作業，下方指標卡已涵蓋其他數字；只列「核准採購」這種只有管理員能做的事
  return list.filter((t) => t.roles.includes(role ?? ''))
})

const trend = computed(() =>
  (s.value?.trend ?? []).map((t) => ({ label: t.date.slice(5).replace('-', '/'), title: t.date, value: t.count })),
)
const deptMax = computed(() => Math.max(1, ...(s.value?.byDept ?? []).map((d) => d.count)))
</script>

<template>
  <div v-if="s" class="space-y-5">
    <!-- 待核准優免：有「可核准優免」的人才查（主管在首頁直接核准，不必到櫃台） -->
    <DiscountRequestsCard v-if="can('charge.approveDiscount')" />
    <!-- 我的待辦 -->
    <section v-if="todos.length">
      <h2 class="mb-2 text-sm font-semibold text-slate-600">{{ auth.user?.name }}，您目前的待辦</h2>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <button
          v-for="t in todos"
          :key="t.label"
          :class="[
            'group flex items-center gap-3 rounded-lg border bg-white p-4 text-left shadow-sm transition hover:shadow',
            t.urgent && t.count > 0 ? 'border-red-200 hover:border-red-300' : 'border-slate-200 hover:border-brand-300',
          ]"
          @click="router.push({ name: t.route, query: t.query })"
        >
          <div :class="['rounded-md p-2', t.urgent && t.count > 0 ? 'bg-red-50 text-red-600' : 'bg-brand-50 text-brand-600']">
            <component :is="t.icon" class="h-5 w-5" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-sm text-slate-600">{{ t.label }}</div>
            <div class="text-xs text-slate-400">{{ t.hint }}</div>
          </div>
          <div :class="['tabular text-2xl font-semibold', t.urgent && t.count > 0 ? 'text-red-600' : 'text-slate-800']">{{ t.count }}</div>
          <ChevronRight class="h-4 w-4 text-slate-300 group-hover:text-slate-500" />
        </button>
      </div>
    </section>

    <!-- 門診指標 -->
    <section class="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <UStatCard label="今日掛號" :value="s.opd.total" :hint="`候診 ${s.opd.waiting}・看診中 ${s.opd.inConsult}・退掛 ${s.opd.cancelled}`" :icon="Users" />
      <UStatCard label="待批價" :value="s.opd.toCharge" hint="看診完成未結帳" :icon="Receipt" tone="amber" />
      <UStatCard label="待領藥" :value="s.opd.toDispense" hint="已批價未發藥" :icon="Pill" tone="amber" />
      <!-- 今日收入只有掛號批價與管理員看得到：其他角色服務層不回傳這筆資料 -->
      <UStatCard v-if="s.revenue" label="今日收入" :value="money(s.revenue.patientTotal)" :hint="`${s.revenue.receipts} 張收據・申報 ${s.revenue.nhiPoints.toLocaleString()} 點`" :icon="Coins" tone="emerald" />
    </section>

    <!-- 住院與藥品指標 -->
    <section class="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <UStatCard label="住院中" :value="s.ipd.admitted" :hint="`今日待報到 ${s.ipd.reservedToday} 人`" :icon="BedDouble" />
      <UStatCard label="可用空床" :value="`${s.ipd.emptyBeds} / ${s.ipd.totalBeds}`" hint="不含清潔中、保留床" :icon="ClipboardCheck" tone="emerald" />
      <UStatCard label="逾時未給藥" :value="s.ipd.overdueMar" :hint="s.ipd.overdueMar ? '請護理站儘速處理' : '目前沒有逾時'" :icon="AlertTriangle" :tone="s.ipd.overdueMar ? 'red' : 'slate'" />
      <UStatCard label="缺貨或低於安全庫存" :value="s.lowStockDrugs" hint="門診藥局的藥品品項數" :icon="Package" :tone="s.lowStockDrugs ? 'amber' : 'slate'" />
    </section>

    <!-- 圖表 -->
    <section class="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <UCard title="近 7 日門診人次" subtitle="不含退掛" class="lg:col-span-3">
        <UBarChart :data="trend" unit="人" :height="220" />
      </UCard>
      <UCard title="今日各科掛號" subtitle="不含退掛" class="lg:col-span-2">
        <UEmpty v-if="!s.byDept.length" title="今天還沒有掛號" />
        <!-- 類別少、只比大小：橫條最直接；數值以文字直接標示 -->
        <ul v-else class="space-y-2.5">
          <li v-for="d in s.byDept" :key="d.deptName" class="grid grid-cols-[4.5rem_1fr_2rem] items-center gap-2 text-sm">
            <span class="truncate text-slate-600">{{ d.deptName }}</span>
            <div class="h-3 rounded-r bg-slate-100">
              <div class="h-3 rounded-r bg-brand-600" :style="{ width: `${(d.count / deptMax) * 100}%` }" />
            </div>
            <span class="tabular text-right font-medium text-slate-700">{{ d.count }}</span>
          </li>
        </ul>
      </UCard>
    </section>
  </div>
</template>
