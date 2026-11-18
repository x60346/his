<script setup lang="ts">
// 住院病人的影像檢查（護理站、住院醫囑的病人分頁「檢查」）：排了哪些檢查、幾點、在哪一間、到哪一步；
// 檢查前後 30 分鐘內有還沒給的藥標出來（病人可能不在病房，要提早或延後給）；還沒排的列出來（等檢查室排程）
import { computed } from 'vue'
import { UBadge, UQueryState } from '@/components/ui'
import { EXAM_MAR_MARGIN, examApi } from '@/services'
import { useQuery } from '@/composables/useService'

const props = defineProps<{ admissionId: string }>()
const { data, loading } = useQuery(() => examApi.admissionExams(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const TONE = { scheduled: 'blue', arrived: 'yellow', done: 'green' } as const
</script>

<template>
  <UQueryState :loading="loading && !v" :ready="!!v">
    <div v-if="v" class="space-y-2 text-sm">
      <p v-if="!v.exams.length && !v.unscheduled.length" class="text-slate-400">沒有待做的影像檢查。</p>
      <ul v-if="v.exams.length" class="divide-y divide-slate-100 rounded border border-slate-200">
        <li v-for="e in v.exams" :key="e.id" class="space-y-0.5 px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="tabular font-semibold">{{ e.start.slice(5) }}–{{ e.end.slice(11) }}</span>
            <span>{{ e.procName }}・{{ e.roomName }}</span>
            <UBadge :tone="TONE[e.stage]" class="ml-auto">{{ e.stageLabel }}</UBadge>
          </div>
          <div v-if="e.marConflicts.length" class="text-xs font-medium text-amber-800">檢查前後 {{ EXAM_MAR_MARGIN }} 分鐘內有給藥：{{ e.marConflicts.map((t) => t.slice(11)).join('、') }}（病人可能不在病房，請提早或延後給）</div>
        </li>
      </ul>
      <p v-if="v.unscheduled.length" class="text-xs text-slate-600">等檢查室排程：{{ v.unscheduled.join('、') }}</p>
    </div>
  </UQueryState>
</template>
