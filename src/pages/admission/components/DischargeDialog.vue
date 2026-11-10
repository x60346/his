<script setup lang="ts">
// 出院：選擇轉歸、填寫摘要。服務層會一併停止醫囑、清除未執行的給藥、病床改為清潔中。
import { reactive, watch } from 'vue'
import { UButton, UDialog, USelect, UTextarea } from '@/components/ui'
import { admissionApi, masterApi, type AdmissionView } from '@/services'
import { useAction } from '@/composables/useService'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ admission?: AdmissionView }>()

const form = reactive({ dischargeType: '治癒出院' as string | number | undefined, dischargeSummary: '' })
watch(open, (v) => {
  if (v) Object.assign(form, { dischargeType: '治癒出院', dischargeSummary: '' })
})

const discharge = useAction(admissionApi.discharge, { success: (a) => `${a.patientName} 已辦理出院，${a.bed?.bedNo ?? '病床'} 改為清潔中` })
async function submit() {
  if (!props.admission) return
  const ok = await discharge.run(props.admission.id, { dischargeType: String(form.dischargeType), dischargeSummary: form.dischargeSummary })
  if (ok) open.value = false
}
</script>

<template>
  <UDialog v-model="open" :title="`辦理出院：${admission?.patientName ?? ''}`" size="md">
    <div class="space-y-3 text-sm">
      <p class="text-slate-600">住院號 {{ admission?.admitNo }}・住院第 {{ admission?.days }} 天・{{ admission?.diagnosis }}</p>
      <USelect v-model="form.dischargeType" label="出院轉歸" :options="masterApi.staticCodes.dischargeTypes" />
      <UTextarea v-model="form.dischargeSummary" label="出院摘要" :rows="4" placeholder="住院經過、出院時狀況、出院後追蹤計畫" />
      <p class="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">出院後：所有醫囑停止、未執行的給藥排程刪除、病床改為「清潔中」。</p>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton variant="danger" :loading="discharge.pending.value" @click="submit">確認出院</UButton>
    </template>
  </UDialog>
</template>
