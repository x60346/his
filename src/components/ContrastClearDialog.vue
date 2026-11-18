<script setup lang="ts">
// 顯影劑過敏放行：醫師確認已開前置用藥（類固醇＋抗組織胺）並寫原因，這筆含顯影劑檢查才能報到。檢查室（放射科）、住院病人分頁共用
import { reactive, watch } from 'vue'
import { UButton, UCheckbox, UDialog, UTextarea } from '@/components/ui'
import { examApi } from '@/services'
import { useAction } from '@/composables/useService'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ examKey: string; subject: string }>()
const form = reactive({ reason: '', premed: false })
watch(open, (x) => x && Object.assign(form, { reason: '', premed: false }))
const save = useAction(examApi.clearContrastAllergy, { success: '已放行：檢查室可以報到' })
async function submit() {
  if (await save.run(props.examKey, { ...form })) open.value = false
}
</script>

<template>
  <UDialog v-model="open" title="顯影劑過敏放行" size="md">
    <div class="space-y-3 text-sm">
      <p>{{ subject }}</p>
      <UCheckbox v-model="form.premed" label="已開前置用藥（例：檢查前 13、7、1 小時 Prednisolone，1 小時前 Diphenhydramine）" />
      <p v-if="save.fieldErrors.value.premed" class="text-xs text-red-600">{{ save.fieldErrors.value.premed }}</p>
      <UTextarea v-model="form.reason" label="放行原因" :rows="2" placeholder="例：疑腹內膿瘍，非顯影檢查無法診斷；過去只有輕微蕁麻疹" :error="save.fieldErrors.value.reason" />
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :loading="save.pending.value" @click="submit">放行</UButton>
    </template>
  </UDialog>
</template>
