<script setup lang="ts">
// 收據：畫面顯示與列印共用。外層加上 print-area，列印時只印這一塊（見 style.css 的 @media print）。
import { HOSPITAL } from '@/utils/hospital'
import { computed } from 'vue'
import type { ReceiptView } from '@/services/charge'
import { toRoc } from '@/utils/date'
import { payMethodLabel } from '@/utils/labels'
import ChargeLinesTable from './ChargeLinesTable.vue'

const props = defineProps<{ receipt: ReceiptView }>()
const repaidTotal = computed(() => (props.receipt.repayments ?? []).reduce((s, x) => s + x.amount, 0))
</script>

<template>
  <div class="print-area relative mx-auto max-w-xl rounded-md border border-slate-300 bg-white p-6 text-slate-800">
    <div v-if="receipt.voided" class="pointer-events-none absolute inset-0 flex items-center justify-center">
      <span class="rotate-[-18deg] rounded border-4 border-red-500 px-4 py-1 text-4xl font-bold text-red-500/70">作廢</span>
    </div>
    <header class="mb-4 border-b border-dashed border-slate-300 pb-3 text-center">
      <div class="text-lg font-bold">{{ HOSPITAL.name }}　門診收據</div>
      <div class="text-xs text-slate-500">本收據為展示用途，非正式收據</div>
    </header>

    <dl class="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <div><dt class="inline text-slate-500">收據號碼：</dt><dd class="tabular inline font-medium">{{ receipt.receiptNo }}</dd></div>
      <div><dt class="inline text-slate-500">就醫日期：</dt><dd class="inline">{{ toRoc(receipt.visit.date) }}</dd></div>
      <div><dt class="inline text-slate-500">姓名：</dt><dd class="inline">{{ receipt.visit.patientName }}</dd></div>
      <div><dt class="inline text-slate-500">病歷號：</dt><dd class="tabular inline">{{ receipt.visit.chartNo }}</dd></div>
      <div><dt class="inline text-slate-500">科別：</dt><dd class="inline">{{ receipt.visit.deptName }}・{{ receipt.visit.doctorName }}</dd></div>
      <div><dt class="inline text-slate-500">身分：</dt><dd class="inline">{{ receipt.visit.identityName }}（{{ receipt.visit.caseType }}）</dd></div>
    </dl>

    <ChargeLinesTable :lines="receipt.lines" :patient-total="receipt.patientTotal" :nhi-points="receipt.nhiPoints" compact />

    <div class="mt-4 grid grid-cols-3 gap-2 rounded bg-slate-50 p-3 text-center text-sm">
      <div><div class="text-xs text-slate-500">付款方式</div><div class="font-medium">{{ payMethodLabel[receipt.payMethod] }}</div></div>
      <div><div class="text-xs text-slate-500">實收</div><div class="tabular font-medium">{{ receipt.received.toLocaleString() }}</div></div>
      <div><div class="text-xs text-slate-500">找零</div><div class="tabular font-medium">{{ receipt.change.toLocaleString() }}</div></div>
    </div>

    <!-- 記欠款的收據：印出欠多少，病人帶回去也知道下次要補多少 -->
    <div v-if="receipt.owed" class="mt-2 flex justify-between rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <span>欠款（{{ receipt.oweReason }}）</span>
      <span class="tabular font-semibold">{{ receipt.owed.toLocaleString() }}<template v-if="repaidTotal">・已收回 {{ repaidTotal.toLocaleString() }}</template></span>
    </div>

    <div v-if="receipt.pickupNo" class="mt-4 rounded border-2 border-brand-500 p-3 text-center">
      <div class="text-xs text-brand-700">請至門診藥局領藥・領藥號</div>
      <div class="tabular text-3xl font-bold text-brand-700">{{ receipt.pickupNo }}</div>
    </div>

    <footer class="mt-4 flex justify-between border-t border-dashed border-slate-300 pt-2 text-xs text-slate-500">
      <span>收費人員：{{ receipt.cashierName }}</span>
      <span class="tabular">{{ toRoc(receipt.paidAt) }}</span>
    </footer>
  </div>
</template>
