<script setup lang="ts">
// 一張病床。顏色表示狀態；選床模式下，可選的空床會亮起（符合希望床等的更明顯）。
import { computed } from 'vue'
import { BedDouble, Sparkles, User } from 'lucide-vue-next'
import type { BedView } from '@/services/admission'
import { ageText, diffDays, today } from '@/utils/date'
import { bedStatus } from '@/utils/labels'

const props = defineProps<{
  bed: BedView
  doctorName?: string
  selected?: boolean
  /** 選床模式：這張床可以選 */
  pickable?: boolean
  /** 選床模式：床等符合病人希望 */
  preferred?: boolean
  /** 選床模式中，不可選的床淡化 */
  dimmed?: boolean
}>()

const tone = {
  empty: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  occupied: 'border-blue-300 bg-blue-50 text-blue-900',
  cleaning: 'border-slate-300 bg-slate-100 text-slate-600',
  reserved: 'border-amber-300 bg-amber-50 text-amber-900',
}

const days = computed(() => (props.bed.admission?.admittedAt ? diffDays(props.bed.admission.admittedAt, today()) + 1 : 0))
</script>

<template>
  <button
    :class="[
      'relative flex h-24 flex-col rounded-md border-2 p-2 text-left text-xs transition',
      tone[bed.status],
      selected && 'ring-2 ring-brand-500 ring-offset-1',
      pickable && 'cursor-pointer hover:scale-[1.03] hover:shadow-md',
      pickable && preferred && 'ring-2 ring-emerald-500 ring-offset-1',
      dimmed && 'opacity-35',
    ]"
  >
    <div class="flex items-center justify-between">
      <span class="tabular text-sm font-bold">{{ bed.bedNo }}</span>
      <span class="text-[10px] opacity-80">{{ bed.bedClass }}</span>
    </div>
    <template v-if="bed.status === 'occupied' && bed.patient">
      <div class="mt-1 flex items-center gap-1 text-sm font-semibold"><User class="h-3.5 w-3.5" />{{ bed.patient.patientName }}</div>
      <div class="opacity-80">{{ bed.patient.gender === 'M' ? '男' : '女' }} {{ ageText(bed.patient.birthDate) }}・第 {{ days }} 天</div>
      <div class="flex items-center gap-1 truncate opacity-70">
        <span class="truncate">{{ doctorName }}</span>
        <!-- 醫師已簽署出院病摘：住院中心一眼看到誰可以辦出院 -->
        <span v-if="bed.admission?.dischargeSummary?.signedAt" class="ml-auto shrink-0 rounded bg-emerald-600 px-1 text-[10px] font-medium text-white opacity-100">准出院</span>
      </div>
    </template>
    <div v-else class="mt-auto flex items-center gap-1 font-medium">
      <Sparkles v-if="bed.status === 'cleaning'" class="h-3.5 w-3.5" />
      <BedDouble v-else class="h-3.5 w-3.5" />
      {{ bedStatus[bed.status].label }}<template v-if="bed.status === 'reserved' && bed.reservedForName">：{{ bed.reservedForName }}</template>
      <span v-if="pickable && bed.status === 'reserved'" class="ml-auto rounded bg-emerald-600 px-1 text-[10px] text-white">保留給此病人</span>
      <span v-else-if="pickable && preferred" class="ml-auto rounded bg-emerald-600 px-1 text-[10px] text-white">符合床等</span>
    </div>
  </button>
</template>
