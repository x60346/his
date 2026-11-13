<script setup lang="ts">
// 日結報表：櫃台下班前對帳用；選一段期間就是月報表。數字全部來自服務層 dailyReport，
// 匯出的 CSV 由 dailyReportCsv 從同一份報表產生（畫面、列印、匯出三者數字一致）。
import { HOSPITAL } from '@/utils/hospital'
import { computed, nextTick, ref } from 'vue'
import { Ban, Coins, Download, FileText, Printer, Stethoscope } from 'lucide-vue-next'
import { UButton, UCard, UInput, UStatCard, UTable, type Column } from '@/components/ui'
import { chargeApi, dailyReportCsv, reportFileName } from '@/services'
import type { DailyReport } from '@/services/charge'
import { useQuery } from '@/composables/useService'
import { followToday } from '@/composables/useClock'
import { addDays, now, toRoc, today } from '@/utils/date'
import { useAuth } from '@/stores/auth'
import { money, payMethodLabel } from '@/utils/labels'
import type { PayMethod } from '@/types'

const from = ref(today())
const to = ref(today())
const todayStr = followToday(to) // 原本看今天的，跨日時自動換到新的一天
followToday(from)
// 使用者改起始日：單日報表（結束日＝原起始日）時結束日跟著移；改到結束日之後也跟著移。
// 只放在輸入框的事件裡，不用 watch——「本月」這類按鈕同時改起訖，watch 會誤以為是單日而把結束日拉回去
function setFrom(f: string | number | undefined) {
  const old = from.value
  from.value = String(f ?? '')
  if (to.value === old || to.value < from.value) to.value = from.value
}
// 期間對不對（起訖順序、最多幾天）由服務層判斷，錯誤顯示在日期旁
const { data: r, loading, error } = useQuery(() => chargeApi.dailyReport(from.value, to.value), [from, to])
const isRange = computed(() => !!r.value && r.value.date !== r.value.to)
const firstOfMonth = (d: string) => `${d.slice(0, 8)}01`
const presets = computed(() => {
  const lastMonthEnd = addDays(firstOfMonth(todayStr.value), -1)
  return [
    { label: '今天', from: todayStr.value, to: todayStr.value },
    { label: '本月', from: firstOfMonth(todayStr.value), to: todayStr.value },
    { label: '上月', from: firstOfMonth(lastMonthEnd), to: lastMonthEnd },
  ]
})
function usePreset(p: { from: string; to: string }) {
  from.value = p.from
  to.value = p.to
}

