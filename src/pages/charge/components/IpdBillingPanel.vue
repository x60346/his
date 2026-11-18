<script setup lang="ts">
// 住院結帳（櫃台）：左邊住院中的病人（醫師已簽准出院的在前，可結帳；其他可看試算）與今天出院的，
// 右邊帳單：依類別小計、住院天數與床位、部分負擔分段；收款（現金可記欠款）→ 收據。
// 金額由服務層算（ipd-charge、billing.calcIpdChargeLines），這裡只顯示與收款。結清後到住院中心或護理站辦出院。
// 住很久的可以先收期中繳款（出院結帳時扣抵，多繳的退還）；費用明細表可以印給家屬
import { computed, ref, watch } from 'vue'
import { BedDouble, CreditCard, Printer, Smartphone, Wallet } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UCheckbox, UDialog, UEmpty, UInput, UQueryState } from '@/components/ui'
import { checkCash, chargeApi, ipdChargeApi, type IpdInterimView, type IpdStatement } from '@/services'
import type { ChargeLine, PayMethod } from '@/types'
import { groupIpdLines, sumLines as sumOf } from '@/utils/ipd-bill-groups'
import IpdStatementPrint from '@/components/IpdStatementPrint.vue'
import IpdInterimReceipt from '@/components/IpdInterimReceipt.vue'
import { useAction, useQuery } from '@/composables/useService'
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { HOSPITAL } from '@/utils/hospital'
import CertificatePanel from '@/components/CertificatePanel.vue'
import { money, payMethodLabel } from '@/utils/labels'
import { toRoc } from '@/utils/date'

const { data: list, loading } = useQuery(() => ipdChargeApi.listIpdBilling())
const selId = ref<string>()
useRevealOnNarrow(selId)
const { data: v, loading: vLoading } = useQuery(async () => (selId.value ? ipdChargeApi.getIpdBill(selId.value) : undefined), [selId])
const view = computed(() => (v.value?.admission.id === selId.value ? v.value : undefined))

/** 帳單或收據的明細（同一個顯示） */
const lines = computed<ChargeLine[]>(() => view.value?.charge?.lines ?? view.value?.bill?.lines ?? [])
const meta = computed(() => view.value?.charge?.ipd ?? view.value?.bill?.meta)
const total = computed(() => view.value?.charge?.patientTotal ?? view.value?.bill?.patientTotal ?? 0)
const nhi = computed(() => view.value?.charge?.nhiPoints ?? view.value?.bill?.nhiPoints ?? 0)
const grouped = computed(() => groupIpdLines(lines.value))
/** 期中繳款扣抵（和服務層 payIpd 同一個算法）：本次應收＝總帳 − 扣抵；繳得比總帳多，差額出院結帳時退還 */
const available = computed(() => (view.value?.bill && view.value.interim.due !== undefined ? total.value - view.value.interim.due : 0))
const applied = computed(() => view.value?.charge?.prepaidApplied ?? Math.min(Math.max(0, available.value), total.value))
const payDue = computed(() => total.value - applied.value)
const excess = computed(() => (view.value?.charge ? 0 : Math.max(0, available.value - total.value)))

