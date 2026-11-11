<script setup lang="ts">
// 首頁儀表板：今日營運指標、近 7 日趨勢、依角色顯示的待辦。
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import {
  AlertTriangle, BedDouble, ChevronRight, ClipboardCheck, Coins, DoorOpen, Package, PhoneCall, Pill, Receipt, Stethoscope, Users,
} from 'lucide-vue-next'
import { UBarChart, UCard, UEmpty, UStatCard } from '@/components/ui'
import { dashboardApi, opdApi } from '@/services'
import { useQuery } from '@/composables/useService'
import { useToday } from '@/composables/useClock'
import { useAuth } from '@/stores/auth'
import { money } from '@/utils/labels'

const auth = useAuth()
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
  icon: typeof Users
  urgent?: boolean
}

/** 依角色挑出「我現在該處理的事」 */
const todos = computed<Todo[]>(() => {
  if (!s.value) return []
  const role = auth.user?.role
  const list: (Todo & { roles: string[] })[] = [
    { roles: ['doctor'], label: '我的候診病人', count: myWaiting.value, hint: '今日全部診次・含看診中', route: 'opd', icon: Stethoscope },
    { roles: ['clerk'], label: '待批價', count: s.value.opd.toCharge, hint: '看診完成，等待結帳', route: 'charge', icon: Receipt },
    { roles: ['clerk'], label: '停診待通知', count: s.value.suspendNoticesPending, hint: '停診退掛的病人，需電話通知', route: 'booking', icon: PhoneCall, urgent: true },
    { roles: ['pharmacist'], label: '待領藥', count: s.value.opd.toDispense, hint: '已批價，等待調劑發藥', route: 'pharmacy', icon: Pill },
    { roles: ['nurse'], label: '逾時未給藥', count: s.value.ipd.overdueMar, hint: '已過預定時間尚未執行', route: 'nursing', icon: AlertTriangle, urgent: true },
    { roles: ['clerk', 'nurse'], label: '今日待報到住院', count: s.value.ipd.reservedToday, hint: '預約入院日為今天或更早（含逾期未報到）', route: 'admission', icon: DoorOpen },
    { roles: ['pharmacist'], label: '低於安全庫存', count: s.value.lowStockDrugs, hint: '需要補貨的藥品', route: 'drugs', icon: Package, urgent: true },
  ]
  // 管理員不做第一線作業，下方指標卡已涵蓋全部數字，不再重複列待辦
  return list.filter((t) => t.roles.includes(role ?? ''))
})

const trend = computed(() =>
  (s.value?.trend ?? []).map((t) => ({ label: t.date.slice(5).replace('-', '/'), title: t.date, value: t.count })),
)
const deptMax = computed(() => Math.max(1, ...(s.value?.byDept ?? []).map((d) => d.count)))
</script>

<template>
  <div v-if="s" class="space-y-5">
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
          @click="router.push({ name: t.route })"
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
      <UStatCard label="低於安全庫存" :value="s.lowStockDrugs" hint="藥品品項數" :icon="Package" :tone="s.lowStockDrugs ? 'amber' : 'slate'" />
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
