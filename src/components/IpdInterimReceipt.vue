<script setup lang="ts">
// 期中繳款收據：截至哪天的住院費用、之前已繳、本次繳款。出院結帳時扣抵
import type { AdmissionView, IpdInterimView } from '@/services'
import { HOSPITAL } from '@/utils/hospital'
import { toRoc } from '@/utils/date'
import { payMethodLabel } from '@/utils/labels'

defineProps<{ p: IpdInterimView['payments'][number]; admission: AdmissionView }>()
</script>

<template>
  <div class="print-area">
    <article class="tabular p-2 text-sm text-slate-900">
      <header class="border-b-2 border-slate-800 pb-2 text-center">
        <div class="text-base font-bold">{{ HOSPITAL.name }}</div>
        <div class="text-xl font-bold tracking-[0.3em]">住院期中繳款收據</div>
        <div class="mt-1 flex justify-between text-xs"><span>收據 {{ p.receiptNo }}</span><span>{{ p.at }}・{{ p.cashierName }}</span></div>
      </header>
      <dl class="mt-2 grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1">
        <dt class="text-slate-600">姓名</dt><dd class="font-semibold">{{ admission.patientName }}</dd>
        <dt class="text-slate-600">病歷號</dt><dd>{{ admission.chartNo }}</dd>
        <dt class="text-slate-600">住院號</dt><dd>{{ admission.admitNo }}</dd>
        <dt class="text-slate-600">科別</dt><dd>{{ admission.deptName }}</dd>
      </dl>
      <div class="ml-auto mt-3 w-72 space-y-1 border-t border-slate-400 pt-2">
        <div class="flex justify-between"><span>截至 {{ toRoc(p.asOf) }} 住院自付費用</span><span>{{ p.billTotal.toLocaleString() }} 元</span></div>
        <div class="flex justify-between"><span>之前已繳</span><span>{{ p.paidBefore.toLocaleString() }} 元</span></div>
        <div class="flex justify-between border-t-2 border-slate-800 pt-1 text-base font-bold"><span>本次繳款（{{ payMethodLabel[p.payMethod] }}）</span><span>{{ p.amount.toLocaleString() }} 元</span></div>
      </div>
      <p v-if="p.voided" class="mt-2 font-bold text-red-700">已作廢：{{ p.voided.reason }}</p>
      <p class="mt-3 text-xs text-slate-600">期中繳款不是結帳：出院時依整段住院重新計算，已繳的全部扣抵，多繳的退還。請保留本收據。</p>
    </article>
  </div>
</template>
