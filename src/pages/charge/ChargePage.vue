<script setup lang="ts">
// 批價結帳：左邊當日清單（待批價在上），右邊試算明細 → 結帳 → 收據；另有日結報表分頁。
// 金額全部來自服務層（previewCharge / pay），頁面只算「實收 − 應收 = 找零」。
import { computed, ref, watch } from 'vue'
import { Ban, CreditCard, Printer, Smartphone, Wallet } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UDialog, UEmpty, UInput, UQueryState, UStatusBadge, UTabs, UTextarea } from '@/components/ui'
import PatientBanner from '@/components/PatientBanner.vue'
import ChargeLinesTable from './components/ChargeLinesTable.vue'
import ReceiptCard from './components/ReceiptCard.vue'
import DailyReport from './components/DailyReport.vue'
import { chargeApi, checkCash } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { followToday } from '@/composables/useClock'
import { periodLabel, today } from '@/utils/date'
import { visitStatus } from '@/utils/labels'
import type { PayMethod } from '@/types'

const tab = ref('charge')

// ---------- 清單 ----------
const date = ref(today())
const todayStr = followToday(date) // 原本看今天的，跨日時自動換到新的一天
const { data: list, loading: listLoading } = useQuery(() => chargeApi.listChargeQueue(date.value), [date])
const pendingCount = computed(() => (list.value ?? []).filter((v) => v.status === 'consulted').length)

const visitId = ref<string>()
watch(date, () => (visitId.value = undefined))

// ---------- 右側資料：一次取得（狀態、試算、收據在同一時間點讀出，不依賴可能過期的清單） ----------
const { data: detail, loading: detailLoading } = useQuery(
  async () => (visitId.value ? chargeApi.getChargeDetail(visitId.value) : undefined),
  [visitId],
)
// 切換病人時，舊病人的資料在新資料回來前不顯示
const item = computed(() => (detail.value?.visit.id === visitId.value ? detail.value?.visit : undefined))
const preview = computed(() => (item.value ? detail.value?.preview : undefined))
const receipt = computed(() => (item.value ? detail.value?.receipt : undefined))

// ---------- 結帳 ----------
const payMethod = ref<PayMethod>('cash')
const received = ref<number | undefined>()
const total = computed(() => preview.value?.patientTotal ?? 0)
// 換病人時預設實收＝應收
watch(total, (t) => (received.value = t))

/** 現金快速鍵：剛好、湊整百、500、1000、2000（只列出 ≥ 應收的） */
const quickAmounts = computed(() => {
  const t = total.value
  return [...new Set([t, Math.ceil(t / 100) * 100, 500, 1000, 2000])].filter((n) => n >= t).sort((a, b) => a - b).slice(0, 5)
})
const change = computed(() => (payMethod.value === 'cash' ? (received.value ?? 0) - total.value : 0))
// 與服務層同一條規則：不足、非整數、找零異常（多打了 0）都不能收款
const cashProblem = computed(() => (payMethod.value === 'cash' && preview.value ? checkCash(total.value, received.value) : null))
const canPay = computed(() => !!preview.value && !cashProblem.value)

const pay = useAction(chargeApi.pay, { success: (c) => `結帳完成：收據 ${c.receiptNo}` })
async function onPay() {
  if (!item.value || !canPay.value) return
  await pay.run(item.value.id, { payMethod: payMethod.value, received: payMethod.value === 'cash' ? received.value ?? 0 : total.value })
  // 結帳後清單經 dbVersion 自動刷新，右側會切換成收據
}

const methods: { key: PayMethod; label: string; icon: typeof Wallet }[] = [
  { key: 'cash', label: '現金', icon: Wallet },
  { key: 'card', label: '信用卡', icon: CreditCard },
  { key: 'mobile', label: '行動支付', icon: Smartphone },
]

const print = () => window.print()

// ---------- 作廢 ----------
const voidOpen = ref(false)
const voidReason = ref('')
const voidAction = useAction(chargeApi.voidCharge, { success: (c) => `已作廢收據 ${c.receiptNo}，病人回到待批價` })
function openVoid() {
  voidReason.value = ''
  voidOpen.value = true
}
async function onVoid() {
  if (!receipt.value) return
  if (await voidAction.run(receipt.value.id, voidReason.value)) voidOpen.value = false
}
</script>

