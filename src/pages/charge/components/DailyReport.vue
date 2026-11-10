<script setup lang="ts">
// 日結報表：櫃台下班前對帳用。數字全部來自服務層 dailyReport。
import { ref } from 'vue'
import { Ban, Coins, FileText, Printer, Stethoscope } from 'lucide-vue-next'
import { UButton, UCard, UInput, UStatCard, UTable, type Column } from '@/components/ui'
import { chargeApi } from '@/services'
import type { DailyReport } from '@/services/charge'
import { useQuery } from '@/composables/useService'
import { today } from '@/utils/date'
import { money, payMethodLabel } from '@/utils/labels'
import type { PayMethod } from '@/types'

const date = ref(today())
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
// 模板裡不能直接用 window（Vue 模板只開放少數全域物件），所以包成函式
const print = () => window.print()
</script>

<template>
  <!-- print-area：列印時只印報表本身（不含側邊選單） -->
  <div class="print-area space-y-4">
    <div class="flex items-end gap-3">
      <div class="w-44"><UInput v-model="date" label="報表日期" type="date" :max="today()" /></div>
      <UButton variant="secondary" :icon="Printer" class="no-print" @click="print">列印</UButton>
    </div>

    <template v-if="r">
      <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <UStatCard label="收入合計" :value="money(r.patientTotal)" :icon="Coins" tone="emerald" />
        <UStatCard label="有效收據" :value="r.count" hint="張" :icon="FileText" />
        <UStatCard label="作廢收據" :value="r.voidedCount" hint="張" :icon="Ban" :tone="r.voidedCount ? 'amber' : 'slate'" />
        <UStatCard label="健保申報" :value="r.nhiPoints.toLocaleString()" hint="點" :icon="Stethoscope" />
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
