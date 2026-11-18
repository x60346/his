<script setup lang="ts">
// 死亡證明書（A4 列印；簡化版格式）：死者資料、死亡時間與地點、死因甲乙丙丁、其他影響疾病、死亡方式、醫師、字號。份數＝印幾張
import type { DeathView } from '@/services'
import { HOSPITAL } from '@/utils/hospital'
import { toRoc } from '@/utils/date'

defineProps<{ d: DeathView }>()
</script>

<template>
  <div class="print-area space-y-4">
    <article v-for="k in d.cert?.copies ?? 1" :key="k" class="break-after-page border-2 border-slate-800 p-6 text-sm leading-relaxed text-slate-900 last:break-after-auto">
      <header class="border-b-2 border-slate-800 pb-2 text-center">
        <div class="text-lg font-bold">{{ HOSPITAL.name }}</div>
        <div class="text-2xl font-bold tracking-[0.5em]">死亡證明書</div>
        <div class="tabular mt-1 flex justify-between text-xs"><span>病歷號 {{ d.print.chartNo }}</span><span>{{ d.cert?.no }}</span></div>
      </header>
      <dl class="mt-3 grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1.5">
        <dt class="text-slate-600">死者姓名</dt><dd class="font-semibold">{{ d.print.name }}</dd>
        <dt class="text-slate-600">性別</dt><dd>{{ d.print.gender }}</dd>
        <dt class="text-slate-600">出生</dt><dd class="tabular">{{ toRoc(d.print.birthDate) }}（{{ d.print.age }} 歲）</dd>
        <dt class="text-slate-600">身分證號</dt><dd class="tabular">{{ d.print.idNo }}</dd>
        <dt class="text-slate-600">住址</dt><dd class="col-span-3">{{ d.print.address }}</dd>
        <dt class="text-slate-600">死亡時間</dt><dd class="tabular">{{ toRoc(d.declaredAt.slice(0, 10)) }} {{ d.declaredAt.slice(11, 16) }}</dd>
        <dt class="text-slate-600">死亡地點</dt><dd>{{ HOSPITAL.name }}（住院中）</dd>
      </dl>
      <section class="mt-4">
        <div class="font-semibold">死亡原因</div>
        <table class="mt-1 w-full border border-slate-400 text-sm">
          <tbody>
            <tr v-for="c in d.causesText" :key="c.label" class="border-b border-slate-300"><td class="w-56 px-2 py-1 text-slate-600">{{ c.label }}</td><td class="px-2 py-1">{{ c.text }}</td></tr>
            <tr><td class="px-2 py-1 text-slate-600">其他對死亡有影響之疾病</td><td class="px-2 py-1">{{ d.other ?? '—' }}</td></tr>
          </tbody>
        </table>
      </section>
      <p class="mt-3">死亡方式：<b>{{ d.mannerLabel }}</b></p>
      <footer class="mt-6 flex items-end justify-between gap-4">
        <div class="text-sm">
          <div>醫師：<b>{{ d.print.doctorName }}</b>（醫事人員代碼 <span class="tabular">{{ d.print.doctorLicenseNo }}</span>）・{{ d.print.deptName }}</div>
          <div class="tabular">開立日期：{{ d.cert ? toRoc(d.cert.issuedAt.slice(0, 10)) : '' }}</div>
          <div class="text-xs text-slate-600">{{ HOSPITAL.address }}・{{ HOSPITAL.phone }}</div>
        </div>
        <div class="flex items-end gap-2"><span class="text-xs text-slate-500">醫院印信</span><span class="inline-block h-20 w-20 border border-slate-500"></span></div>
      </footer>
    </article>
  </div>
</template>
