<script setup lang="ts">
// 批價結帳：左邊當日清單（待批價在上），右邊試算明細 → 結帳 → 收據；另有日結報表分頁。
// 金額全部來自服務層（previewCharge / pay），頁面只算「實收 − 應收 = 找零」。
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { computed, ref, watch } from 'vue'
import { Ban, CreditCard, Printer, Smartphone, Wallet } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UCheckbox, UDialog, UEmpty, UInput, UQueryState, USelect, UStatusBadge, UTabs, UTextarea } from '@/components/ui'
import PatientBanner from '@/components/PatientBanner.vue'
import IdentityCorrectDialog from '@/components/IdentityCorrectDialog.vue'
import ChargeLinesTable from './components/ChargeLinesTable.vue'
import ReceiptCard from './components/ReceiptCard.vue'
import DailyReport from './components/DailyReport.vue'
import { chargeApi, checkCash, checkRepay, discountSummary } from '@/services'
import type { DebtItem } from '@/services/charge'
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
// 搜尋姓名或病歷號；只剩一筆時 Enter 直接選取
const kw = ref('')
const shown = computed(() => {
  const k = kw.value.trim()
  return (list.value ?? []).filter((v) => !k || v.patientName.includes(k) || v.chartNo.includes(k))
})
function onSearchEnter() {
  if (shown.value.length === 1) visitId.value = shown.value[0].id
}

const visitId = ref<string>()
useRevealOnNarrow(visitId) // 窄螢幕點選後把明細捲進畫面
watch(date, () => (visitId.value = undefined))

// ---------- 右側資料：一次取得（狀態、試算、收據在同一時間點讀出，不依賴可能過期的清單） ----------
// 優免（discountCode）也一起帶進同一次查詢——見服務層 getChargeDetail 的說明
const discountCode = ref('')
const discountReason = ref('')
const { data: detail, loading: detailLoading } = useQuery(
  async () => (visitId.value ? chargeApi.getChargeDetail(visitId.value, discountCode.value) : undefined),
  [visitId, discountCode],
)
// 切換病人時，舊病人的資料在新資料回來前不顯示
const item = computed(() => (detail.value?.visit.id === visitId.value ? detail.value?.visit : undefined))
// ---------- 優免：選了就請服務層連優免一起重算（金額只在服務層算）；換病人清掉 ----------
const { data: discountRules } = useQuery(() => chargeApi.listDiscounts())
watch(visitId, () => {
  discountCode.value = ''
  discountReason.value = ''
})
const rule = computed(() => discountRules.value?.find((d) => d.code === discountCode.value))
const discountOptions = computed(() => [{ label: '不優免', value: '' }, ...(discountRules.value ?? []).map((d) => ({ label: `${d.name}（${discountSummary(d)}）`, value: d.code }))])
const preview = computed(() => {
  const pv = item.value ? detail.value?.preview : undefined
  if (!pv) return undefined
  // 換了優免、新的試算還沒回來時不顯示舊金額（不能用的優免由服務層退回不含優免的試算，並給 discountError）
  const want = detail.value?.discountError ? undefined : discountCode.value || undefined
  return pv.discount?.code === want ? pv : undefined
})
const lastDiscount = computed(() => (item.value ? detail.value?.lastDiscount : undefined))
const receipt = computed(() => (item.value ? detail.value?.receipt : undefined))

// ---------- 結帳 ----------
const payMethod = ref<PayMethod>('cash')
const received = ref<number | undefined>()
const total = computed(() => preview.value?.patientTotal ?? 0)
// 實收不足時可勾「差額記為欠款」（只限現金）
const owe = ref(false)
const oweReason = ref('')
// 換病人時預設實收＝應收，欠款選項清掉
// 看「換了病人」也看「金額變了」：只看金額的話，應收 0 元（慢箋領藥）時 0 → 0 沒有變化，實收永遠是空的
watch([() => item.value?.id, total], ([, t]) => {
  received.value = t
  owe.value = false
  oweReason.value = ''
})
watch(payMethod, (m) => {
  if (m !== 'cash') owe.value = false
})

