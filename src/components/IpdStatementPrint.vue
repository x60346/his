<script setup lang="ts">
// 住院費用明細表（截至列印時）：給病人、家屬看。依類別列出明細與小計、自付累計、期中已繳、還要繳多少。
// 還沒出院結帳時是試算——出院結帳時依實際住院天數、醫囑重新計算。櫃台（住院結帳）、護理站共用
import { computed } from 'vue'
import type { IpdStatement } from '@/services'
import { HOSPITAL } from '@/utils/hospital'
import { toRoc } from '@/utils/date'
import { payMethodLabel } from '@/utils/labels'
import { groupIpdLines, sumLines } from '@/utils/ipd-bill-groups'

const props = defineProps<{ s: IpdStatement }>()
const groups = computed(() => groupIpdLines(props.s.bill.lines))
const m = computed(() => props.s.bill.meta)
</script>

<template>
  <div class="print-area">
    <article class="p-2 text-sm text-slate-900">
      <header class="border-b-2 border-slate-800 pb-2 text-center">
        <div class="text-base font-bold">{{ HOSPITAL.name }}</div>
        <div class="text-xl font-bold tracking-[0.3em]">住院費用明細表</div>
        <div class="tabular mt-1 text-xs">{{ s.receiptNo ? `已出院結帳（收據 ${s.receiptNo}）` : `截至 ${toRoc(s.at.slice(0, 10))} ${s.at.slice(11)}（試算）` }}</div>
      </header>
      <dl class="tabular mt-2 grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1">
        <dt class="text-slate-600">姓名</dt><dd class="font-semibold">{{ s.admission.patientName }}</dd>
        <dt class="text-slate-600">病歷號</dt><dd>{{ s.admission.chartNo }}</dd>
        <dt class="text-slate-600">住院號</dt><dd>{{ s.admission.admitNo }}</dd>
        <dt class="text-slate-600">科別／床號</dt><dd>{{ s.admission.deptName }}・{{ s.admission.bed?.bedNo ?? '—' }}</dd>
        <dt class="text-slate-600">身分</dt><dd>{{ s.identityName }}</dd>
        <dt class="text-slate-600">住院期間</dt><dd>{{ toRoc(m.from) }} ～ {{ toRoc(m.to) }}，{{ m.days }} 天</dd>
      </dl>
      <table class="tabular mt-2 w-full text-xs">
        <thead class="border-y border-slate-400">
          <tr><th class="py-1 text-left font-medium">項目</th><th class="text-right font-medium">數量</th><th class="text-right font-medium">單價</th><th class="text-right font-medium">健保點數</th><th class="text-right font-medium">自付</th></tr>
        </thead>
        <tbody>
          <template v-for="g in groups" :key="g.label">
            <tr class="border-t border-slate-300 font-semibold"><td colspan="3" class="py-0.5">{{ g.label }}</td><td class="text-right">{{ g.lines.some((l) => !l.patientPay) ? sumLines(g.lines.filter((l) => !l.patientPay)).toLocaleString() : '' }}</td><td class="text-right">{{ g.lines.some((l) => l.patientPay) ? sumLines(g.lines.filter((l) => l.patientPay)).toLocaleString() : '' }}</td></tr>
            <tr v-for="(l, i) in g.lines" :key="i">
              <td class="pl-3">{{ l.name }}</td><td class="text-right">{{ l.qty }}</td><td class="text-right">{{ l.unitPrice.toLocaleString() }}</td>
              <td class="text-right">{{ l.patientPay ? '' : l.amount.toLocaleString() }}</td><td class="text-right">{{ l.patientPay ? l.amount.toLocaleString() : '' }}</td>
            </tr>
          </template>
        </tbody>
      </table>
      <p v-if="m.copay.length" class="mt-1 text-xs text-slate-600">部分負擔：{{ m.copay.map((c) => `第 ${c.fromDay}–${c.toDay} 天 ${c.rate}% ${c.amount.toLocaleString()} 元`).join('、') }}<template v-if="m.capped">（已達每次住院上限，減 {{ m.capped.toLocaleString() }} 元）</template></p>
      <div class="tabular ml-auto mt-3 w-72 space-y-1 border-t-2 border-slate-800 pt-2">
        <div class="flex justify-between"><span>健保申報</span><span>{{ s.bill.nhiPoints.toLocaleString() }} 點</span></div>
        <div class="flex justify-between font-semibold"><span>自付合計</span><span>{{ s.bill.patientTotal.toLocaleString() }} 元</span></div>
        <div v-for="p in s.payments" :key="p.receiptNo" class="flex justify-between text-xs text-slate-600"><span>期中繳款 {{ toRoc(p.at.slice(0, 10)) }}（{{ payMethodLabel[p.payMethod] }}・{{ p.receiptNo }}）</span><span>−{{ p.amount.toLocaleString() }}</span></div>
        <div v-if="s.refunded" class="flex justify-between text-xs text-slate-600"><span>已退還多繳</span><span>＋{{ s.refunded.toLocaleString() }}</span></div>
        <div v-if="!s.receiptNo" class="flex justify-between border-t border-slate-400 pt-1 text-base font-bold">
          <span>{{ s.stillDue >= 0 ? '目前還要繳' : '目前多繳（出院結帳時退還）' }}</span><span>{{ Math.abs(s.stillDue).toLocaleString() }} 元</span>
        </div>
      </div>
      <p v-if="!s.receiptNo" class="mt-3 text-xs text-slate-600">本表是截至列印時的試算，不是收據。出院結帳時依實際住院天數、用藥與檢查重新計算，期中繳款會全部扣抵，多繳的退還。</p>
    </article>
  </div>
</template>
