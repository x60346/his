<script setup lang="ts">
// 病人重要標記：隔離中（類別與原因）、DNR（部分 DNR 寫出不做哪些，滑過去看照常施行的）。
// 病人資訊列、護理站清單、床位圖、病房總覽共用；compact 只顯示類別（清單一行放得下）
import { ISOLATION_KIND_LABEL, type PatientFlags } from '@/services'
import type { IsolationKind } from '@/types'

defineProps<{ flags?: PatientFlags; compact?: boolean }>()
const tone: Record<IsolationKind, string> = {
  contact: 'bg-amber-100 text-amber-900 ring-amber-600/40',
  droplet: 'bg-sky-100 text-sky-900 ring-sky-600/40',
  airborne: 'bg-red-600 text-white ring-red-700',
}
</script>

<template>
  <span v-if="flags && (flags.isolations.length || flags.dnr)" class="inline-flex flex-wrap gap-1">
    <span
      v-for="(i, k) in flags.isolations"
      :key="k"
      :class="['inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-semibold ring-1 ring-inset', tone[i.kind]]"
      :title="`${ISOLATION_KIND_LABEL[i.kind]}：${i.organism}（${i.since.slice(0, 10)} 起）`"
    >{{ ISOLATION_KIND_LABEL[i.kind] }}<template v-if="!compact">：{{ i.organism }}</template></span>
    <span
      v-if="flags.dnr"
      class="inline-flex items-center whitespace-nowrap rounded bg-slate-800 px-1.5 py-0.5 text-xs font-semibold text-white"
      :title="flags.dnr.title"
    >{{ compact ? (flags.dnr.label === 'DNR' ? 'DNR' : 'DNR（部分）') : flags.dnr.label }}</span>
  </span>
</template>