/** 現金快速鍵：剛好、湊整百、500、1000、2000（只列出 ≥ 應收的） */
const quickAmounts = computed(() => {
  const t = total.value
  return [...new Set([t, Math.ceil(t / 100) * 100, 500, 1000, 2000])].filter((n) => n >= t).sort((a, b) => a - b).slice(0, 5)
})
const change = computed(() => (payMethod.value === 'cash' ? (received.value ?? 0) - total.value : 0))
// 與服務層同一條規則：不足（沒勾欠款）、非整數、找零異常（多打了 0）都不能收款
const cashProblem = computed(() => (payMethod.value === 'cash' && preview.value ? checkCash(total.value, received.value, owe.value) : null))
const owedAmount = computed(() => (owe.value ? Math.max(0, total.value - (received.value ?? 0)) : 0))
const canPay = computed(() => !!preview.value && !cashProblem.value && (!owe.value || !!oweReason.value.trim()) && (!rule.value?.needsReason || !!discountReason.value.trim()))

const pay = useAction(chargeApi.pay, { success: (c) => `結帳完成：收據 ${c.receiptNo}` })
async function onPay() {
  if (!item.value || !canPay.value) return
  await pay.run(item.value.id, {
    payMethod: payMethod.value,
    received: payMethod.value === 'cash' ? received.value ?? 0 : total.value,
    owe: owe.value ? { reason: oweReason.value } : undefined,
    discount: discountCode.value ? { code: discountCode.value, reason: discountReason.value } : undefined,
  })
  // 結帳後清單經 dbVersion 自動刷新，右側會切換成收據
}

const methods: { key: PayMethod; label: string; icon: typeof Wallet }[] = [
  { key: 'cash', label: '現金', icon: Wallet },
  { key: 'card', label: '信用卡', icon: CreditCard },
  { key: 'mobile', label: '行動支付', icon: Smartphone },
]

const print = () => window.print()

// ---------- 之前的欠款：選到病人就列出，逐筆收回（可只收一部分） ----------
const debts = computed(() => (item.value ? detail.value?.debts ?? [] : []))
const repayTarget = ref<DebtItem>()
const repayAmount = ref<number | undefined>()
const repayMethod = ref<PayMethod>('cash')
const repayProblem = computed(() => (repayTarget.value ? checkRepay(repayTarget.value.outstanding, repayAmount.value) : null))
const repay = useAction(chargeApi.repayDebt, { success: (x) => `已收回欠款 ${x.amount} 元：收據 ${x.receiptNo}` })
function openRepay(d: DebtItem) {
  repayTarget.value = d
  repayAmount.value = d.outstanding
  repayMethod.value = 'cash'
}
async function onRepay() {
  if (!repayTarget.value || repayProblem.value) return
  if (await repay.run(repayTarget.value.chargeId, { payMethod: repayMethod.value, amount: repayAmount.value! })) repayTarget.value = undefined
}
const closeRepay = (open: boolean) => {
  if (!open) repayTarget.value = undefined
}

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

