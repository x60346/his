<script setup lang="ts">
// 經營月報（權限「經營報表」，預設管理員）：選月份 → 指標（和上月、去年同月比較）、近 12 個月趨勢、門診科別與醫師、住院科別；匯出 Excel。
// 數字全部由服務層 management.managementReport 算好（收入和日結同一份計算），頁面只呈現；沒有資料的月份顯示「—」
import { computed, ref } from 'vue'
import { FileSpreadsheet } from 'lucide-vue-next'
import { UBarChart, UButton, UCard, UPageHeader, UQueryState, type BarDatum } from '@/components/ui'
import { managementApi, managementXlsx, managementXlsxFileName, MGMT_KPIS, mgmtChangeText, mgmtValueText, XLSX_MIME } from '@/services'
import { useQuery } from '@/composables/useService'
import { downloadFile } from '@/utils/download'
import { today } from '@/utils/date'

const month = ref(today().slice(0, 7))
const { data, loading } = useQuery(() => managementApi.managementReport(month.value), [month])
const r = computed(() => (data.value?.month === month.value ? data.value : undefined))
const groups = ['門診', '住院', '收入', '醫療服務量', '健保申報'] as const
const changeTone = (t: string) => (t.startsWith('+') ? 'text-emerald-700' : t.startsWith('−') ? 'text-red-700' : 'text-slate-400')
const shortMonth = (m: string) => `${Number(m.slice(5))} 月`
const trend = (k: 'opdVisits' | 'collected' | 'occupancy' | 'cmi'): BarDatum[] =>
  (r.value?.trend ?? []).map((x) => ({ label: shortMonth(x.month), value: x[k] ?? 0, title: `${x.month}：${x.hasData ? mgmtValueText(x[k], k === 'occupancy' ? '%' : k === 'cmi' ? 'RW' : '') : '沒有資料'}` }))