<template>
  <div class="space-y-4">
    <UTabs v-model="tab" :tabs="[{ key: 'charge', label: '批價作業', count: pendingCount }, { key: 'report', label: '日結報表' }]" class="no-print" />

    <DailyReport v-if="tab === 'report'" />

    <div v-else class="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_1fr]">
      <!-- 清單 -->
      <UCard :padded="false" class="no-print self-start">
        <template #title><span class="text-sm font-semibold text-slate-800">批價清單</span></template>
        <template #actions><div class="w-40"><UInput v-model="date" type="date" :max="todayStr" /></div></template>
        <UQueryState :loading="listLoading" :ready="!!list?.length" empty-title="沒有看診完成的病人">
        <ul class="max-h-[calc(100vh-13rem)] divide-y divide-slate-100 overflow-y-auto">
          <li v-for="v in list" :key="v.id">
            <button :class="['flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50', v.id === visitId && '!bg-brand-50']" @click="visitId = v.id">
              <span class="min-w-0 flex-1">
                <span class="block font-medium text-slate-800">{{ v.patientName }} <span class="tabular text-xs font-normal text-slate-500">{{ v.chartNo }}</span></span>
                <span class="block truncate text-xs text-slate-500">{{ periodLabel[v.period] }}・{{ v.deptName }} {{ v.doctorName }}</span>
              </span>
              <span class="text-right">
                <UStatusBadge :map="visitStatus" :value="v.status" />
                <span v-if="v.charge" class="tabular block text-xs text-slate-500">${{ v.charge.patientTotal }}</span>
              </span>
            </button>
          </li>
        </ul>
        </UQueryState>
      </UCard>

      <!-- 右側 -->
      <UCard v-if="!visitId" class="no-print"><UEmpty title="請從左側選擇病人" description="待批價的病人排在最上方" /></UCard>
      <UCard v-else-if="!item" class="no-print"><UQueryState :loading="detailLoading" :ready="false" empty-title="找不到這筆就醫紀錄" /></UCard>
      <div v-else class="min-w-0 space-y-4">
        <PatientBanner :patient="item" class="no-print">
          <UBadge tone="blue">{{ item.identityName }}</UBadge>
          <UBadge>案件 {{ item.caseType }}</UBadge>
        </PatientBanner>

        <!-- 待批價：試算 + 結帳 -->
        <div v-if="item.status === 'consulted'" class="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_20rem]">
          <UCard title="收費明細（試算）">
            <ChargeLinesTable v-if="preview" :lines="preview.lines" :patient-total="preview.patientTotal" :nhi-points="preview.nhiPoints" />
          </UCard>

          <UCard title="結帳" class="self-start">
            <div class="space-y-4">
              <div class="rounded-md bg-slate-900 px-4 py-3 text-right text-white">
                <div class="text-xs text-slate-400">應收金額</div>
                <div class="tabular text-3xl font-bold">$ {{ total.toLocaleString() }}</div>
              </div>

              <div class="grid grid-cols-3 gap-2">
                <button
                  v-for="m in methods"
                  :key="m.key"
                  :class="['flex flex-col items-center gap-1 rounded-md border py-2 text-xs', payMethod === m.key ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50']"
                  @click="payMethod = m.key"
                >
                  <component :is="m.icon" class="h-4 w-4" />{{ m.label }}
                </button>
              </div>

              <template v-if="payMethod === 'cash'">
                <UInput
                  v-model="received"
                  label="實收"
                  type="number"
                  min="0"
                  class="tabular text-right text-lg"
                  :error="cashProblem && change >= 0 ? cashProblem : pay.fieldErrors.value.received"
                />
                <div class="flex flex-wrap gap-1.5">
                  <UButton v-for="a in quickAmounts" :key="a" size="sm" variant="secondary" @click="received = a">{{ a === total ? '剛好' : a }}</UButton>
                </div>
                <!-- 綠色只代表「可以收款」：不足是紅色、金額異常是黃色，不要讓錯誤的找零看起來像沒問題 -->
                <div :class="['flex justify-between rounded-md px-3 py-2 text-sm', change < 0 ? 'bg-red-50 text-red-700' : cashProblem ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800']">
                  <span>{{ change < 0 ? '尚差' : '找零' }}</span>
                  <span class="tabular text-lg font-bold">$ {{ Math.abs(change).toLocaleString() }}</span>
                </div>
              </template>
              <p v-else class="text-xs text-slate-500">刷卡與行動支付以應收金額扣款，無需找零。</p>

              <UButton block :disabled="!canPay" :loading="pay.pending.value" @click="onPay">確認收款</UButton>
            </div>
          </UCard>
        </div>

        <!-- 已批價：收據 -->
        <template v-else-if="receipt">
          <div class="no-print flex flex-wrap items-center gap-2">
            <UBadge v-if="item.status === 'dispensed'" tone="green">藥品已發出，無法作廢</UBadge>
            <div class="ml-auto flex gap-2">
              <UButton variant="danger" :icon="Ban" :disabled="item.status === 'dispensed'" @click="openVoid">作廢</UButton>
              <UButton variant="secondary" :icon="Printer" @click="print">列印收據</UButton>
            </div>
          </div>
          <ReceiptCard :receipt="receipt" />
        </template>
      </div>
    </div>

    <UDialog v-model="voidOpen" title="作廢收據" size="sm">
      <div class="space-y-3 text-sm">
        <p class="text-slate-600">
          作廢 <span class="tabular font-medium">{{ receipt?.receiptNo }}</span> 後，病人回到「待批價」，醫師可以修改醫囑，藥局的調劑單也會一併取消。
        </p>
        <UTextarea v-model="voidReason" label="作廢原因" required placeholder="例：身分別輸入錯誤、醫師修改處方" :rows="2" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="voidOpen = false">取消</UButton>
        <UButton variant="danger" :disabled="!voidReason.trim()" :loading="voidAction.pending.value" @click="onVoid">確定作廢</UButton>
      </template>
    </UDialog>
  </div>
</template>
