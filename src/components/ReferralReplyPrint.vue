<script setup lang="ts">
// 轉診回覆單（A4 列印）：給轉出院所——對方的轉診資料、本院診斷、處置、建議、本院醫師。
import type { ReferralInView } from '@/services'
import { HOSPITAL } from '@/utils/hospital'
import { toRoc } from '@/utils/date'

defineProps<{ r: ReferralInView }>()
</script>

<template>
  <div class="print-area">
    <article v-if="r.referral.reply" class="border-2 border-slate-800 p-6 text-sm leading-relaxed text-slate-900">
      <header class="border-b-2 border-slate-800 pb-2 text-center">
        <div class="text-lg font-bold">{{ HOSPITAL.name }}</div>
        <div class="text-2xl font-bold tracking-[0.3em]">轉診回覆單</div>
        <div class="tabular mt-1 flex justify-between text-xs"><span>病歷號 {{ r.patient.chartNo }}</span><span>回覆：{{ r.referral.fromHospital }}</span></div>
      </header>
      <dl class="mt-3 grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1.5">
        <dt class="text-slate-600">姓名</dt><dd class="font-semibold">{{ r.patient.name }}</dd>
        <dt class="text-slate-600">性別</dt><dd>{{ r.patient.gender }}</dd>
        <dt class="text-slate-600">出生</dt><dd class="tabular">{{ toRoc(r.patient.birthDate) }}</dd>
        <dt class="text-slate-600">身分證號</dt><dd class="tabular">{{ r.patient.idNo }}</dd>
        <dt class="text-slate-600">轉出院所</dt><dd>{{ r.referral.fromHospital }}</dd>
        <dt class="text-slate-600">轉診單日期</dt><dd class="tabular">{{ toRoc(r.referral.issuedOn) }}</dd>
        <dt class="text-slate-600">轉診診斷</dt><dd class="col-span-3">{{ r.referral.diagnosis }}<template v-if="r.referral.purpose">（{{ r.referral.purpose }}）</template></dd>
        <dt class="text-slate-600">本院就診</dt><dd class="col-span-3 tabular">{{ toRoc(r.date) }} {{ r.deptName }}</dd>
      </dl>
      <section class="mt-3">
        <div class="font-semibold">本院診斷</div>
        <p class="mt-1 min-h-[3rem] whitespace-pre-line border border-slate-400 px-3 py-2">{{ r.referral.reply.diagnosis }}</p>
      </section>
      <section class="mt-3">
        <div class="font-semibold">處置與治療</div>
        <p class="mt-1 min-h-[3rem] whitespace-pre-line border border-slate-400 px-3 py-2">{{ r.referral.reply.treatment || '—' }}</p>
      </section>
      <section class="mt-3">
        <div class="font-semibold">建議</div>
        <p class="mt-1 min-h-[3rem] whitespace-pre-line border border-slate-400 px-3 py-2">{{ r.referral.reply.advice }}</p>
      </section>
      <footer class="mt-6 flex items-end justify-between gap-4">
        <div class="text-sm">
          <div>回覆醫師：<b>{{ r.doctorName }}</b>（醫事人員代碼 <span class="tabular">{{ r.doctorLicenseNo }}</span>）</div>
          <div class="tabular">回覆日期：{{ toRoc(r.referral.reply.at.slice(0, 10)) }}</div>
          <div class="text-xs text-slate-600">{{ HOSPITAL.name }}・{{ HOSPITAL.address }}・{{ HOSPITAL.phone }}</div>
        </div>
        <div class="flex items-end gap-2"><span class="text-xs text-slate-500">醫院印信</span><span class="inline-block h-20 w-20 border border-slate-500"></span></div>
      </footer>
    </article>
  </div>
</template>