function exportXlsx() {
  if (r.value) downloadFile(managementXlsx(r.value), XLSX_MIME, managementXlsxFileName(r.value))
}
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="經營月報" description="門診、住院、收入、醫療服務量、健保申報；和上個月、去年同月比較">
        <input v-model="month" type="month" :max="today().slice(0, 7)" class="form-control w-40" aria-label="月份" />
        <UButton variant="secondary" :icon="FileSpreadsheet" :disabled="!r" @click="exportXlsx">匯出 Excel</UButton>
    </UPageHeader>
    <UQueryState :loading="loading && !r" :ready="!!r">
      <template v-if="r">
        <p v-if="r.partial" class="text-sm text-amber-800">本月還沒過完：算到 {{ r.to }}（比較的月份是整個月）。</p>
        <p v-if="!r.current.hasData" class="text-sm text-slate-500">這個月沒有資料（示範資料只有最近幾個月）。</p>
        <div class="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(20rem,1fr))]">
          <UCard v-for="g in groups" :key="g" :title="g" :padded="false">
            <table class="w-full text-sm">
              <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500">
                <tr><th class="px-3 py-1.5 text-left">指標</th><th class="px-3 py-1.5 text-right">{{ shortMonth(r.month) }}</th><th class="px-3 py-1.5 text-right">比上月</th><th class="px-3 py-1.5 text-right">比去年同月</th></tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                <tr v-for="k in MGMT_KPIS.filter((x) => x.group === g)" :key="k.key">
                  <td class="px-3 py-1.5 text-slate-700">{{ k.label }}</td>
                  <td class="tabular whitespace-nowrap px-3 py-1.5 text-right font-semibold text-slate-800">{{ mgmtValueText(r.current[k.key], k.unit) }}<span v-if="r.current[k.key] !== null && k.unit !== '%'" class="ml-0.5 text-xs font-normal text-slate-400">{{ k.unit }}</span></td>
                  <td :class="['tabular whitespace-nowrap px-3 py-1.5 text-right text-xs', changeTone(mgmtChangeText(r.current[k.key], r.prev[k.key], k.unit))]" :title="`上月 ${mgmtValueText(r.prev[k.key], k.unit)}`">{{ mgmtChangeText(r.current[k.key], r.prev[k.key], k.unit) }}</td>
                  <td :class="['tabular whitespace-nowrap px-3 py-1.5 text-right text-xs', changeTone(mgmtChangeText(r.current[k.key], r.lastYear[k.key], k.unit))]" :title="`去年同月 ${mgmtValueText(r.lastYear[k.key], k.unit)}`">{{ mgmtChangeText(r.current[k.key], r.lastYear[k.key], k.unit) }}</td>
                </tr>
              </tbody>
            </table>
          </UCard>
        </div>

        <div class="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(20rem,1fr))]">
          <UCard title="近 12 個月：門診人次"><UBarChart :data="trend('opdVisits')" unit="人次" value-labels="nonzero" /></UCard>
          <UCard title="近 12 個月：實收（元）"><UBarChart :data="trend('collected')" unit="元" value-labels="nonzero" /></UCard>
          <UCard title="近 12 個月：佔床率（%）"><UBarChart :data="trend('occupancy')" unit="%" value-labels="nonzero" /></UCard>
          <UCard title="近 12 個月：病例組合指數（CMI）"><UBarChart :data="trend('cmi')" unit="" value-labels="nonzero" /></UCard>
        </div>
        <p class="text-xs text-slate-500">沒有資料的月份長條是 0（滑鼠移上去會寫「沒有資料」）。佔床率以目前 {{ r.beds }} 床計算。</p>

        <div class="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(20rem,1fr))]">
          <UCard title="門診科別" :padded="false">
            <table class="w-full text-sm">
              <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500"><tr><th class="px-3 py-1.5 text-left">科別</th><th class="px-3 py-1.5 text-right">人次</th><th class="px-3 py-1.5 text-right">初診</th><th class="px-3 py-1.5 text-right">占比</th></tr></thead>
              <tbody class="divide-y divide-slate-100">
                <tr v-for="d in r.opdByDept" :key="d.deptName"><td class="px-3 py-1.5">{{ d.deptName }}</td><td class="tabular px-3 py-1.5 text-right">{{ d.visits }}</td><td class="tabular px-3 py-1.5 text-right">{{ d.first }}</td><td class="tabular px-3 py-1.5 text-right">{{ d.share.toFixed(1) }}%</td></tr>
                <tr v-if="!r.opdByDept.length"><td colspan="4" class="px-3 py-4 text-center text-slate-400">—</td></tr>
              </tbody>
            </table>
          </UCard>
          <UCard title="門診醫師" :padded="false">
            <table class="w-full text-sm">
              <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500"><tr><th class="px-3 py-1.5 text-left">醫師</th><th class="px-3 py-1.5 text-left">科別</th><th class="px-3 py-1.5 text-right">人次</th></tr></thead>
              <tbody class="divide-y divide-slate-100">
                <tr v-for="d in r.opdByDoctor" :key="d.doctorName + d.deptName"><td class="px-3 py-1.5">{{ d.doctorName }}</td><td class="px-3 py-1.5 text-slate-600">{{ d.deptName }}</td><td class="tabular px-3 py-1.5 text-right">{{ d.visits }}</td></tr>
                <tr v-if="!r.opdByDoctor.length"><td colspan="3" class="px-3 py-4 text-center text-slate-400">—</td></tr>
              </tbody>
            </table>
          </UCard>
          <UCard title="住院科別" :padded="false">
            <table class="w-full text-sm">
              <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500"><tr><th class="px-3 py-1.5 text-left">科別</th><th class="px-3 py-1.5 text-right">入院</th><th class="px-3 py-1.5 text-right">出院</th><th class="px-3 py-1.5 text-right">住院人日</th></tr></thead>
              <tbody class="divide-y divide-slate-100">
                <tr v-for="d in r.ipdByDept" :key="d.deptName"><td class="px-3 py-1.5">{{ d.deptName }}</td><td class="tabular px-3 py-1.5 text-right">{{ d.admissions }}</td><td class="tabular px-3 py-1.5 text-right">{{ d.discharges }}</td><td class="tabular px-3 py-1.5 text-right">{{ d.patientDays }}</td></tr>
                <tr v-if="!r.ipdByDept.length"><td colspan="4" class="px-3 py-4 text-center text-slate-400">—</td></tr>
              </tbody>
            </table>
          </UCard>
          <UCard :title="`DRG 盈虧（本月出院${r.drg.exempt ? `；不適用 DRG ${r.drg.exempt} 筆` : ''}）`" :padded="false">
            <table class="w-full text-sm">
              <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500"><tr><th class="px-3 py-1.5 text-left">DRG</th><th class="px-3 py-1.5 text-right">權重</th><th class="px-3 py-1.5 text-right">筆數</th><th class="px-3 py-1.5 text-right">平均住院日</th><th class="px-3 py-1.5 text-right">實際點數</th><th class="px-3 py-1.5 text-right">給付點數</th><th class="px-3 py-1.5 text-right">盈虧</th></tr></thead>
              <tbody class="divide-y divide-slate-100">
                <tr v-for="d in r.drg.rows" :key="d.code"><td class="px-3 py-1.5"><b class="tabular">{{ d.code }}</b> <span class="text-xs text-slate-600">{{ d.name }}</span></td><td class="tabular px-3 py-1.5 text-right">{{ d.weight.toFixed(2) }}</td><td class="tabular px-3 py-1.5 text-right">{{ d.count }}</td><td class="tabular px-3 py-1.5 text-right">{{ d.alos }}</td><td class="tabular px-3 py-1.5 text-right">{{ d.actual.toLocaleString('zh-TW') }}</td><td class="tabular px-3 py-1.5 text-right">{{ d.pay.toLocaleString('zh-TW') }}</td><td class="tabular px-3 py-1.5 text-right" :class="d.diff < 0 ? 'text-red-700' : 'text-emerald-700'">{{ d.diff >= 0 ? '+' : '' }}{{ d.diff.toLocaleString('zh-TW') }}</td></tr>
                <tr v-if="!r.drg.rows.length"><td colspan="7" class="px-3 py-4 text-center text-slate-400">—</td></tr>
              </tbody>
            </table>
          </UCard>
        </div>
      </template>
    </UQueryState>
  </div>
</template>
