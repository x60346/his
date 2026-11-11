<script setup lang="ts">
// 日結報表：櫃台下班前對帳用。數字全部來自服務層 dailyReport。
import { computed, nextTick, ref } from 'vue'
import { Ban, Coins, FileText, Printer, Stethoscope } from 'lucide-vue-next'
import { UButton, UCard, UInput, UStatCard, UTable, type Column } from '@/components/ui'
import { chargeApi } from '@/services'
import type { DailyReport } from '@/services/charge'
import { useQuery } from '@/composables/useService'
import { followToday } from '@/composables/useClock'
import { now, toRoc, today } from '@/utils/date'
import { useAuth } from '@/stores/auth'
import { money, payMethodLabel } from '@/utils/labels'
import type { PayMethod } from '@/types'

const date = ref(today())
const todayStr = followToday(date) // 原本看今天的，跨日時自動換到新的一天
const { data: r, loading } = useQuery(() => chargeApi.dailyReport(date.value), [date])

type Row = DailyReport['charges'][number]
const columns: Column<Row>[] = [
  { key: 'receiptNo', label: '收據號碼' },
  { key: 'paidAt', label: '時間', format: (c) => c.paidAt.slice(11) },
  { key: 'chartNo', label: '病歷號' },
  { key: 'patientName', label: '姓名' },
  { key: 'deptName', label: '科別' },
  { key: 'payMethod', label: '付款', format: (c) => payMethodLabel[c.payMethod] },
  { key: 'patientTotal', label: '金額', align: 'right', format: (c) => c.patientTotal.toLocaleString() },
  { key: 'nhiPoints', label: '申報點數', align: 'right', format: (c) => c.nhiPoints.toLocaleString() },
]
const methods: PayMethod[] = ['cash', 'card', 'mobile']
const feeTypes = [
  { key: 'reg', label: '掛號費' },
  { key: 'basicCopay', label: '基本部分負擔' },
  { key: 'drugCopay', label: '藥品部分負擔' },
  { key: 'selfPay', label: '自費項目（含自費診察費）' },
] as const
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
      <h1 class="text-center text-lg font-bold">HIS 展示醫院　門診日結報表</h1>
      <div class="mt-1 flex justify-between text-xs">
        <span>報表日期：{{ toRoc(date) }}</span>
        <span>列印：{{ printedAt ? toRoc(printedAt.slice(0, 10)) + printedAt.slice(10) : '' }}・{{ auth.user?.name }}</span>
      </div>
    </header>
    <div class="no-print flex items-end gap-3">
      <div class="w-44"><UInput v-model="date" label="報表日期" type="date" :max="todayStr" /></div>
      <UButton variant="secondary" :icon="Printer" @click="print">列印</UButton>
    </div>

    <template v-if="r">
      <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <UStatCard label="收入合計" :value="money(r.patientTotal)" :icon="Coins" tone="emerald" />
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
            <span class="w-16 text-slate-500">{{ u.chartNo }}</span>
            <span class="w-20 font-medium text-slate-800">{{ u.patientName }}</span>
            <span class="flex-1 text-slate-600">{{ u.deptName }} {{ u.doctorName }}</span>
            <span class="text-right font-medium">{{ money(u.estimate) }}</span>
          </li>
        </ul>
      </UCard>
      <p v-else class="text-sm text-emerald-700">當日看完診的病人都已批價。</p>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <UCard title="依費用類別" subtitle="取自收據當時的明細">
          <ul class="tabular space-y-2 text-sm">
            <li v-for="f in feeTypes" :key="f.key" class="flex justify-between border-b border-slate-100 pb-1.5">
              <span class="text-slate-600">{{ f.label }}</span>
              <span class="font-medium text-slate-800">{{ money(r.byFeeType[f.key]) }}</span>
            </li>
            <li class="flex justify-between font-semibold"><span>合計</span><span>{{ money(r.patientTotal) }}</span></li>
          </ul>
        </UCard>
        <UCard title="依收費人員" subtitle="交班時各自核對錢箱">
          <ul class="tabular space-y-2 text-sm">
            <li v-for="c in r.byCashier" :key="c.cashierName" class="flex justify-between border-b border-slate-100 pb-1.5">
              <span class="text-slate-600">{{ c.cashierName }}<span class="ml-1 text-xs text-slate-400">{{ c.count }} 張</span></span>
              <span class="font-medium text-slate-800">{{ money(c.patientTotal) }}</span>
            </li>
            <li v-if="!r.byCashier.length" class="py-2 text-center text-slate-400">當日沒有收費</li>
            <li class="flex justify-between font-semibold"><span>合計</span><span>{{ money(r.patientTotal) }}</span></li>
          </ul>
        </UCard>
      </div>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <UCard title="依付款方式">
          <ul class="tabular space-y-2 text-sm">
            <li v-for="m in methods" :key="m" class="flex justify-between border-b border-slate-100 pb-1.5">
              <span class="text-slate-600">{{ payMethodLabel[m] }}</span>
              <span class="font-medium text-slate-800">{{ money(r.byPayMethod[m]) }}</span>
            </li>
            <li class="flex justify-between font-semibold"><span>合計</span><span>{{ money(r.patientTotal) }}</span></li>
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

      <UCard title="收據明細" subtitle="作廢的收據以刪除線標示，不計入合計" :padded="false">
        <UTable :columns="columns" :rows="r.charges" :row-key="(c) => c.id" :loading="loading" dense empty-text="當日沒有收據" :row-class="(c) => (c.voided ? 'text-slate-400 line-through' : '')" />
      </UCard>
    </template>
  </div>
</template>
