<script setup lang="ts">
// 歷史病歷：顯示過去的診斷與處方，可一鍵帶入本次（慢性病回診最常用）。
// 「同此次」帶診斷、藥品、處置、A、P；「只帶處方」只帶藥品。合併規則在看診頁的 mergeIntoDraft，這裡只送出事件。
import { Copy } from 'lucide-vue-next'
import { UButton, UEmpty } from '@/components/ui'
import { doseUnitOf, TIMING_SHORT } from '@/services'
import type { HistoryItem } from '@/services/opd'
import type { Drug } from '@/types'

defineProps<{ items: HistoryItem[]; drugs: Map<string, Drug>; readonly?: boolean; busy?: boolean }>()
defineEmits<{ copy: [item: HistoryItem, only?: 'medications'] }>()
</script>

<template>
  <UEmpty v-if="!items.length" title="沒有歷史病歷" description="這是病人在本院的第一次就診" />
  <ol v-else class="space-y-3">
    <li v-for="h in items" :key="h.id" class="rounded-md border border-slate-200 p-3 text-sm">
      <div class="mb-2 flex items-center gap-2">
        <span class="tabular font-semibold text-slate-800">{{ h.date }}</span>
        <span class="text-slate-500">{{ h.deptName }}・{{ h.doctorName }}</span>
        <!-- 慢箋領藥不是看診：照原處方調劑，標出來醫師才不會以為病人那天有回診 -->
        <span v-if="h.refillSeq" class="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-800">慢箋第 {{ h.refillSeq }} 次領藥（未看診）</span>
        <span v-if="!readonly" class="ml-auto flex shrink-0 gap-1">
          <UButton size="sm" variant="secondary" :icon="Copy" :loading="busy" @click="$emit('copy', h)">同此次</UButton>
          <UButton v-if="h.medications.length" size="sm" variant="ghost" :loading="busy" @click="$emit('copy', h, 'medications')">只帶處方</UButton>
        </span>
      </div>
      <div class="text-slate-700">
        <span class="text-slate-500">診斷：</span>{{ h.diagnoses.map((d) => `${d.icd} ${d.name}`).join('、') }}
      </div>
      <div v-if="h.assessment" class="text-slate-700"><span class="text-slate-500">評估：</span>{{ h.assessment }}</div>
      <div v-if="h.plan" class="text-slate-700"><span class="text-slate-500">計畫：</span>{{ h.plan }}</div>
      <div v-if="h.procedures.length" class="text-slate-700"><span class="text-slate-500">處置：</span>{{ h.procedureNames.join('、') }}</div>
      <ul v-if="h.medications.length" class="mt-1.5 space-y-0.5 rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-600">
        <li v-for="m in h.medications" :key="m.drugId" class="tabular">
          {{ drugs.get(m.drugId)?.name ?? m.drugId }}　{{ m.dose }} {{ drugs.get(m.drugId) ? doseUnitOf(drugs.get(m.drugId)!) : '' }} {{ m.freq }}<template v-if="m.timing">（{{ TIMING_SHORT[m.timing] }}）</template> {{ m.route }} × {{ m.days }} 天（{{ m.qty }}）
        </li>
      </ul>
    </li>
  </ol>
</template>
