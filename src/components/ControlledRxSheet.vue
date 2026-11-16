<script setup lang="ts">
// 管制藥品專用處方箋（門診，第一～三級）：和一般處方分開的一張。
// 法規要的欄位：病人姓名、性別、出生、身分證號、地址；診斷；藥品名稱、規格、單次劑量、用法、總量（國字大寫防塗改）；
// 醫師姓名、管制藥品使用執照號碼、簽章；開立日期。資料由服務層 controlled.specialRxSheet 整理。
import type { SpecialRxSheet } from '@/services'
import { CONTROLLED_LEVEL_LABEL, masterApi } from '@/services'
import { HOSPITAL } from '@/utils/hospital'
import { toRoc } from '@/utils/date'

defineProps<{ s: SpecialRxSheet }>()
const routeName = (code: string) => masterApi.staticCodes.routes.find((r) => r.code === code)?.name ?? code
</script>

<template>
  <article class="print-area rounded-md border-2 border-slate-800 p-4 text-sm text-slate-900">
    <header class="border-b-2 border-slate-800 pb-2 text-center">
      <div class="font-bold">{{ HOSPITAL.name }}</div>
      <div class="text-lg font-bold tracking-widest">管制藥品專用處方箋</div>
      <div class="text-xs text-slate-600">{{ HOSPITAL.address }}・電話 {{ HOSPITAL.phone }}</div>
    </header>

    <dl class="mt-3 grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1">
      <dt class="text-slate-500">姓名</dt><dd class="font-semibold">{{ s.patient.name }}（{{ s.patient.gender }}）</dd>
      <dt class="text-slate-500">病歷號</dt><dd class="tabular">{{ s.patient.chartNo }}</dd>
      <dt class="text-slate-500">出生</dt><dd class="tabular">{{ toRoc(s.patient.birthDate) }}</dd>
      <dt class="text-slate-500">身分證號</dt><dd class="tabular">{{ s.patient.idNo }}</dd>
      <dt class="text-slate-500">地址</dt><dd class="col-span-3 break-keep break-words">{{ s.patient.address }}</dd>
      <dt class="text-slate-500">科別</dt><dd>{{ s.dept }}</dd>
      <dt class="text-slate-500">開立日期</dt><dd class="tabular">{{ toRoc(s.date) }}<template v-if="s.pickupNo">・領藥號 {{ s.pickupNo }}</template></dd>
      <dt class="text-slate-500">診斷</dt><dd class="col-span-3 break-keep break-words">{{ s.diagnoses.join('、') }}</dd>
    </dl>

    <table class="tabular mt-3 w-full border-collapse text-sm">
      <thead class="whitespace-nowrap">
        <tr class="border-y border-slate-800 text-xs">
          <th class="py-1 text-left">藥品</th>
          <th class="px-2 text-left">用法</th>
          <th class="px-2 text-right">天數</th>
          <th class="pl-2 text-right">總量</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(it, i) in s.items" :key="i" class="border-b border-slate-300 align-top">
          <td class="py-1.5">
            <div class="font-semibold">{{ it.drugName }}</div>
            <div class="text-xs">{{ it.nameZh }}・{{ it.spec }}・<b>{{ CONTROLLED_LEVEL_LABEL[it.controlled] }}管制藥品</b></div>
          </td>
          <td class="px-2 py-1.5">每次 {{ it.dose }} {{ it.doseUnit }}・{{ it.freqLabel }}・{{ routeName(it.route) }}</td>
          <td class="px-2 py-1.5 text-right">{{ it.days }}</td>
          <!-- 總量用國字大寫：防止「1」被改成「11」 -->
          <td class="whitespace-nowrap py-1.5 pl-2 text-right"><span class="font-semibold">{{ it.qty }} {{ it.unit }}</span><div class="font-bold">{{ it.qtyUpper }} {{ it.unit }}</div></td>
        </tr>
      </tbody>
    </table>
    <p class="mt-1 text-xs text-slate-600">本處方箋限調劑一次；其他非管制藥品另見一般處方。</p>

    <footer class="mt-4 grid grid-cols-2 gap-3 text-sm">
      <div>
        <div>醫師：<b>{{ s.doctor.name }}</b></div>
        <div class="tabular text-xs">醫事人員代碼 {{ s.doctor.licenseNo }}</div>
        <div class="tabular text-xs">管制藥品使用執照 <b>{{ s.doctor.controlledLicenseNo }}</b></div>
      </div>
      <div class="flex items-end justify-end gap-2">
        <span class="text-xs text-slate-500">醫師簽章</span>
        <span class="inline-block h-12 w-32 border border-slate-500"></span>
      </div>
    </footer>
  </article>
</template>
