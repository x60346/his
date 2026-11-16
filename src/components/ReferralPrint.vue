<script setup lang="ts">
// 轉診單（A4 列印）：病人、本院看診資料、病情摘要、診斷、用藥、檢驗檢查、過敏、轉診目的與建議院所科別、醫師。
// 診斷、用藥是開立當下的快照（ReferralOut），之後病歷改了，重印的內容也不變。
import type { ReferralOutView } from '@/services'
import { HOSPITAL } from '@/utils/hospital'
import { toRoc } from '@/utils/date'

defineProps<{ r: ReferralOutView }>()
</script>

<template>
  <div class="print-area">
    <article class="border-2 border-slate-800 p-6 text-sm leading-relaxed text-slate-900">
      <header class="border-b-2 border-slate-800 pb-2 text-center">
        <div class="text-lg font-bold">{{ HOSPITAL.name }}</div>
        <div class="text-2xl font-bold tracking-[0.5em]">轉診單</div>
        <div class="tabular mt-1 flex justify-between text-xs"><span>病歷號 {{ r.patient.chartNo }}</span><span>{{ r.no }}</span></div>
      </header>
      <p v-if="r.urgent" class="mt-2 inline-block border-2 border-red-700 px-2 text-base font-bold text-red-700">急件</p>
      <dl class="mt-3 grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1.5">
        <dt class="text-slate-600">姓名</dt><dd class="font-semibold">{{ r.patient.name }}</dd>
        <dt class="text-slate-600">性別</dt><dd>{{ r.patient.gender }}</dd>
        <dt class="text-slate-600">出生</dt><dd class="tabular">{{ toRoc(r.patient.birthDate) }}</dd>
        <dt class="text-slate-600">身分證號</dt><dd class="tabular">{{ r.patient.idNo }}</dd>
        <dt class="text-slate-600">就診科別</dt><dd>{{ r.deptName }}</dd>
        <dt class="text-slate-600">就診日期</dt><dd class="tabular">{{ toRoc(r.date) }}</dd>
        <dt class="text-slate-600">建議轉診</dt><dd class="col-span-3 font-semibold">{{ r.toHospital }} {{ r.toDept }}</dd>
        <dt class="text-slate-600">轉診目的</dt><dd class="col-span-3">{{ r.purpose }}</dd>
        <dt class="text-slate-600">過敏</dt><dd class="col-span-3">{{ r.patient.allergies.length ? r.patient.allergies.join('、') : '無已知過敏' }}</dd>
      </dl>
      <section class="mt-3">
        <div class="font-semibold">病情摘要</div>
        <p class="mt-1 min-h-[4rem] whitespace-pre-line border border-slate-400 px-3 py-2">{{ r.summary }}</p>
      </section>
      <section class="mt-3 grid grid-cols-2 gap-3">
        <div>
          <div class="font-semibold">診斷</div>
          <ul class="mt-1 min-h-[3rem] border border-slate-400 px-3 py-2"><li v-for="d in r.diagnoses" :key="d">{{ d }}</li></ul>
        </div>
        <div>
          <div class="font-semibold">檢驗檢查</div>
          <ul class="mt-1 min-h-[3rem] border border-slate-400 px-3 py-2"><li v-for="x in r.exams" :key="x">{{ x }}</li><li v-if="!r.exams.length" class="text-slate-500">無</li></ul>
        </div>
      </section>
      <section class="mt-3">
        <div class="font-semibold">目前用藥</div>
        <ul class="mt-1 min-h-[2.5rem] border border-slate-400 px-3 py-2"><li v-for="m in r.meds" :key="m">{{ m }}</li><li v-if="!r.meds.length" class="text-slate-500">無</li></ul>
      </section>
      <footer class="mt-6 flex items-end justify-between gap-4">
        <div class="text-sm">
          <div>轉診醫師：<b>{{ r.doctorName }}</b>（醫事人員代碼 <span class="tabular">{{ r.doctorLicenseNo }}</span>）</div>
          <div class="tabular">開單日期：{{ toRoc(r.issuedAt.slice(0, 10)) }}（90 天內有效）</div>
          <div class="text-xs text-slate-600">{{ HOSPITAL.name }}・{{ HOSPITAL.address }}・{{ HOSPITAL.phone }}</div>
        </div>
        <div class="flex items-end gap-2"><span class="text-xs text-slate-500">醫院印信</span><span class="inline-block h-20 w-20 border border-slate-500"></span></div>
      </footer>
    </article>
  </div>
</template>
