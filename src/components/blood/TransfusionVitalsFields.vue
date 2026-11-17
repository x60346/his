<script setup lang="ts">
// 輸血的生命徵象（體溫、脈搏、血壓）：開始前、15 分鐘、結束、輸血反應共用。範圍檢查在服務層（和生命徵象分頁同一份 vitalInputProblem）
import { UInput } from '@/components/ui'
import type { TransfusionVitalsInput } from '@/services'

const model = defineModel<TransfusionVitalsInput>({ required: true })
defineProps<{ errors?: Record<string, string>; title?: string }>()
const set = (k: keyof TransfusionVitalsInput, v: unknown) => (model.value = { ...model.value, [k]: v === '' || v === null || v === undefined ? undefined : Number(v) })
</script>

<template>
  <fieldset class="rounded-md border border-slate-200 px-3 pb-3 pt-1">
    <legend class="px-1 text-sm font-medium text-slate-700">{{ title ?? '生命徵象' }}</legend>
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <UInput :model-value="model.temp" type="number" step="0.1" label="體溫 °C" :error="errors?.temp" @update:model-value="(v) => set('temp', v)" />
      <UInput :model-value="model.pulse" type="number" label="脈搏" :error="errors?.pulse" @update:model-value="(v) => set('pulse', v)" />
      <UInput :model-value="model.sbp" type="number" label="收縮壓" :error="errors?.sbp" @update:model-value="(v) => set('sbp', v)" />
      <UInput :model-value="model.dbp" type="number" label="舒張壓" :error="errors?.dbp" @update:model-value="(v) => set('dbp', v)" />
    </div>
  </fieldset>
</template>
