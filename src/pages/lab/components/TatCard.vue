<script setup lang="ts">
// 檢驗時效（醫檢師）：還沒發的快逾時（用掉八成時間）、已逾時的，標出現在卡在哪一段（等採檢、送檢、檢驗科內）；
// 近 30 天急件（60 分）與一般（240 分）的達成率、逾時的最常卡在哪一段。規則在 tat-rules、服務層 tat.ts
import { Timer } from 'lucide-vue-next'
import { UBadge, UCard } from '@/components/ui'
import { tatApi, TAT_SEGMENT_LABEL, type TatSegment } from '@/services'
import { useQuery } from '@/composables/useService'

const { data } = useQuery(() => tatApi.tatBoard())
const SEGS: TatSegment[] = ['collect', 'transport', 'lab']
</script>

<template>
  <UCard v-if="data" :padded="false">
    <template #title>
      <span class="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
        <Timer class="h-4 w-4" />檢驗時效
        <UBadge v-if="data.open.some((x) => x.state === 'late')" tone="red">逾時 {{ data.open.filter((x) => x.state === 'late').length }}</UBadge>
        <UBadge v-if="data.open.some((x) => x.state === 'warn')" tone="yellow">快逾時 {{ data.open.filter((x) => x.state === 'warn').length }}</UBadge>
        <span class="text-xs font-normal text-slate-500">近 30 天：急件 60 分內 {{ data.rate.stat.ontime }}/{{ data.rate.stat.total }}（{{ data.rate.stat.pct }}%）・一般 240 分內 {{ data.rate.routine.ontime }}/{{ data.rate.routine.total }}（{{ data.rate.routine.pct }}%）<template v-if="data.bottleneck.length">・逾時最常卡在{{ data.bottleneck[0].label }}（{{ data.bottleneck[0].count }} 筆）</template></span>
      </span>
    </template>
    <div class="p-3 text-sm">
      <p v-if="!data.open.length" class="text-xs text-slate-400">沒有快逾時的檢驗</p>
      <ul v-else class="divide-y divide-slate-100 rounded border border-slate-200">
        <li v-for="x in data.open" :key="x.key" class="flex flex-wrap items-center gap-2 px-2 py-1.5">
          <UBadge :tone="x.state === 'late' ? 'red' : 'yellow'">{{ x.priorityLabel }} {{ x.elapsed }}/{{ x.limit }} 分</UBadge>
          <b>{{ x.patientName }}</b><span class="text-xs text-slate-500">{{ x.where }}・{{ x.procName }}</span>
          <span class="min-w-0 flex-[1_1_10rem] text-xs font-semibold" :class="x.state === 'late' ? 'text-red-700' : 'text-amber-800'">卡在{{ x.segmentLabel }}{{ x.barcode ? `（條碼 ${x.barcode} 還沒收件）` : '' }}</span>
          <span class="tabular text-xs text-slate-500">{{ SEGS.filter((s) => x.segments[s] !== undefined).map((s) => `${TAT_SEGMENT_LABEL[s]} ${x.segments[s]} 分`).join('・') }}</span>
        </li>
      </ul>
    </div>
  </UCard>
</template>
