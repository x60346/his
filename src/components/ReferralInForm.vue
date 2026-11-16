<script setup lang="ts">
// 外院轉診單的欄位（掛號表單、補登／更正對話框共用）：轉出院所、開單日期、轉診診斷、目的。
// 有效期即時提示用 referral-rules（和服務層同一份）；真正的檢查在服務層
import { computed } from 'vue'
import { UInput } from '@/components/ui'
import { referralInProblem, referralValidUntil, type ReferralInInput } from '@/services'

const model = defineModel<ReferralInInput>({ required: true })
const props = defineProps<{ visitDate?: string; errors?: Record<string, string> }>()
const dateHint = computed(() => {
  if (!model.value.issuedOn || !props.visitDate) return '90 天內有效'
  const p = referralInProblem(model.value.issuedOn, props.visitDate)
  return p ?? `有效到 ${referralValidUntil(model.value.issuedOn)}`
})
const dateBad = computed(() => !!model.value.issuedOn && !!props.visitDate && !!referralInProblem(model.value.issuedOn, props.visitDate))
</script>

<template>
  <div class="grid grid-cols-2 gap-3">
    <UInput v-model="model.fromHospital" label="轉出院所" placeholder="例：康健診所" required :error="errors?.fromHospital" />
    <UInput v-model="model.issuedOn" type="date" label="開單日期" required :hint="dateBad ? '' : dateHint" :error="errors?.issuedOn || (dateBad ? dateHint : '')" />
    <UInput v-model="model.diagnosis" class="col-span-2" label="轉診單上的診斷" placeholder="例：I10 高血壓（控制不佳）" required :error="errors?.diagnosis" />
    <UInput v-model="model.purpose" class="col-span-2" label="轉診目的（選填）" placeholder="例：進一步檢查" />
  </div>
</template>
