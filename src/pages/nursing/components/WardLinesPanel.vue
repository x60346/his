<script setup lang="ts">
// 病房層級「管路日」：最近 30 天各種管路的管路日、目前在身上的條數、使用率（管路日 ÷ 住院人日）、移除原因。
// 感染管制看的分母（導尿管相關泌尿道感染、CVC 相關血流感染每千管路日幾例）；本系統沒有感染個案，只統計管路日
import { deliriumApi, lineApi } from '@/services'
import { UQueryState } from '@/components/ui'
import { useQuery } from '@/composables/useService'

const props = defineProps<{ ward: string }>()
const { data, loading } = useQuery(async () => ({ ward: props.ward, s: await lineApi.wardLineStats(props.ward, 30), q: await deliriumApi.wardSafetyStats(props.ward, 30) }), [() => props.ward])
</script>

<template>
  <div class="p-4 text-sm">
    <UQueryState :loading="loading && !data" :ready="!!data && data.ward === ward">
      <template v-if="data">
        <div class="mb-2 flex flex-wrap items-baseline gap-x-3">
          <span class="font-semibold text-slate-700">品質指標・{{ ward }}</span>
          <span class="tabular text-xs text-slate-500">{{ data.s.from }} ～ {{ data.s.to }}・住院人日 {{ data.s.patientDays }}</span>
        </div>
        <table class="w-full rounded-md border border-slate-200 text-left">
          <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500">
            <tr><th class="px-3 py-1.5">管路</th><th class="px-3 py-1.5 text-right">管路日</th><th class="px-3 py-1.5 text-right">使用率</th><th class="px-3 py-1.5 text-right">目前</th><th class="px-3 py-1.5">期間內移除原因</th></tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="r in data.s.rows" :key="r.kind">
              <td class="px-3 py-1.5">{{ r.label }}</td>
              <td class="tabular px-3 py-1.5 text-right">{{ r.lineDays }}</td>
              <td class="tabular px-3 py-1.5 text-right">{{ r.utilization === null ? '—' : `${Math.round(r.utilization * 100)}%` }}</td>
              <td class="tabular px-3 py-1.5 text-right">{{ r.active }}</td>
              <td class="px-3 py-1.5 text-xs text-slate-600">{{ Object.entries(r.removed).map(([k, n]) => `${k} ${n}`).join('、') || '—' }}</td>
            </tr>
          </tbody>
        </table>
        <div class="mt-4 mb-2 font-semibold text-slate-700">約束與譫妄</div>
        <dl class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div class="rounded-md border border-slate-200 px-3 py-2"><dt class="text-xs text-slate-500">約束次數（緊急）</dt><dd class="tabular text-lg font-semibold">{{ data.q.restraints }}<span class="text-sm font-normal text-slate-500">（{{ data.q.emergency }}）</span></dd></div>
          <div class="rounded-md border border-slate-200 px-3 py-2"><dt class="text-xs text-slate-500">約束日數</dt><dd class="tabular text-lg font-semibold">{{ data.q.restraintDays }}</dd></div>
          <div class="rounded-md border border-slate-200 px-3 py-2"><dt class="text-xs text-slate-500">目前約束中</dt><dd class="tabular text-lg font-semibold">{{ data.q.restraintActive }}</dd></div>
          <div class="rounded-md border border-slate-200 px-3 py-2"><dt class="text-xs text-slate-500">CAM 陽性率</dt><dd class="tabular text-lg font-semibold">{{ data.q.camRate === null ? '—' : `${Math.round(data.q.camRate * 100)}%` }}<span class="text-sm font-normal text-slate-500">（{{ data.q.camPositive }}／{{ data.q.camCount }}）</span></dd></div>
        </dl>
        <p class="mt-2 text-xs text-slate-500">管路日：每條管路在身上的日數（放置、移除當天都算）。依病人目前住的病房統計。</p>
      </template>
    </UQueryState>
  </div>
</template>