// 匯出：內容與檔名由服務層的純函式產生，頁面只負責觸發下載
function exportCsv() {
  if (!r.value) return
  const url = URL.createObjectURL(new Blob([dailyReportCsv(r.value)], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = reportFileName(r.value)
  a.click()
  URL.revokeObjectURL(url)
}

type Row = DailyReport['charges'][number]
const columns = computed<Column<Row>[]>(() => [
  { key: 'receiptNo', label: '收據號碼' },
  // 區間報表要看得出是哪一天
  { key: 'paidAt', label: '時間', format: (c) => (isRange.value ? `${c.paidAt.slice(5, 10).replace('-', '/')} ${c.paidAt.slice(11)}` : c.paidAt.slice(11)) },
  { key: 'chartNo', label: '病歷號' },
  { key: 'patientName', label: '姓名' },
  { key: 'deptName', label: '科別' },
  { key: 'payMethod', label: '付款', format: (c) => payMethodLabel[c.payMethod] },
  { key: 'patientTotal', label: '金額', align: 'right', format: (c) => c.patientTotal.toLocaleString() },
  { key: 'owed', label: '欠款', align: 'right', format: (c) => (c.owed ? c.owed.toLocaleString() : '') },
  { key: 'nhiPoints', label: '申報點數', align: 'right', format: (c) => c.nhiPoints.toLocaleString() },
])
const methods: PayMethod[] = ['cash', 'card', 'mobile']
const feeTypes = [
  { key: 'reg', label: '掛號費' },
  { key: 'basicCopay', label: '基本部分負擔' },
  { key: 'drugCopay', label: '藥品部分負擔' },
  { key: 'selfPay', label: '自費項目（含自費診察費）' },
  { key: 'discount', label: '優免減免' },
] as const
type RefundRow = DailyReport['refunds'][number]
const refundColumns = computed<Column<RefundRow>[]>(() => [
  { key: 'receiptNo', label: '退款單號' },
  { key: 'at', label: '時間', format: (x) => (isRange.value ? `${x.at.slice(5, 10).replace('-', '/')} ${x.at.slice(11)}` : x.at.slice(11)) },
  { key: 'chartNo', label: '病歷號' },
  { key: 'patientName', label: '姓名' },
  { key: 'originalReceiptNo', label: '原收據', format: (x) => `${x.originalReceiptNo}（${x.originalDate.slice(5).replace('-', '/')}）` },
  { key: 'payMethods', label: '退款方式' },
  { key: 'reason', label: '原因' },
  { key: 'cashierName', label: '經辦' },
  { key: 'amount', label: '金額', align: 'right', format: (x) => `−${x.amount.toLocaleString()}` },
])
type RepayRow = DailyReport['repayments'][number]
const repayColumns = computed<Column<RepayRow>[]>(() => [
  { key: 'receiptNo', label: '收據號碼' },
  { key: 'at', label: '時間', format: (x) => (isRange.value ? `${x.at.slice(5, 10).replace('-', '/')} ${x.at.slice(11)}` : x.at.slice(11)) },
  { key: 'chartNo', label: '病歷號' },
  { key: 'patientName', label: '姓名' },
  { key: 'originalReceiptNo', label: '原收據' },
  { key: 'payMethod', label: '付款', format: (x) => payMethodLabel[x.payMethod] },
  { key: 'cashierName', label: '收費人員' },
  { key: 'amount', label: '金額', align: 'right', format: (x) => x.amount.toLocaleString() },
])
// 有欠款或收回時，「實收」和「應收」不同，提示怎麼算出來的
const collectedHint = computed(() => {
  const x = r.value
  if (!x || (!x.newDebt && !x.repaid && !x.refunded)) return ''
  return `應收 ${money(x.patientTotal)}${x.newDebt ? ` − 新欠 ${money(x.newDebt)}` : ''}${x.repaid ? ` ＋ 收回 ${money(x.repaid)}` : ''}${x.refunded ? ` − 退款 ${money(x.refunded)}` : ''}`
})
const unpaidTotal = computed(() => (r.value?.unpaid ?? []).reduce((s, u) => s + u.estimate, 0))

// 列印表頭：報表名稱、日期、列印時間與列印人——日後對帳時才知道這張紙是誰、何時印的
// （同一天印兩次、數字不同時查得出原因）。列印時間在按下「列印」那一刻取值，不是頁面打開的時間。
const auth = useAuth()
const printedAt = ref('')
const print = async () => {
  printedAt.value = now()
  await nextTick() // 讓表頭先更新成這一刻的時間，再叫出列印視窗
  window.print() // 模板裡不能直接用 window（Vue 模板只開放少數全域物件），所以包成函式
}
</script>

<template>
  <!-- print-area：列印時只印報表本身（不含側邊選單） -->
  <div class="print-area space-y-4">
    <!-- 只在列印時出現的表頭（畫面上已有日期選擇器，不需要） -->
    <header class="hidden border-b-2 border-slate-800 pb-2 print:block">
      <h1 class="text-center text-lg font-bold">{{ HOSPITAL.name }}　門診{{ isRange ? '收費' : '日結' }}報表</h1>
      <div class="mt-1 flex justify-between text-xs">
        <span>報表{{ isRange ? '期間' : '日期' }}：{{ toRoc(from) }}<template v-if="isRange"> ～ {{ toRoc(to) }}</template></span>
        <span>列印：{{ printedAt ? toRoc(printedAt.slice(0, 10)) + printedAt.slice(10) : '' }}・{{ auth.user?.name }}</span>
      </div>
    </header>
    <div class="no-print flex flex-wrap items-end gap-3">
      <div class="w-44"><UInput :model-value="from" label="起始日期" type="date" :max="todayStr" @update:model-value="setFrom" /></div>
      <div class="w-44"><UInput v-model="to" label="結束日期" type="date" :max="todayStr" /></div>
      <div class="flex gap-1">
        <UButton v-for="p in presets" :key="p.label" size="sm" :variant="from === p.from && to === p.to ? 'primary' : 'ghost'" @click="usePreset(p)">{{ p.label }}</UButton>
      </div>
      <div class="ml-auto flex gap-2">
        <UButton variant="secondary" :icon="Printer" :disabled="!r || !!error" @click="print">列印</UButton>
        <UButton variant="secondary" :icon="Download" :disabled="!r || !!error" @click="exportCsv">匯出 CSV</UButton>
      </div>
    </div>
    <p v-if="error" class="no-print text-sm text-red-600" role="alert">{{ error }}</p>

    <template v-if="r && !error">
      <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <!-- 實收＝錢箱和刷卡機實際收到的；有記欠款或收回欠款時才和應收不同 -->
        <UStatCard label="實收合計" :value="money(r.collected)" :hint="collectedHint" :icon="Coins" tone="emerald" />
        <UStatCard label="有效收據" :value="r.count" hint="張" :icon="FileText" />
        <UStatCard label="作廢收據" :value="r.voidedCount" :hint="r.voidedCount ? `張・${money(r.voidedTotal)}` : '張'" :icon="Ban" :tone="r.voidedCount ? 'amber' : 'slate'" />
        <UStatCard label="健保申報" :value="r.nhiPoints.toLocaleString()" hint="點" :icon="Stethoscope" />
      </div>

      <!-- 看完診還沒批價：下班前對帳要先看這裡，漏收的人不會出現在收據裡。列印時一併印出 -->
      <UCard v-if="r.unpaid.length" :padded="false" class="border-amber-300">
        <template #title><span class="text-sm font-semibold text-amber-800">未收款：{{ r.unpaid.length }} 位・預估 {{ money(unpaidTotal) }}</span></template>
        <template #actions><span class="text-xs text-slate-500">看完診尚未批價</span></template>
        <ul class="tabular divide-y divide-slate-100 text-sm">
          <li v-for="u in r.unpaid" :key="u.visitId" class="flex gap-3 px-4 py-1.5">
            <span v-if="isRange" class="tabular w-12 text-slate-500">{{ u.date.slice(5).replace('-', '/') }}</span>
            <span class="w-16 text-slate-500">{{ u.chartNo }}</span>
            <span class="w-20 font-medium text-slate-800">{{ u.patientName }}</span>
            <span class="flex-1 text-slate-600">{{ u.deptName }} {{ u.doctorName }}</span>
            <span class="text-right font-medium">{{ money(u.estimate) }}</span>
          </li>
        </ul>
      </UCard>
      <p v-else class="text-sm text-emerald-700">{{ isRange ? '期間內' : '當日' }}看完診的病人都已批價。</p>

      <!-- 區間報表：每天一列（沒收費的日子也列出 0，看得出哪天沒開或漏結）；加總 = 上面的合計 -->
      <UCard v-if="isRange" title="依日期" :padded="false">
        <table class="tabular w-full text-sm">
          <thead class="bg-slate-50 text-xs text-slate-500">
            <tr><th class="px-4 py-2 text-left">日期</th><th class="px-4 py-2 text-right">收據</th><th class="px-4 py-2 text-right">應收</th><th class="px-4 py-2 text-right">新欠</th><th class="px-4 py-2 text-right">收回</th><th class="px-4 py-2 text-right">退款</th><th class="px-4 py-2 text-right">實收</th></tr>
          </thead>
          <tbody>
            <tr v-for="d in r.byDay" :key="d.date" :class="['border-t border-slate-100', !d.count && !d.repaid && !d.refunded && 'text-slate-400']">
              <td class="px-4 py-1.5">{{ d.date.slice(5).replace('-', '/') }}</td>
              <td class="px-4 py-1.5 text-right">{{ d.count }}</td>
              <td class="px-4 py-1.5 text-right">{{ d.patientTotal.toLocaleString() }}</td>
              <td class="px-4 py-1.5 text-right">{{ d.newDebt ? d.newDebt.toLocaleString() : '' }}</td>
              <td class="px-4 py-1.5 text-right">{{ d.repaid ? d.repaid.toLocaleString() : '' }}</td>
              <td class="px-4 py-1.5 text-right">{{ d.refunded ? `−${d.refunded.toLocaleString()}` : '' }}</td>
              <td class="px-4 py-1.5 text-right font-medium">{{ d.collected.toLocaleString() }}</td>
            </tr>
            <tr class="border-t-2 border-slate-300 font-semibold">
              <td class="px-4 py-1.5">合計</td>
              <td class="px-4 py-1.5 text-right">{{ r.count }}</td>
              <td class="px-4 py-1.5 text-right">{{ r.patientTotal.toLocaleString() }}</td>
              <td class="px-4 py-1.5 text-right">{{ r.newDebt ? r.newDebt.toLocaleString() : '' }}</td>
              <td class="px-4 py-1.5 text-right">{{ r.repaid ? r.repaid.toLocaleString() : '' }}</td>
              <td class="px-4 py-1.5 text-right">{{ r.refunded ? `−${r.refunded.toLocaleString()}` : '' }}</td>
              <td class="px-4 py-1.5 text-right">{{ r.collected.toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
      </UCard>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <UCard title="依費用類別" subtitle="取自收據當時的明細">
          <ul class="tabular space-y-2 text-sm">
            <li v-for="f in feeTypes" :key="f.key" class="flex justify-between border-b border-slate-100 pb-1.5">
              <span class="text-slate-600">{{ f.label }}</span>
              <span class="font-medium text-slate-800">{{ r.byFeeType[f.key] < 0 ? `−${money(-r.byFeeType[f.key])}` : money(r.byFeeType[f.key]) }}</span>
            </li>
            <li class="flex justify-between font-semibold"><span>應收合計</span><span>{{ money(r.patientTotal) }}</span></li>
          </ul>
          <!-- 優免依類別：誰被減了多少，月底對帳、稽核用 -->
          <div v-if="r.discounts.length" class="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm">
            <div class="mb-1 text-xs font-medium text-emerald-800">優免明細（合計 {{ money(r.discountTotal) }}）</div>
            <div v-for="d in r.discounts" :key="d.name" class="tabular flex justify-between text-emerald-900">
              <span>{{ d.name }}<span class="ml-1 text-xs text-emerald-700">{{ d.count }} 筆</span></span><span>{{ money(d.amount) }}</span>
            </div>
          </div>
        </UCard>
        <UCard title="依收費人員" subtitle="交班時各自核對錢箱（實際收到的錢）">
          <ul class="tabular space-y-2 text-sm">
            <li v-for="c in r.byCashier" :key="c.cashierName" class="flex justify-between border-b border-slate-100 pb-1.5">
              <span class="text-slate-600">{{ c.cashierName }}<span class="ml-1 text-xs text-slate-400">{{ c.count }} 張{{ c.repayCount ? `・收回 ${c.repayCount} 筆` : '' }}{{ c.refundCount ? `・退款 ${c.refundCount} 筆` : '' }}</span></span>
              <span class="font-medium text-slate-800">{{ money(c.collected) }}</span>
            </li>
            <li v-if="!r.byCashier.length" class="py-2 text-center text-slate-400">當日沒有收費</li>
            <li class="flex justify-between font-semibold"><span>實收合計</span><span>{{ money(r.collected) }}</span></li>
          </ul>
        </UCard>
      </div>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <UCard title="依付款方式" subtitle="實際收到的錢">
          <ul class="tabular space-y-2 text-sm">
            <li v-for="m in methods" :key="m" class="flex justify-between border-b border-slate-100 pb-1.5">
              <span class="text-slate-600">{{ payMethodLabel[m] }}</span>
              <span class="font-medium text-slate-800">{{ money(r.byPayMethod[m]) }}</span>
            </li>
            <li class="flex justify-between font-semibold"><span>實收合計</span><span>{{ money(r.collected) }}</span></li>
          </ul>
        </UCard>
        <UCard title="依科別" :padded="false">
          <table class="tabular w-full text-sm">
            <thead class="bg-slate-50 text-xs text-slate-500">
              <tr><th class="px-4 py-2 text-left">科別</th><th class="px-4 py-2 text-right">人次</th><th class="px-4 py-2 text-right">收入</th><th class="px-4 py-2 text-right">點數</th></tr>
            </thead>
            <tbody>
              <tr v-for="d in r.byDept" :key="d.deptName" class="border-t border-slate-100">
                <td class="px-4 py-1.5">{{ d.deptName }}</td>
                <td class="px-4 py-1.5 text-right">{{ d.count }}</td>
                <td class="px-4 py-1.5 text-right">{{ d.patientTotal.toLocaleString() }}</td>
                <td class="px-4 py-1.5 text-right">{{ d.nhiPoints.toLocaleString() }}</td>
              </tr>
              <tr v-if="!r.byDept.length"><td colspan="4" class="px-4 py-6 text-center text-slate-400">當日沒有收費</td></tr>
            </tbody>
          </table>
        </UCard>
      </div>

      <UCard title="收據明細" subtitle="作廢的收據以刪除線標示、不計入合計；已退費的照算在這天（退款算在退款那天），以紅字標示" :padded="false">
        <UTable :columns="columns" :rows="r.charges" :row-key="(c) => c.id" :loading="loading" dense empty-text="當日沒有收據" :row-class="(c) => (c.refund ? 'text-red-700' : c.voided ? 'text-slate-400 line-through' : '')" />
      </UCard>

      <UCard v-if="r.refunds.length" title="退款" :subtitle="`${r.refunds.length} 筆・−${money(r.refunded)}（原收據可能是之前的日子，退款算在退款這天）`" :padded="false">
        <UTable :columns="refundColumns" :rows="r.refunds" :row-key="(x) => x.receiptNo" dense />
      </UCard>

      <UCard v-if="r.repayments.length" title="收回欠款" :subtitle="`${r.repayments.length} 筆・${money(r.repaid)}（原本欠在之前的收據，錢算在收回那天）`" :padded="false">
        <UTable :columns="repayColumns" :rows="r.repayments" :row-key="(x) => x.receiptNo" dense />
      </UCard>
    </template>
  </div>
</template>
