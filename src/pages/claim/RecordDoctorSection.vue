<script setup lang="ts">
// 主治：我主治的出院病人，病歷還沒完成的（出院後 14 天內要完成：出院病摘簽署、手術紀錄、死亡證明書、會診回覆）。
// 缺什麼、期限、逾期由服務層判斷（record-audit.ts）；這裡只列出來，到各自的頁面補
import { UBadge, UQueryState } from '@/components/ui'
import { recordAuditApi } from '@/services'
import { useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => recordAuditApi.myIncompleteRecords(), [])
// 住院中：最近 7 天每天至少一筆病程紀錄（在「住院醫囑」頁寫）
const { data: prog } = useQuery(() => recordAuditApi.myMissingProgressNotes(), [])
</script>

<template>
  <section class="space-y-2">
    <template v-if="prog?.length">
      <h2 class="font-semibold text-slate-700">住院中病程紀錄缺漏<span class="ml-2 text-xs font-normal text-slate-500">每天至少一筆（看最近 7 天，到「住院醫囑」頁補寫）</span></h2>
      <ul class="space-y-1 text-sm">
        <li v-for="p in prog" :key="p.admissionId" class="rounded-md border border-amber-300 bg-white px-3 py-1.5">
          <b>{{ p.patientName }}</b><span class="text-xs text-slate-500">・{{ p.admitNo }}{{ p.bedText ? `・${p.bedText}` : '' }}・入院 {{ p.admittedAt.slice(5, 10) }}</span>
          <div class="text-xs text-amber-800">沒有病程紀錄：{{ p.dates.map((d) => d.slice(5)).join('、') }}</div>
        </li>
      </ul>
    </template>
    <h2 class="font-semibold text-slate-700">出院病歷待完成<span class="ml-2 text-xs font-normal text-slate-500">出院後 14 天內要完成</span></h2>
    <UQueryState :loading="loading && !data" :ready="!!data?.length" empty-title="出院病歷都完成了">
      <ul v-if="data" class="space-y-2 text-sm">
        <li v-for="x in data" :key="x.admissionId" :class="['rounded-md border bg-white px-3 py-2', x.overdue ? 'border-red-300' : 'border-slate-200']">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge v-if="x.overdue" tone="red">逾期</UBadge>
            <b>{{ x.patientName }}</b><span class="text-xs text-slate-500">{{ x.chartNo }}・{{ x.admitNo }}・出院 {{ x.dischargedAt.slice(0, 10) }}（{{ x.dischargeType }}）・期限 {{ x.due }}</span>
          </div>
          <div class="text-xs text-red-700">缺：{{ x.gaps.join('；') }}</div>
        </li>
      </ul>
    </UQueryState>
  </section>
</template>