// ---------- 收款 ----------
const payMethod = ref<PayMethod>('cash')
const received = ref<number | undefined>()
const owe = ref(false)
const oweReason = ref('')
// 換病人、帳單載入時：實收先帶應付金額（和門診批價一樣，現金收多少再改）
watch(() => [selId.value, view.value?.bill?.patientTotal, payDue.value] as const, ([, , t]) => {
  payMethod.value = 'cash'
  received.value = t
  owe.value = false
  oweReason.value = ''
})
const methods = [
  { key: 'cash' as const, label: '現金', icon: Wallet },
  { key: 'card' as const, label: '信用卡', icon: CreditCard },
  { key: 'mobile' as const, label: '行動支付', icon: Smartphone },
]
const change = computed(() => (payMethod.value === 'cash' ? (received.value ?? 0) - payDue.value : 0))
const cashProblem = computed(() => (payMethod.value === 'cash' && view.value?.bill ? checkCash(payDue.value, received.value, owe.value) : null))
const canPay = computed(() => !!view.value?.bill && !view.value.blocked && !cashProblem.value && (!owe.value || !!oweReason.value.trim()))
const pay = useAction(ipdChargeApi.payIpd, { success: (c) => `已結帳 ${c.receiptNo}：${money(c.patientTotal)}${c.prepaidApplied ? `（扣抵期中繳款 ${money(c.prepaidApplied)}）` : ''}${excess.value ? `，退還多繳 ${money(excess.value)}` : ''}；請辦理出院` })
async function onPay() {
  if (!view.value) return
  await pay.run(view.value.admission.id, { payMethod: payMethod.value, received: payMethod.value === 'cash' ? received.value ?? 0 : payDue.value, owe: owe.value ? { reason: oweReason.value } : undefined })
}
// 作廢重結：結帳後又有新費用、或算錯（當天、出院前）
const voidOpen = ref(false)
const voidReason = ref('')
const voidIt = useAction(chargeApi.voidCharge, { success: '已作廢，請重新結帳' })
async function onVoid() {
  if (view.value?.charge && (await voidIt.run(view.value.charge.id, voidReason.value))) voidOpen.value = false
}
const print = () => window.print()

// ---------- 期中繳款 ----------
const iAmount = ref<number | undefined>()
const iMethod = ref<PayMethod>('cash')
watch(() => [selId.value, view.value?.interim.max] as const, ([, m]) => {
  iAmount.value = m || undefined
  iMethod.value = 'cash'
})
const payI = useAction(ipdChargeApi.payInterim, { success: (p) => `已收期中繳款 ${p.receiptNo}：${money(p.amount)}（出院結帳時扣抵）` })
const receipt = ref<IpdInterimView['payments'][number]>()
async function onPayInterim() {
  if (!view.value) return
  const p = await payI.run(view.value.admission.id, { amount: Number(iAmount.value), payMethod: iMethod.value })
  if (p) receipt.value = { ...p, cashierName: '' }
}
// 收完款後收據要顯示收費人員：清單重新載入後用服務層的那一筆
const receiptView = computed(() => (receipt.value ? view.value?.interim.payments.find((x) => x.id === receipt.value!.id) ?? receipt.value : undefined))
const ivOpen = ref<IpdInterimView['payments'][number]>()
const ivReason = ref('')
const voidI = useAction(ipdChargeApi.voidInterim, { success: '已作廢期中繳款' })
async function onVoidInterim() {
  if (view.value && ivOpen.value && (await voidI.run(view.value.admission.id, ivOpen.value.id, ivReason.value))) ivOpen.value = undefined
}
// 費用明細表（給家屬）
const statement = ref<IpdStatement>()
const loadStatement = useAction(ipdChargeApi.getIpdStatement)
async function openStatement() {
  if (view.value) statement.value = (await loadStatement.run(view.value.admission.id)) ?? undefined
}
</script>

