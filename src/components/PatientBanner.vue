<script setup lang="ts">
// 病人資訊列：看診、批價、藥局、住院畫面頂端共用。過敏一律以紅色醒目顯示——這是病人安全的底線。
import { AlertTriangle } from 'lucide-vue-next'
import type { PatientBrief } from '@/services'
import { ageText } from '@/utils/date'
import { genderLabel } from '@/utils/labels'

defineProps<{ patient: PatientBrief }>()
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 shadow-sm">
    <div class="flex items-baseline gap-2">
      <span class="text-lg font-bold text-slate-800">{{ patient.patientName }}</span>
      <span class="text-sm text-slate-500">{{ genderLabel[patient.gender] }}・{{ patient.birthDate ? ageText(patient.birthDate) : '' }}</span>
    </div>
    <div class="text-sm text-slate-600">病歷號 <span class="tabular font-medium text-slate-800">{{ patient.chartNo }}</span></div>
    <div class="text-sm text-slate-600">生日 <span class="tabular">{{ patient.birthDate }}</span></div>
    <slot />
    <div
      :class="[
        'ml-auto flex items-center gap-1.5 rounded px-2 py-1 text-sm',
        patient.allergies.length ? 'bg-red-50 font-medium text-red-700 ring-1 ring-inset ring-red-600/20' : 'text-slate-500',
      ]"
    >
      <AlertTriangle v-if="patient.allergies.length" class="h-4 w-4" />
      過敏：{{ patient.allergies.length ? patient.allergies.join('、') : '無已知過敏' }}
      <!-- 看診頁在這裡放「＋過敏」（當場新增）；其他頁面不放，只顯示 -->
      <slot name="allergy-actions" />
    </div>
  </div>
</template>
