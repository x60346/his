<script setup lang="ts">
// 病歷室：全院出院病歷完整性——每月準時完成率（出院 14 天內完成）、各主治待完成與逾期、還沒完成的清單（逾期在前）。
// 規則在 record-audit-rules，這裡只顯示
import { UBadge, UQueryState } from '@/components/ui'
import { RECORD_DUE_DAYS, recordAuditApi } from '@/services'
import { useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => recordAuditApi.recordAudit(), [])
</script>

<template>
  <UQueryState :loading="loading && !data" :ready="!!data">
    <div v-if="data" class="space-y-3 text-sm">
      <p class="text-xs text-slate-500">出院後 {{ RECORD_DUE_DAYS }} 天內病歷要完成：出院病摘簽署、手術紀錄、死亡證明書（自然死）、會診回覆。準時完成率＝已到期（或已完成）的出院裡，期限內完成的比例。</p>
      <div class="grid gap-3 lg:grid-cols-2">
        <section class="rounded-md border border-slate-200 bg-white p-3">
          <h3 class="mb-1 font-semibold text-slate-700">每月準時完成率</h3>
          <table class="w-full">
            <thead class="text-xs text-slate-500"><tr><th class="text-left">出院月份</th><th class="text-right">出院</th><th class="text-right">還沒完成</th><th class="text-right">準時完成率</th></tr></thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="m in data.months" :key="m.month"><td class="tabular py-1">{{ m.month }}</td><td class="tabular text-right">{{ m.discharged }}</td><td class="tabular text-right">{{ m.incomplete || '' }}</td><td class="tabular text-right" :class="m.rate !== null && m.rate < 90 ? 'font-semibold text-red-700' : ''">{{ m.rate === null ? '—' : `${m.rate}%` }}</td></tr>
            </tbody>
          </table>
        </section>
        <section class="rounded-md border border-slate-200 bg-white p-3">
          <h3 class="mb-1 font-semibold text-slate-700">各主治</h3>
          <p v-if="!data.byDoctor.length" class="text-slate-400">都完成了</p>
          <table v-else class="w-full">
            <thead class="text-xs text-slate-500"><tr><th class="text-left">主治</th><th class="text-right">待完成</th><th class="text-right">逾期</th></tr></thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="d in data.byDoctor" :key="d.doctorName"><td class="py-1">{{ d.doctorName }}</td><td class="tabular text-right">{{ d.incomplete }}</td><td class="tabular text-right" :class="d.overdue ? 'font-semibold text-red-700' : ''">{{ d.overdue || '' }}</td></tr>
            </tbody>
          </table>
        </section>
      </div>
      <h3 class="font-semibold text-slate-700">還沒完成（{{ data.incomplete.length }}）</h3>
      <ul class="space-y-2">
        <li v-for="x in data.incomplete" :key="x.admissionId" :class="['rounded-md border bg-white px-3 py-2', x.overdue ? 'border-red-300' : 'border-slate-200']">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge v-if="x.overdue" tone="red">逾期</UBadge>
            <b>{{ x.patientName }}</b><span class="text-xs text-slate-500">{{ x.chartNo }}・{{ x.admitNo }}・{{ x.deptName }} {{ x.doctorName }}・出院 {{ x.dischargedAt.slice(0, 10) }}（{{ x.dischargeType }}）・期限 {{ x.due }}</span>
          </div>
          <div class="text-xs text-red-700">缺：{{ x.gaps.join('；') }}</div>
        </li>
      </ul>
    </div>
  </UQueryState>
</template>
