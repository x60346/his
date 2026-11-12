<script setup lang="ts">
// 藥袋標籤：每種藥一張。用法寫成病人看得懂的中文，高警訊藥品加註警語。
// 藥師法規定的藥袋欄位都要有：病人姓名、性別、藥名、劑量、數量、用法、作用或適應症、警語或副作用、
// 藥局名稱地址、調劑者姓名、調劑日期。作用與警語來自藥品主檔（主檔必填），調劑者由服務層決定。
import type { DispenseView } from '@/services/pharmacy'
import { HOSPITAL } from '@/utils/hospital'
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
    <!-- 列印時每張固定 1/4 A4（2×2）：藥袋要裁切，大小不能隨張數改變；break-inside-avoid 讓一張不會被切到兩頁 -->
    <article v-for="it in d.items" :key="it.drugId" class="break-inside-avoid rounded-md border-2 border-slate-800 p-3 text-sm text-slate-900 print:h-[134mm]">
      <header class="mb-2 border-b border-slate-300 pb-1">
        <div class="flex items-baseline justify-between">
          <span class="font-bold">{{ HOSPITAL.name }} {{ HOSPITAL.pharmacy }}</span>
          <span class="tabular text-xs">領藥號 {{ d.pickupNo }}</span>
        </div>
        <div class="text-[10px] text-slate-600">{{ HOSPITAL.address }}・電話 {{ HOSPITAL.phone }}</div>
      </header>
      <div class="flex justify-between gap-2">
        <span><b>{{ d.patientName }}</b>（{{ d.gender === 'M' ? '男' : '女' }}・{{ d.age }} 歲）<span class="text-xs">{{ d.chartNo }}</span></span>
        <span class="tabular whitespace-nowrap text-xs">調劑日 {{ toRoc(d.dispenseDate) }}</span>
      </div>
      <div class="mt-2 text-base font-bold">{{ it.drugName }}</div>
      <div class="text-xs text-slate-600">{{ it.spec }}</div>
      <div class="mt-2 rounded bg-slate-100 px-2 py-1.5 text-base">
        {{ routeName(it.route) }}・{{ it.freqLabel }}・每次 {{ it.dose }} {{ it.doseUnit }}
        <span v-if="timing(it.freq, it.route)" class="ml-1 font-bold">（{{ timing(it.freq, it.route) }}）</span>
      </div>
      <div class="tabular mt-1 text-xs">共 {{ it.days }} 天份，總量 {{ it.qty }} {{ it.unit }}</div>
      <div class="mt-2 text-sm"><b>作用：</b>{{ it.indication }}</div>
      <div class="mt-1 rounded border border-slate-400 px-2 py-1 text-xs leading-snug"><b>注意：</b>{{ it.warning }}</div>
      <div v-if="it.highAlert" class="mt-2 border-2 border-red-600 px-2 py-1 text-xs font-bold text-red-700">
        ⚠ 高警訊藥品：請嚴格依照醫囑劑量使用，如有不適立即回診
      </div>
      <footer class="mt-2 text-[10px] text-slate-600">
        處方醫師 {{ d.doctorName }}（{{ d.deptName }}）・調劑藥師 {{ d.pharmacistName || '＿＿＿＿' }}<br />
        如有疑問請洽{{ HOSPITAL.pharmacy }} {{ HOSPITAL.phone }}
      </footer>
    </article>
  </div>
</template>
