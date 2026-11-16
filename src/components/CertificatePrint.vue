<script setup lang="ts">
// 診斷證明書（A4 列印）：病人、應診日期或住院期間、病名、醫師囑言、醫師與醫事人員代碼、字號、開立日期。
// 份數＝印幾張（每張一樣，列印時分頁）。資料由服務層 certificate.listCertificates 整理（CertificateView）。
import type { CertificateView } from '@/services'
import { HOSPITAL } from '@/utils/hospital'
import { toRoc } from '@/utils/date'

defineProps<{ c: CertificateView; copies?: number }>()
</script>

<template>
  <div class="print-area space-y-4">
    <article v-for="k in copies ?? c.copies" :key="k" class="break-after-page border-2 border-slate-800 p-6 text-sm leading-relaxed text-slate-900 last:break-after-auto">
      <header class="border-b-2 border-slate-800 pb-2 text-center">
        <div class="text-lg font-bold">{{ HOSPITAL.name }}</div>
        <div class="text-2xl font-bold tracking-[0.5em]">診斷證明書</div>
        <div class="tabular mt-1 flex justify-between text-xs"><span>病歷號 {{ c.patient.chartNo }}</span><span>{{ c.no }}</span></div>
      </header>
      <dl class="mt-3 grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1.5">
        <dt class="text-slate-600">姓名</dt><dd class="font-semibold">{{ c.patient.name }}</dd>
        <dt class="text-slate-600">性別</dt><dd>{{ c.patient.gender }}</dd>
        <dt class="text-slate-600">出生</dt><dd class="tabular">{{ toRoc(c.patient.birthDate) }}</dd>
        <dt class="text-slate-600">身分證號</dt><dd class="tabular">{{ c.patient.idNo }}</dd>
        <dt class="text-slate-600">住址</dt><dd class="col-span-3 break-keep break-words">{{ c.patient.address }}</dd>
        <dt class="text-slate-600">科別</dt><dd>{{ c.deptName }}</dd>
        <template v-if="c.visitDate"><dt class="text-slate-600">應診日期</dt><dd class="tabular">{{ toRoc(c.visitDate) }}</dd></template>
        <template v-else><dt class="text-slate-600">住院期間</dt><dd class="tabular">{{ toRoc(c.stayFrom!) }} 至 {{ toRoc(c.stayTo!) }}</dd></template>
      </dl>
      <section class="mt-4">
        <div class="font-semibold">病名</div>
        <p class="mt-1 min-h-[3rem] whitespace-pre-line border border-slate-400 px-3 py-2">{{ c.diagnoses }}</p>
      </section>
      <section class="mt-3">
        <div class="font-semibold">醫師囑言</div>
        <p class="mt-1 min-h-[5rem] whitespace-pre-line border border-slate-400 px-3 py-2">{{ c.advice }}</p>
      </section>
      <p class="mt-3 text-xs text-slate-600">用途：{{ c.purpose }}<template v-if="c.replacesNo">　（本證明書係作廢重開，原字號 {{ c.replacesNo }} 作廢）</template></p>
      <footer class="mt-6 flex items-end justify-between gap-4">
        <div class="text-sm">
          <div>醫師：<b>{{ c.doctorName }}</b>（醫事人員代碼 <span class="tabular">{{ c.doctorLicenseNo }}</span>）</div>
          <div class="tabular">開立日期：{{ toRoc(c.issuedAt.slice(0, 10)) }}</div>
          <div class="text-xs text-slate-600">{{ HOSPITAL.address }}・{{ HOSPITAL.phone }}</div>
        </div>
        <div class="flex items-end gap-2"><span class="text-xs text-slate-500">醫院印信</span><span class="inline-block h-20 w-20 border border-slate-500"></span></div>
      </footer>
    </article>
  </div>
</template>
