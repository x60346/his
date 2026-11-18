<script setup lang="ts">
// 給病人帶回家的「出院用藥清單」（A4 列印）：出院帶藥怎麼吃、家裡的藥哪些繼續吃、哪些停用不要再吃。
// 內容是存檔的出院病摘（出院帶藥、居家用藥的恢復／停用）——沒存檔的修改不會印出來
import type { DischargeMedList } from '@/services'
import { HOSPITAL } from '@/utils/hospital'
import { toRoc } from '@/utils/date'

defineProps<{ m: DischargeMedList }>()
</script>

<template>
  <div class="print-area">
    <article class="border-2 border-slate-800 p-6 text-sm leading-relaxed text-slate-900">
      <header class="border-b-2 border-slate-800 pb-2 text-center">
        <div class="text-lg font-bold">{{ HOSPITAL.name }}</div>
        <div class="text-2xl font-bold tracking-[0.3em]">出院用藥清單</div>
        <div class="tabular mt-1 flex justify-between text-xs"><span>{{ m.patientName }}・病歷號 {{ m.chartNo }}・住院號 {{ m.admitNo }}</span><span>出院 {{ toRoc(m.dischargedOn) }}</span></div>
      </header>
      <p class="mt-2">過敏：<b :class="m.allergies.length ? 'text-red-700' : ''">{{ m.allergies.join('、') || '無已知過敏' }}</b></p>

      <h3 class="mt-3 border-b border-slate-400 font-bold">一、醫院開的出院帶藥</h3>
      <p v-if="!m.meds.length" class="text-slate-600">沒有出院帶藥。</p>
      <table v-else class="mt-1 w-full">
        <thead><tr class="text-left text-xs text-slate-600"><th class="py-1">藥名</th><th>怎麼吃</th><th class="text-right">天數</th></tr></thead>
        <tbody>
          <tr v-for="(x, i) in m.meds" :key="i" class="border-t border-slate-200 align-top"><td class="py-1 pr-2"><b>{{ x.name }}</b><div class="text-xs text-slate-600">{{ x.nameZh }}</div></td><td class="pr-2">{{ x.how }}</td><td class="tabular text-right">{{ x.days }} 天</td></tr>
        </tbody>
      </table>

      <h3 class="mt-3 border-b border-slate-400 font-bold">二、家裡原本的藥：繼續吃</h3>
      <p v-if="!m.resume.length" class="text-slate-600">無。</p>
      <ul v-else class="mt-1 list-disc pl-5"><li v-for="(x, i) in m.resume" :key="i"><b>{{ x.name }}</b>　{{ x.how }}</li></ul>

      <h3 class="mt-3 border-b border-slate-400 font-bold text-red-800">三、家裡原本的藥：停用，不要再吃</h3>
      <p v-if="!m.stop.length" class="text-slate-600">無。</p>
      <ul v-else class="mt-1 list-disc pl-5"><li v-for="(x, i) in m.stop" :key="i"><b class="text-red-800">{{ x.name }}</b>　原因：{{ x.reason }}</li></ul>

      <p class="mt-4 text-xs text-slate-600">有任何不舒服或用藥疑問，請帶這張清單回診或撥打本院藥諮詢專線。醫師：{{ m.doctorName }}</p>
    </article>
  </div>
</template>
