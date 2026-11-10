<script setup lang="ts">
// 藥袋標籤：每種藥一張。用法寫成病人看得懂的中文，高警訊藥品加註警語。
import type { DispenseView } from '@/services/pharmacy'
import { masterApi } from '@/services'
import { toRoc } from '@/utils/date'

defineProps<{ d: DispenseView }>()

const routeName = (code: string) => masterApi.staticCodes.routes.find((r) => r.code === code)?.name ?? code
/** 口服藥常見的服用時機提示（展示用簡化規則） */
const timing = (freq: string, route: string) => {
  if (route !== 'PO') return ''
  // 頻率名稱本身已經說明時機（睡前、需要時、立即），不再重複
  if (['HS', 'PRN', 'STAT'].includes(freq)) return ''
  return '飯後服用'
}
</script>

<template>
  <div class="print-area grid grid-cols-1 gap-3 sm:grid-cols-2">
    <article v-for="it in d.items" :key="it.drugId" class="break-inside-avoid rounded-md border-2 border-slate-800 p-3 text-sm text-slate-900">
      <header class="mb-2 flex items-baseline justify-between border-b border-slate-300 pb-1">
        <span class="font-bold">HIS 展示醫院 藥袋</span>
        <span class="tabular text-xs">領藥號 {{ d.pickupNo }}</span>
      </header>
      <div class="flex justify-between">
        <span><b>{{ d.patientName }}</b>（{{ d.chartNo }}）</span>
        <span class="tabular text-xs">{{ toRoc(d.date) }}</span>
      </div>
      <div class="mt-2 text-base font-bold">{{ it.drugName }}</div>
      <div class="text-xs text-slate-600">{{ it.spec }}</div>
      <div class="mt-2 rounded bg-slate-100 px-2 py-1.5 text-base">
        {{ routeName(it.route) }}・{{ it.freqLabel }}・每次 {{ it.dose }} {{ it.doseUnit }}
        <span v-if="timing(it.freq, it.route)" class="ml-1 font-bold">（{{ timing(it.freq, it.route) }}）</span>
      </div>
      <div class="tabular mt-1 text-xs">共 {{ it.days }} 天份，總量 {{ it.qty }} {{ it.unit }}</div>
      <div v-if="it.highAlert" class="mt-2 border-2 border-red-600 px-2 py-1 text-xs font-bold text-red-700">
        ⚠ 高警訊藥品：請嚴格依照醫囑劑量使用，如有不適立即回診
      </div>
      <footer class="mt-2 text-[10px] text-slate-500">醫師 {{ d.doctorName }}・{{ d.deptName }}　如有疑問請洽藥局</footer>
    </article>
  </div>
</template>
