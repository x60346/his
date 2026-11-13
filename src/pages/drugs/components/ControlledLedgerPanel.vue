<script setup lang="ts">
// 管制藥品收支結存簿冊（藥師）：選管制藥、地點（藥庫、藥局、各病房常備）、期間 → 逐筆收入、支出、結存、
// 病人、開立醫師、經手、見證；殘餘量銷毀另列一行（不動結存）。資料、CSV、Excel 都來自服務層 controlled.controlledLedger。
import { computed, ref, watch } from 'vue'
import { Download, Printer } from 'lucide-vue-next'
import { UBadge, UButton, UInput, UQueryState, USelect } from '@/components/ui'
import { controlledApi, controlledLedgerCsv, controlledLedgerFileName, controlledLedgerXlsx, controlledLedgerXlsxFileName, XLSX_MIME } from '@/services'
import { downloadFile } from '@/utils/download'
import { useQuery } from '@/composables/useService'
import { addDays, today } from '@/utils/date'

const { data: opts } = useQuery(() => controlledApi.controlledLedgerOptions())
const drugId = ref<string | number | undefined>()
const locationId = ref<string | number | undefined>()
const from = ref(addDays(today(), -30))
const to = ref(today())
watch(opts, (o) => {
  if (!o) return
  if (!drugId.value) drugId.value = o.drugs[0]?.id
  if (!locationId.value) locationId.value = o.locations.find((l) => l.kind === 'ward')?.id ?? o.locations[0]?.id
}, { immediate: true })
const ready = computed(() => !!drugId.value && !!locationId.value && !!from.value && !!to.value && from.value <= to.value)
const { data, loading } = useQuery(
  async () => (ready.value ? controlledApi.controlledLedger({ drugId: String(drugId.value), locationId: String(locationId.value), from: from.value, to: to.value }) : undefined),
  [drugId, locationId, from, to],
)
const KIND_TONE = { in: 'green', out: 'blue', residual: 'purple' } as const
const print = () => window.print()
function exportXlsx() {
  if (data.value) downloadFile(controlledLedgerXlsx(data.value), XLSX_MIME, controlledLedgerXlsxFileName(data.value))
}
function exportCsv() {
  if (data.value) downloadFile(controlledLedgerCsv(data.value), 'text/csv;charset=utf-8', controlledLedgerFileName(data.value))
}
</script>

<template>
  <div class="space-y-3">
    <div class="no-print flex flex-wrap items-end gap-3">
      <USelect v-model="drugId" label="管制藥" class="w-56" :options="(opts?.drugs ?? []).map((d) => ({ label: `${d.name}（第 ${d.controlled} 級）`, value: d.id }))" />
      <USelect v-model="locationId" label="地點" class="w-48" :options="(opts?.locations ?? []).map((l) => ({ label: l.name, value: l.id }))" />
      <UInput v-model="from" type="date" label="起" class="w-40" />
      <UInput v-model="to" type="date" label="迄" class="w-40" :max="today()" />
      <div class="ml-auto flex gap-2">
        <UButton variant="secondary" :icon="Download" :disabled="!data" @click="exportXlsx">匯出 Excel</UButton>
        <UButton variant="ghost" :disabled="!data" @click="exportCsv">CSV</UButton>
        <UButton variant="secondary" :icon="Printer" :disabled="!data" @click="print">列印</UButton>
      </div>
    </div>
    <UQueryState :loading="loading && !data" :ready="!!data" empty-title="請選擇管制藥、地點與期間">
      <template v-if="data">
        <div class="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm">
          <div class="text-base font-bold text-slate-800">管制藥品收支結存簿冊</div>
          <div class="text-slate-700">{{ data.drug.name }}（{{ data.drug.nameZh }}）・{{ data.drug.spec }}・<b>第 {{ data.drug.controlled }} 級</b>・{{ data.locationName }}・{{ data.from }} ～ {{ data.to }}（單位 {{ data.drug.unit }}）</div>
          <div class="tabular mt-1 flex flex-wrap gap-x-4 text-xs text-slate-600">
            <span>期初 <b>{{ data.opening }}</b></span>
            <span>收入 <b class="text-emerald-700">+{{ data.totalIn }}</b></span>
            <span>支出 <b class="text-sky-700">−{{ data.totalOut }}</b></span>
            <span v-if="data.residualTotal">殘餘量銷毀 <b class="text-purple-700">{{ data.residualTotal }}</b>（已含在支出的整支裡）</span>
            <span>期末 <b>{{ data.closing }}</b></span>
          </div>
        </div>
        <div class="overflow-x-auto rounded-md border border-slate-200">
          <table class="tabular w-full text-sm">
            <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500">
              <tr>
                <th class="px-3 py-1.5 text-left font-medium">日期時間</th>
                <th class="px-2 text-left font-medium">類別</th>
                <th class="px-2 text-right font-medium">收入</th>
                <th class="px-2 text-right font-medium">支出</th>
                <th class="px-2 text-right font-medium">結存</th>
                <th class="px-2 text-left font-medium">病人</th>
                <th class="px-2 text-left font-medium">開立醫師</th>
                <th class="px-2 text-left font-medium">經手</th>
                <th class="px-2 text-left font-medium">見證</th>
                <th class="px-3 text-left font-medium">單號・說明</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr class="bg-slate-50/60 text-xs text-slate-500"><td class="px-3 py-1" colspan="4">期初結存</td><td class="px-2 text-right font-semibold text-slate-700">{{ data.opening }}</td><td colspan="5"></td></tr>
              <tr v-for="(r, i) in data.rows" :key="i" :class="r.kind === 'residual' && 'bg-purple-50/50'">
                <td class="whitespace-nowrap px-3 py-1.5 text-xs">{{ r.at.slice(5, 16) }}</td>
                <td class="px-2"><UBadge :tone="KIND_TONE[r.kind]">{{ r.typeLabel }}</UBadge></td>
                <td class="px-2 text-right text-emerald-700">{{ r.kind === 'in' ? `+${r.qty}` : '' }}</td>
                <td class="px-2 text-right text-sky-700">{{ r.kind === 'out' ? `−${r.qty}` : r.kind === 'residual' ? `（銷毀 ${r.qty}）` : '' }}</td>
                <td class="px-2 text-right font-semibold">{{ r.balance }}</td>
                <td class="whitespace-nowrap px-2 text-xs">{{ r.patientName ? `${r.patientName} ${r.chartNo}` : '—' }}</td>
                <td class="whitespace-nowrap px-2 text-xs">{{ r.doctorName ?? '—' }}</td>
                <td class="whitespace-nowrap px-2 text-xs">{{ r.userName }}</td>
                <td class="whitespace-nowrap px-2 text-xs">{{ r.witnessName ?? '' }}</td>
                <td class="px-3 text-xs text-slate-600">{{ r.ref }}<template v-if="r.ref && r.reason">・</template>{{ r.reason }}</td>
              </tr>
              <tr v-if="!data.rows.length"><td colspan="10" class="px-3 py-4 text-center text-sm text-slate-400">這段期間沒有收支</td></tr>
              <tr class="bg-slate-50/60 text-xs text-slate-500"><td class="px-3 py-1" colspan="4">期末結存</td><td class="px-2 text-right font-semibold text-slate-700">{{ data.closing }}</td><td colspan="5"></td></tr>
            </tbody>
          </table>
        </div>
      </template>
    </UQueryState>
  </div>
</template>