<template>
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_1fr]">
    <UCard :padded="false" class="no-print self-start">
      <template #title><span class="flex items-center gap-2 text-sm font-semibold text-slate-800"><BedDouble class="h-4 w-4" />住院結帳</span></template>
      <UQueryState :loading="loading && !list" :ready="!!list?.length" empty-title="沒有住院中的病人">
        <ul class="max-h-[calc(100vh-14rem)] divide-y divide-slate-100 overflow-y-auto">
          <li v-for="x in list" :key="x.admissionId">
            <button :class="['flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-slate-50', x.admissionId === selId && '!bg-brand-50']" @click="selId = x.admissionId">
              <span class="min-w-0 flex-1">
                <span class="block font-medium text-slate-800">{{ x.patientName }} <span class="tabular text-xs font-normal text-slate-500">{{ x.chartNo }}</span></span>
                <span class="block text-xs text-slate-500">{{ x.bedNo }}・{{ x.deptName }}・住院第 {{ x.days }} 天<template v-if="x.interimPaid && !x.receiptNo">・期中已繳 {{ x.interimPaid.toLocaleString() }}</template></span>
              </span>
              <UBadge v-if="x.death && !x.receiptNo" tone="gray" :title="x.status === 'discharged' ? '已送太平間：家屬來結帳' : '送太平間後由家屬結帳'">{{ x.status === 'discharged' ? '死亡出院・待家屬結帳' : '已宣告死亡' }}</UBadge>
              <UBadge v-else-if="x.status === 'discharged'" tone="gray">已出院</UBadge>
              <UBadge v-else-if="x.receiptNo" tone="green">已結帳</UBadge>
              <UBadge v-else-if="x.dischargeReady" tone="yellow">准出院・待結帳</UBadge>
              <UBadge v-else-if="x.suggestInterim" tone="blue" :title="x.suggestInterim">建議期中繳款</UBadge>
            </button>
          </li>
        </ul>
      </UQueryState>
    </UCard>

    <UCard v-if="!selId" data-detail class="no-print"><UEmpty title="請從左邊選擇住院病人" description="醫師簽准出院後才能結帳；其他病人可以先看試算" /></UCard>
    <UCard v-else-if="!view" data-detail class="no-print"><UQueryState :loading="vLoading" :ready="false" empty-title="找不到住院紀錄" /></UCard>
    <div v-else data-detail class="min-w-0 space-y-3">
      <!-- 帳單（已結帳時是收據，可列印） -->
      <UCard :class="view.charge && !receiptView && 'print-area'">
        <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 pb-2">
          <div>
            <div class="text-xs text-slate-500">{{ HOSPITAL.name }}・{{ view.charge ? '住院費用收據' : '住院費用試算' }}</div>
            <div class="text-base font-semibold text-slate-800">{{ view.admission.patientName }} <span class="text-sm font-normal text-slate-500">{{ view.admission.chartNo }}・住院號 {{ view.admission.admitNo }}・{{ view.admission.deptName }}<template v-if="view.bill">・{{ view.bill.identityName }}</template></span></div>
          </div>
          <div v-if="view.charge" class="tabular text-right text-sm">收據 <b>{{ view.charge.receiptNo }}</b><div class="text-xs text-slate-500">{{ view.charge.paidAt }}・{{ view.charge.cashierName }}</div></div>
        </div>
        <p v-if="meta" class="mt-2 text-sm text-slate-700">
          住院期間 {{ toRoc(meta.from) }} ～ {{ toRoc(meta.to) }}，共 <b>{{ meta.days }}</b> 天（入院當天算、出院當天不算）
          <span class="text-xs text-slate-500">・{{ meta.beds.map((b) => `${b.bedNo} ${b.bedClass} ${b.days} 天`).join('、') }}</span>
        </p>
        <table class="tabular mt-2 w-full text-sm">
          <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500">
            <tr><th class="px-3 py-1.5 text-left font-medium">項目</th><th class="px-2 text-right font-medium">數量</th><th class="px-2 text-right font-medium">單價</th><th class="px-2 text-right font-medium">健保點數</th><th class="px-3 text-right font-medium">病人付</th></tr>
          </thead>
          <tbody>
            <template v-for="g in grouped" :key="g.label">
              <tr class="border-t border-slate-200 bg-slate-50/60"><td colspan="3" class="px-3 py-1 text-xs font-semibold text-slate-600">{{ g.label }}</td><td class="px-2 text-right text-xs text-slate-500">{{ g.lines.some((l) => !l.patientPay) ? sumOf(g.lines.filter((l) => !l.patientPay)).toLocaleString() : '' }}</td><td class="px-3 text-right text-xs text-slate-500">{{ g.lines.some((l) => l.patientPay) ? sumOf(g.lines.filter((l) => l.patientPay)).toLocaleString() : '' }}</td></tr>
              <tr v-for="(l, i) in g.lines" :key="i" class="border-t border-slate-100">
                <td class="px-3 py-1">{{ l.name }}</td>
                <td class="px-2 text-right">{{ l.qty }}</td>
                <td class="px-2 text-right">{{ l.unitPrice.toLocaleString() }}</td>
                <td class="px-2 text-right">{{ l.patientPay ? '' : l.amount.toLocaleString() }}</td>
                <td class="px-3 text-right">{{ l.patientPay ? l.amount.toLocaleString() : '' }}</td>
              </tr>
            </template>
          </tbody>
        </table>
        <!-- 部分負擔怎麼算：健保費用平均到每天，依住院第幾天分段 -->
        <p v-if="meta?.copay.length" class="mt-2 text-xs text-slate-600">
          部分負擔：{{ meta.copay.map((c) => `第 ${c.fromDay}–${c.toDay} 天 ${c.rate}% ${c.amount.toLocaleString()} 元`).join('、') }}
          <template v-if="meta.capped">；超過每次住院上限 {{ view.copay.cap.toLocaleString() }} 元，減 {{ meta.capped.toLocaleString() }} 元</template>
        </p>
        <p v-else-if="lines.length" class="mt-2 text-xs text-slate-500">此身分免部分負擔（或自費身分）。</p>
        <div class="mt-3 flex flex-wrap items-end justify-end gap-6 border-t border-slate-200 pt-2">
          <div class="text-right text-xs text-slate-500">健保申報 <span class="tabular font-medium text-slate-700">{{ nhi.toLocaleString() }}</span> 點</div>
          <div class="text-right">{{ applied ? '自付合計' : '病人應付' }} <span :class="['tabular font-bold text-slate-900', applied ? 'text-lg' : 'text-2xl']">{{ money(total) }}</span></div>
        </div>
        <div v-if="applied" class="tabular mt-1 flex flex-col items-end gap-0.5 text-sm">
          <span class="text-sky-800">扣抵期中繳款 −{{ applied.toLocaleString() }}</span>
          <span>{{ view.charge ? '本次實收' : view.blocked ? '目前還要繳' : '本次應收' }}<b class="text-2xl text-slate-900">{{ money(payDue) }}</b></span>
        </div>
        <p v-if="excess" class="mt-1 text-right text-sm text-sky-800">期中繳款比總費用多 {{ money(excess) }}：結帳時開退款單退還</p>
        <p v-if="view.charge" class="mt-1 text-right text-xs text-slate-500">
          {{ payMethodLabel[view.charge.payMethod] }} 實收 {{ money(view.charge.received) }}<template v-if="view.charge.change">・找零 {{ money(view.charge.change) }}</template>
          <template v-if="view.charge.outstanding">・<b class="text-amber-700">尚欠 {{ money(view.charge.outstanding) }}</b>（{{ view.charge.oweReason }}）</template>
        </p>
      </UCard>

      <!-- 期中繳款：住院中先收一部分（不收保證金：最多收到目前的費用），出院結帳扣抵 -->
      <UCard v-if="view.bill || view.interim.payments.length" class="no-print">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm font-semibold text-slate-700">期中繳款<span v-if="view.interim.held" class="tabular ml-2 font-normal text-slate-500">已繳 {{ money(view.interim.held) }}</span></h3>
          <UButton v-if="view.bill" size="sm" variant="secondary" :icon="Printer" :loading="loadStatement.pending.value" @click="openStatement">費用明細（給家屬）</UButton>
        </div>
        <p v-if="view.interim.suggest" class="mt-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900" role="status">{{ view.interim.suggest }}（提醒條件：{{ view.interim.settings.days ? `滿 ${view.interim.settings.days} 天` : '' }}{{ view.interim.settings.days && view.interim.settings.amount ? '或' : '' }}{{ view.interim.settings.amount ? `還沒繳的達 ${view.interim.settings.amount.toLocaleString()} 元` : '' }}）</p>
        <ul v-if="view.interim.payments.length" class="tabular mt-2 divide-y divide-slate-100 text-sm">
          <li v-for="p in view.interim.payments" :key="p.id" :class="['flex flex-wrap items-center gap-x-3 py-1.5', p.voided && 'text-slate-400 line-through']">
            <span>{{ p.at }}</span><span>{{ p.receiptNo }}</span><span>{{ payMethodLabel[p.payMethod] }}</span>
            <span class="text-xs text-slate-500">截至 {{ p.asOf.slice(5).replace('-', '/') }} 費用 {{ p.billTotal.toLocaleString() }}</span>
            <b class="ml-auto">{{ p.amount.toLocaleString() }}</b>
            <span class="flex gap-1 no-underline">
              <UButton size="sm" variant="ghost" :icon="Printer" @click="receipt = p">收據</UButton>
              <UButton v-if="!p.canVoid" size="sm" variant="ghost" @click="(ivOpen = p), (ivReason = '')">作廢</UButton>
            </span>
          </li>
          <li v-for="r in view.interim.refunds" :key="r.receiptNo" class="flex flex-wrap gap-x-3 py-1.5 text-red-700"><span>{{ r.at }}</span><span>{{ r.receiptNo }}</span><span>{{ r.reason }}</span><b class="ml-auto">−{{ r.amount.toLocaleString() }}</b></li>
        </ul>
        <p v-if="view.interim.blocked" class="mt-2 text-xs text-slate-500">{{ view.interim.blocked }}</p>
        <form v-else class="mt-2 flex flex-wrap items-end gap-2" @submit.prevent="onPayInterim">
          <div class="w-40"><UInput v-model="iAmount" type="number" min="1" :max="view.interim.max" label="本次繳款" :hint="`最多 ${view.interim.max.toLocaleString()}（到今天的費用 − 已繳）`" :error="payI.fieldErrors.value.amount" /></div>
          <div class="flex gap-1">
            <button v-for="m in methods" :key="m.key" type="button" :class="['rounded-md border px-2.5 py-1.5 text-xs', iMethod === m.key ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50']" @click="iMethod = m.key">{{ m.label }}</button>
          </div>
          <UButton type="submit" :disabled="!iAmount" :loading="payI.pending.value">收期中繳款</UButton>
        </form>
      </UCard>

      <!-- 收款 -->
      <UCard v-if="view.bill" class="no-print">
        <p v-if="view.blocked" class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">{{ view.blocked }}</p>
        <div v-else class="space-y-3">
          <p v-if="applied" class="text-sm text-slate-600">出院結帳：本次應收 <b class="tabular">{{ money(payDue) }}</b>（已扣抵期中繳款 {{ money(applied) }}）</p>
          <div class="grid grid-cols-3 gap-2">
            <button v-for="m in methods" :key="m.key" :class="['flex flex-col items-center gap-1 rounded-md border py-2 text-xs', payMethod === m.key ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50']" @click="payMethod = m.key">
              <component :is="m.icon" class="h-4 w-4" />{{ m.label }}
            </button>
          </div>
          <template v-if="payMethod === 'cash'">
            <UInput v-model="received" label="實收" type="number" min="0" class="tabular text-right text-lg" :error="(change >= 0 && cashProblem) || pay.fieldErrors.value.received" />
            <div :class="['flex justify-between rounded-md px-3 py-2 text-sm', owe ? 'bg-amber-50 text-amber-900' : change < 0 ? 'bg-red-50 text-red-700' : cashProblem ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800']">
              <span>{{ owe ? '記為欠款' : change < 0 ? '尚差' : '找零' }}</span>
              <span class="tabular text-lg font-bold">$ {{ (owe ? Math.max(0, payDue - (received ?? 0)) : Math.abs(change)).toLocaleString() }}</span>
            </div>
            <template v-if="change < 0 || owe">
              <UCheckbox v-model="owe" label="差額記為欠款" />
              <UInput v-if="owe" v-model="oweReason" label="欠款原因" placeholder="例：家屬下午補繳" :error="pay.fieldErrors.value.oweReason" />
            </template>
          </template>
          <p v-else class="text-xs text-slate-500">刷卡與行動支付以應收金額扣款。</p>
          <UButton block :disabled="!canPay" :loading="pay.pending.value" @click="onPay">確認收款</UButton>
        </div>
      </UCard>
      <div v-else-if="view.charge" class="no-print flex flex-wrap items-center justify-end gap-2">
        <span v-if="view.admission.status === 'admitted'" class="mr-auto text-sm text-emerald-700">已結帳：請到住院中心或護理站辦理出院</span>
        <UButton v-if="!view.charge.canVoid" variant="ghost" @click="(voidOpen = true), (voidReason = '')">作廢重結</UButton>
        <UButton variant="secondary" :icon="Printer" @click="print">列印收據</UButton>
      </div>
      <!-- 這次住院開的診斷證明書：結帳後櫃台在這裡印 -->
      <div class="no-print rounded-lg border border-slate-200 bg-white px-4 py-3"><CertificatePanel :admission-id="view.admission.id" /></div>
    </div>

    <UDialog :model-value="!!receiptView" title="期中繳款收據" size="md" @update:model-value="(v: boolean) => !v && (receipt = undefined)">
      <IpdInterimReceipt v-if="receiptView && view" :p="receiptView" :admission="view.admission" />
      <template #footer>
        <UButton variant="secondary" @click="receipt = undefined">關閉</UButton>
        <UButton :icon="Printer" @click="print">列印</UButton>
      </template>
    </UDialog>
    <UDialog :model-value="!!statement" title="住院費用明細表" size="lg" @update:model-value="(v: boolean) => !v && (statement = undefined)">
      <IpdStatementPrint v-if="statement" :s="statement" />
      <template #footer>
        <UButton variant="secondary" @click="statement = undefined">關閉</UButton>
        <UButton :icon="Printer" @click="print">列印</UButton>
      </template>
    </UDialog>
    <UDialog :model-value="!!ivOpen" title="作廢期中繳款" size="sm" @update:model-value="(v: boolean) => !v && (ivOpen = undefined)" @submit="onVoidInterim">
      <p class="text-sm text-slate-600">{{ ivOpen?.receiptNo }}・{{ ivOpen?.amount.toLocaleString() }} 元。只有當天收的、還沒出院結帳的可以作廢（不算進今天的日結）。</p>
      <UInput v-model="ivReason" label="作廢原因" required :error="voidI.fieldErrors.value.reason" />
      <template #footer>
        <UButton variant="secondary" @click="ivOpen = undefined">取消</UButton>
        <UButton type="submit" variant="danger" :disabled="!ivReason.trim()" :loading="voidI.pending.value">作廢</UButton>
      </template>
    </UDialog>
    <UDialog v-model="voidOpen" title="作廢住院收據" size="sm" @submit="onVoid">
      <p class="text-sm text-slate-600">作廢後重新結帳（例：結帳後又給了藥、算錯）。當天、出院前才能作廢。</p>
      <UInput v-model="voidReason" label="作廢原因" required />
      <template #footer>
        <UButton variant="secondary" @click="voidOpen = false">取消</UButton>
        <UButton type="submit" variant="danger" :disabled="!voidReason.trim()" :loading="voidIt.pending.value">作廢</UButton>
      </template>
    </UDialog>
  </div>
</template>
