<script setup lang="ts">
// 補登、更正或取消掛號上的外院轉診單（掛號清單「轉診單」）：還沒批價才行，判斷在服務層（referral.setReferralIn）
import { reactive, watch } from 'vue'
import { UButton, UDialog } from '@/components/ui'
import ReferralInForm from './ReferralInForm.vue'
import { referralApi, type ReferralInInput, type VisitView } from '@/services'
import { useAction } from '@/composables/useService'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ visit?: VisitView }>()
const emit = defineEmits<{ saved: [] }>()
const form = reactive<ReferralInInput>({ fromHospital: '', issuedOn: '', diagnosis: '', purpose: '' })
watch(open, (o) => {
  if (!o) return
  const r = props.visit?.referralIn
  Object.assign(form, { fromHospital: r?.fromHospital ?? '', issuedOn: r?.issuedOn ?? '', diagnosis: r?.diagnosis ?? '', purpose: r?.purpose ?? '' })
})
const save = useAction(referralApi.setReferralIn, { success: (r) => (r.referralIn ? `已登錄轉診單（${r.referralIn.fromHospital}）：基本部分負擔改收經轉診的金額` : '已取消轉診單') })
async function submit() {
  if (props.visit && (await save.run(props.visit.id, { ...form }))) {
    open.value = false
    emit('saved')
  }
}
async function remove() {
  if (props.visit && (await save.run(props.visit.id, null))) {
    open.value = false
    emit('saved')
  }
}
</script>

<template>
  <UDialog v-model="open" :title="visit?.referralIn ? '更正轉診單' : '補登轉診單'" size="lg" @submit="submit">
    <p class="mb-3 text-sm text-slate-600">{{ visit?.patientName }}（{{ visit?.deptName }} 第 {{ visit?.seqNo }} 號）・持外院轉診單就醫，基本部分負擔收經轉診的金額<template v-if="visit?.referralIn?.inheritedFrom">（這次是同一療程的回診，沿用轉診身分）</template></p>
    <ReferralInForm v-model="form" :visit-date="visit?.date" :errors="save.fieldErrors.value" />
    <template #footer>
      <UButton v-if="visit?.referralIn" variant="ghost" class="mr-auto" :loading="save.pending.value" @click="remove">取消轉診</UButton>
      <UButton variant="secondary" @click="open = false">關閉</UButton>
      <UButton type="submit" :loading="save.pending.value">儲存</UButton>
    </template>
  </UDialog>
</template>