// ---------- 更正身分（只限待批價；已開收據的先作廢）。更正後試算經 dbVersion 自動重算 ----------
const identityOpen = ref(false)
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
        <div class="border-b border-slate-100 px-3 py-2"><UInput v-model="kw" placeholder="姓名、病歷號（Enter 選取）" aria-label="搜尋批價清單" @keydown.enter.prevent="onSearchEnter" /></div>
        <UQueryState :loading="listLoading" :ready="!!shown.length" :empty-title="kw.trim() ? `沒有符合「${kw.trim()}」的病人` : '沒有看診完成的病人'">
        <ul class="max-h-[calc(100vh-16rem)] divide-y divide-slate-100 overflow-y-auto">
          <li v-for="v in shown" :key="v.id">
            <button :class="['flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50', v.id === visitId && '!bg-brand-50']" @click="visitId = v.id">
              <span class="min-w-0 flex-1">
                <span class="block font-medium text-slate-800">{{ v.patientName }} <span class="tabular text-xs font-normal text-slate-500">{{ v.chartNo }}</span></span>
                <span class="block truncate text-xs text-slate-500">{{ v.refillOf ? `慢箋第 ${v.refillSeq} 次` : periodLabel[v.period] }}・{{ v.deptName }} {{ v.doctorName }}</span>
              </span>
              <span class="text-right">
                <UStatusBadge :map="visitStatus" :value="v.status" />
                <span v-if="v.charge" class="tabular block text-xs text-slate-500">${{ v.charge.patientTotal }}</span>
                <span v-else-if="v.estimate !== undefined" class="tabular block text-xs font-medium text-slate-700">約 ${{ v.estimate }}</span>
              </span>
            </button>
          </li>
        </ul>
        </UQueryState>
      </UCard>

      <!-- 右側 -->
      <UCard v-if="!visitId" data-detail class="no-print"><UEmpty title="請從清單選擇病人" description="待批價的病人排在最上方" /></UCard>
      <UCard v-else-if="!item" data-detail class="no-print"><UQueryState :loading="detailLoading" :ready="false" empty-title="找不到這筆就醫紀錄" /></UCard>
      <div v-else data-detail class="min-w-0 space-y-4">
        <PatientBanner :patient="item" show-debt class="no-print">
          <UBadge tone="blue">{{ item.identityName }}</UBadge>
          <button v-if="item.status === 'consulted'" type="button" class="text-xs text-brand-600 underline-offset-2 hover:underline" @click="identityOpen = true">更正身分</button>
          <UBadge>案件 {{ item.caseType }}</UBadge>
          <UBadge v-if="item.refillOf" tone="purple">慢箋第 {{ item.refillSeq }} 次領藥</UBadge>
        </PatientBanner>
        <!-- 之前的欠款：病人來批價（或專程來還錢）時，櫃台一眼看到、當場收回 -->
        <UCard v-if="debts.length" :padded="false" class="no-print border-amber-300">
          <template #title><span class="text-sm font-semibold text-amber-800">尚未還清的欠款 {{ debts.length }} 筆</span></template>
          <ul class="divide-y divide-slate-100 text-sm">
            <li v-for="d in debts" :key="d.chargeId" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
              <span class="tabular text-slate-500">{{ d.date.slice(5).replace('-', '/') }}</span>
              <span class="text-slate-700">{{ d.deptName }}</span>
              <span class="tabular text-xs text-slate-400">{{ d.receiptNo }}</span>
              <span class="min-w-0 flex-1 truncate text-xs text-slate-500">{{ d.oweReason }}<template v-if="d.repayments.length">・已收回 {{ d.repayments.length }} 次</template></span>
              <span class="tabular font-semibold text-amber-900">尚欠 ${{ d.outstanding.toLocaleString() }}</span>
              <UButton size="sm" variant="secondary" @click="openRepay(d)">收回</UButton>
            </li>
          </ul>
        </UCard>
        <IdentityCorrectDialog v-model="identityOpen" :visit-id="item.id" :identity-code="item.identityCode" :subject="`${item.patientName}・目前身分 ${item.identityName}`" />

        <!-- 待批價：試算 + 結帳 -->
        <div v-if="item.status === 'consulted'" class="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_20rem]">
          <UCard title="收費明細（試算）">
            <ChargeLinesTable v-if="preview" :lines="preview.lines" :patient-total="preview.patientTotal" :nhi-points="preview.nhiPoints" />
          </UCard>

          <UCard title="結帳" class="self-start">
            <div class="space-y-4">
              <!-- 優免：只減掛號費與自費項目，部分負擔依健保規定不能減 -->
              <div class="space-y-2">
                <USelect v-model="discountCode" label="優免" :options="discountOptions" :error="detail?.discountError ?? pay.fieldErrors.value.discount" />
                <button
                  v-if="lastDiscount && discountCode !== lastDiscount.code"
                  type="button"
                  class="text-xs text-brand-600 underline-offset-2 hover:underline"
                  @click="discountCode = lastDiscount.code"
                >上次使用：{{ lastDiscount.name }}（{{ lastDiscount.date.slice(5).replace('-', '/') }}），按此套用</button>
                <UInput v-if="rule?.needsReason" v-model="discountReason" label="優免原因" required placeholder="例：院長特准、社工轉介" :error="pay.fieldErrors.value.discountReason" />
                <p v-if="rule" class="text-xs text-slate-500">部分負擔依健保規定不能減免，優免只減掛號費與自費項目。</p>
              </div>
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
                <div v-if="owe" class="flex justify-between rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <span>記為欠款</span>
                  <span class="tabular text-lg font-bold">$ {{ owedAmount.toLocaleString() }}</span>
                </div>
                <div v-else :class="['flex justify-between rounded-md px-3 py-2 text-sm', change < 0 ? 'bg-red-50 text-red-700' : cashProblem ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800']">
                  <span>{{ change < 0 ? '尚差' : '找零' }}</span>
                  <span class="tabular text-lg font-bold">$ {{ Math.abs(change).toLocaleString() }}</span>
                </div>
                <!-- 錢不夠：差額記為欠款，下次來再收（要寫原因，日結看得到）。足額時不出現 -->
                <template v-if="change < 0 || owe">
                  <UCheckbox v-model="owe" label="差額記為欠款" />
                  <UInput v-if="owe" v-model="oweReason" label="欠款原因" placeholder="例：忘了帶錢、只帶部分現金" :error="pay.fieldErrors.value.oweReason" />
                </template>
              </template>
              <p v-else class="text-xs text-slate-500">刷卡與行動支付以應收金額扣款，無需找零。</p>

              <UButton block :disabled="!canPay" :loading="pay.pending.value" @click="onPay">確認收款</UButton>
            </div>
          </UCard>
        </div>

        <!-- 已批價：收據 -->
        <template v-else-if="receipt">
          <div class="no-print flex flex-wrap items-center gap-2">
            <UBadge v-if="item.status === 'dispensed'" tone="green">藥品已發出，無法作廢（本系統未提供退藥）</UBadge>
            <div class="ml-auto flex gap-2">
              <UButton variant="danger" :icon="Ban" :disabled="item.status === 'dispensed'" :title="item.status === 'dispensed' ? '已領藥，收據無法作廢' : ''" @click="openVoid">作廢</UButton>
              <UButton variant="secondary" :icon="Printer" @click="print">列印收據</UButton>
            </div>
          </div>
          <ReceiptCard :receipt="receipt" />
        </template>
      </div>
    </div>

    <UDialog :model-value="!!repayTarget" title="收回欠款" size="sm" @update:model-value="closeRepay">
      <div v-if="repayTarget" class="space-y-3 text-sm">
        <p class="text-slate-600">
          {{ repayTarget.date }} {{ repayTarget.deptName }}（收據 <span class="tabular">{{ repayTarget.receiptNo }}</span>）
          應收 {{ repayTarget.patientTotal }} 元，尚欠 <span class="tabular font-semibold text-amber-900">{{ repayTarget.outstanding }}</span> 元。
        </p>
        <div class="grid grid-cols-3 gap-2">
          <button
            v-for="m in methods"
            :key="m.key"
            type="button"
            :class="['flex flex-col items-center gap-1 rounded-md border py-2 text-xs', repayMethod === m.key ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50']"
            @click="repayMethod = m.key"
          >
            <component :is="m.icon" class="h-4 w-4" />{{ m.label }}
          </button>
        </div>
        <UInput v-model="repayAmount" label="收回金額" type="number" min="1" class="tabular text-right" :error="repayProblem ?? repay.fieldErrors.value.amount" hint="可只收一部分，其餘下次再收" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="repayTarget = undefined">取消</UButton>
        <UButton :disabled="!!repayProblem" :loading="repay.pending.value" @click="onRepay">確認收回</UButton>
      </template>
    </UDialog>

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
