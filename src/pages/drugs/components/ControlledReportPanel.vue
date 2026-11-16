<script setup lang="ts">
// 管制藥品收支結存申報表（藥師、管理員）：選期間（月報、年報）→ 每種管制藥、每個地點的期初、收入、支出、期末，
// 再加全院合計（院內撥補不算收支）。每一格就是那本簿冊的數字（服務層 controlled.controlledReport 用同一個計算）。
import { computed, ref } from 'vue'
import { Download, Printer } from 'lucide-vue-next'
import { UButton, UInput, UQueryState } from '@/components/ui'
import { CONTROLLED_LEVEL_LABEL, controlledApi, controlledReportCsv, controlledReportFileName, controlledReportXlsx, controlledReportXlsxFileName, XLSX_MIME } from '@/services'
import { downloadFile } from '@/utils/download'
import { useQuery } from '@/composables/useService'
import { addDays, today } from '@/utils/date'

const todayStr = today()
const firstOfMonth = (d: string) => `${d.slice(0, 8)}01`
const lastMonthEnd = addDays(firstOfMonth(todayStr), -1)
const presets = [
  { label: '本月', from: firstOfMonth(todayStr), to: todayStr },
  { label: '上月', from: firstOfMonth(lastMonthEnd), to: lastMonthEnd },
  { label: '今年', from: `${todayStr.slice(0, 4)}-01-01`, to: todayStr },
]
const from = ref(presets[0].from)
const to = ref(presets[0].to)
const ready = computed(() => !!from.value && !!to.value && from.value <= to.value)
const { data, loading } = useQuery(async () => (ready.value ? controlledApi.controlledReport({ from: from.value, to: to.value }) : undefined), [from, to])
const print = () => window.print()
function exportXlsx() {
  if (data.value) downloadFile(controlledReportXlsx(data.value), XLSX_MIME, controlledReportXlsxFileName(data.value))
}
function exportCsv() {
  if (data.value) downloadFile(controlledReportCsv(data.value), 'text/csv;charset=utf-8', controlledReportFileName(data.value))
}
</script>

<template>
  <div class="space-y-3">
    <div class="no-print flex flex-wrap items-end gap-3">
      <UInput v-model="from" type="date" label="起" class="w-40" />
      <UInput v-model="to" type="date" label="迄" class="w-40" :max="todayStr" />
      <div class="flex gap-1">
        <UButton v-for="p in presets" :key="p.label" size="sm" :variant="from === p.from && to === p.to ? 'primary' : 'ghost'" @click="(from = p.from), (to = p.to)">{{ p.label }}</UButton>
      </div>
      <div class="ml-auto flex gap-2">
        <UButton variant="secondary" :icon="Download" :disabled="!data" @click="exportXlsx">匯出 Excel</UButton>
        <UButton variant="ghost" :disabled="!data" @click="exportCsv">CSV</UButton>
        <UButton variant="secondary" :icon="Printer" :disabled="!data" @click="print">列印</UButton>
      </div>
    </div>
    <UQueryState :loading="loading && !data" :ready="!!data" empty-title="請選擇申報期間">
      <div v-if="data" class="print-area space-y-2">
        <div class="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm">
          <div class="text-base font-bold text-slate-800">管制藥品收支結存申報表</div>
          <div class="text-slate-700">申報期間 {{ data.from }} ～ {{ data.to }}</div>
          <div class="mt-1 text-xs text-slate-500">各地點的收入、支出含院內撥補；全院合計不含院內撥補（只是換地點）。殘餘量銷毀已含在支出的整支裡，不另扣結存。</div>
        </div>
        <div class="overflow-x-auto rounded-md border border-slate-200">
          <table class="tabular w-full text-sm">
            <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500">
              <tr>
                <th class="px-3 py-1.5 text-left font-medium">藥品</th>
                <th class="px-2 text-left font-medium">地點</th>
                <th class="px-2 text-right font-medium">期初</th>
                <th class="px-2 text-right font-medium">收入</th>
                <th class="px-2 text-right font-medium">支出</th>
                <th class="px-2 text-right font-medium">殘餘量銷毀</th>
                <th class="px-3 text-right font-medium">期末</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="(r, i) in data.rows" :key="i" :class="!r.locationId && 'bg-slate-50 font-semibold'">
                <td class="px-3 py-1.5">
                  <!-- 同一種藥只在第一列寫藥名 -->
                  <template v-if="i === 0 || data.rows[i - 1].drugId !== r.drugId">
                    <div class="whitespace-nowrap font-medium text-slate-800">{{ r.drugName }}</div>
                    <div class="whitespace-nowrap text-xs font-normal text-slate-500">{{ r.nameZh }}・{{ r.spec }}・{{ CONTROLLED_LEVEL_LABEL[r.controlled] }}（{{ r.unit }}）</div>
                  </template>
                </td>
                <td class="whitespace-nowrap px-2 text-xs">{{ r.locationName }}</td>
                <td class="px-2 text-right">{{ r.opening }}</td>
                <td class="px-2 text-right text-emerald-700">{{ r.totalIn ? `+${r.totalIn}` : 0 }}</td>
                <td class="px-2 text-right text-sky-700">{{ r.totalOut ? `−${r.totalOut}` : 0 }}</td>
                <td class="px-2 text-right text-purple-700">{{ r.residualTotal || '' }}</td>
                <td class="px-3 text-right font-semibold">{{ r.closing }}</td>
              </tr>
              <tr v-if="!data.rows.length"><td colspan="7" class="px-3 py-4 text-center text-sm text-slate-400">這段期間沒有管制藥品的帳</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </UQueryState>
  </div>
</template>
