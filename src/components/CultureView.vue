<script setup lang="ts">
// 細菌培養報告（唯讀）：檢體、每株菌與藥敏表（S 敏感、I 中等、R 抗藥）；多重抗藥菌標紅。檢驗頁、病歷檢驗共用
import { UBadge } from '@/components/ui'
import { astName, mdroOf, organismName, specimenLabel } from '@/services'
import type { LabReport } from '@/types'

defineProps<{ culture: NonNullable<LabReport['culture']> }>()
const sirTone = { S: 'text-emerald-700', I: 'text-amber-700', R: 'font-semibold text-red-700' } as const
</script>

<template>
  <div class="space-y-2 text-sm">
    <p class="text-slate-600">檢體：{{ specimenLabel(culture.specimen) }}<template v-if="!culture.isolates.length">・<b class="text-emerald-700">無菌生長</b></template></p>
    <div v-for="(x, i) in culture.isolates" :key="i" class="rounded border border-slate-200 p-2">
      <div class="flex flex-wrap items-center gap-2"><b>{{ organismName(x.organism) }}</b><UBadge v-if="mdroOf(x)" tone="red">{{ mdroOf(x) }}</UBadge></div>
      <div v-if="Object.keys(x.ast).length" class="tabular mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
        <span v-for="(v, k) in x.ast" :key="k">{{ astName(String(k)) }} <b :class="sirTone[v]">{{ v }}</b></span>
      </div>
      <p v-else class="mt-1 text-xs text-slate-500">不做細菌藥敏</p>
    </div>
  </div>
</template>
