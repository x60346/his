<script setup lang="ts">
// 收費明細：每一行分成「病人自付（元）」與「健保申報（點）」兩欄，櫃台一眼看出病人要付多少。
// 金額全部來自服務層的計算結果，這裡只負責顯示。
import type { ChargeLine } from '@/types'

defineProps<{ lines: ChargeLine[]; patientTotal: number; nhiPoints: number; compact?: boolean }>()

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1))
const isCopay = (l: ChargeLine) => l.kind === 'copay-basic' || l.kind === 'copay-drug'
</script>

<template>
  <table :class="['w-full', compact ? 'text-xs' : 'text-sm']">
    <thead>
      <tr class="border-b border-slate-200 text-xs text-slate-500">
        <th class="py-1.5 text-left font-medium">項目</th>
        <th class="py-1.5 text-right font-medium">數量</th>
        <th class="py-1.5 text-right font-medium">單價</th>
        <th class="py-1.5 text-right font-medium">自付（元）</th>
        <th class="py-1.5 text-right font-medium">健保（點）</th>
      </tr>
    </thead>
    <tbody class="tabular">
      <tr v-for="(l, i) in lines" :key="i" :class="['border-b border-slate-100', isCopay(l) && 'bg-amber-50/50', l.kind === 'discount' && 'bg-emerald-50/60 text-emerald-800']">
        <td class="py-1.5 text-slate-800">{{ l.name }}</td>
        <td class="py-1.5 text-right text-slate-600">{{ fmt(l.qty) }}</td>
        <td class="py-1.5 text-right text-slate-600">{{ fmt(l.unitPrice) }}</td>
        <td class="py-1.5 text-right font-medium text-slate-800">{{ l.patientPay ? fmt(l.amount) : '' }}</td>
        <td class="py-1.5 text-right text-slate-600">{{ l.patientPay ? '' : fmt(l.amount) }}</td>
      </tr>
    </tbody>
    <tfoot class="tabular">
      <tr class="border-t-2 border-slate-300">
        <td colspan="3" class="pt-2 text-right text-slate-600">合計</td>
        <td class="pt-2 text-right text-lg font-bold text-slate-900">{{ patientTotal.toLocaleString() }}</td>
        <td class="pt-2 text-right font-medium text-slate-700">{{ nhiPoints.toLocaleString() }}</td>
      </tr>
      <tr>
        <td colspan="5" class="pt-1 text-right text-xs text-slate-400">申報點數＝健保項目合計－部分負擔</td>
      </tr>
    </tfoot>
  </table>
</template>
