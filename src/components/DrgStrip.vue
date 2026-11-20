<script setup lang="ts">
// 預估 DRG（住院醫囑頁、護理站）：分組（代碼、名稱、權重、定額、上下限）與分組依據；不適用 DRG 的原因；
// 目前健保點數佔上限幾 %（80% 以上標黃、超過標紅）、照現在的點數給付多少與盈虧。只提示，不擋醫囑。都由服務層算（drg.ts）
import { useQuery } from '@/composables/useService'
import { drgApi } from '@/services'

const props = defineProps<{ admissionId: string }>()
const { data } = useQuery(() => drgApi.drgEstimate(props.admissionId), [() => props.admissionId])
const fmt = (n: number) => n.toLocaleString('zh-TW')
const TONE = { ok: 'border-slate-200 bg-white', near: 'border-amber-300 bg-amber-50', over: 'border-red-300 bg-red-50' } as const
</script>

<template>
  <div v-if="data && data.admissionId === admissionId" :class="['flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-4 py-2 text-sm', data.exempt ? TONE.ok : TONE[data.alert.level]]">
    <span class="font-medium text-slate-700">預估 DRG</span>
    <span><b class="tabular">{{ data.group.code }}</b> {{ data.group.name }}</span>
    <span class="tabular text-xs text-slate-600">權重 {{ data.group.weight }}・定額 {{ fmt(data.group.points) }} 點（下限 {{ fmt(data.group.lower) }}、上限 {{ fmt(data.group.upper) }}）</span>
    <span class="text-xs text-slate-500">{{ data.group.basis }}</span>
    <span v-if="data.exempt" class="text-xs font-medium text-slate-700">不適用 DRG：{{ data.exempt }}（照實申報）</span>
    <span v-else class="tabular text-xs" :class="data.alert.level === 'over' ? 'font-semibold text-red-700' : data.alert.level === 'near' ? 'font-medium text-amber-800' : 'text-slate-600'">
      目前 {{ fmt(data.actual) }} 點（上限的 {{ data.alert.pct }}%）・照現在給付 {{ fmt(data.pay) }} 點（{{ data.payRuleLabel }}）<template v-if="data.diff">，{{ data.diff > 0 ? '盈' : '虧' }} {{ fmt(Math.abs(data.diff)) }}</template>
    </span>
  </div>
</template>
