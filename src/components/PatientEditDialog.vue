<script setup lang="ts">
// 病患建檔／修改對話框。掛號頁（初診建檔、讀卡）與病患資料頁共用。
import { clonePlain } from '@/utils/clone'
import { ref, watch } from 'vue'
import { UButton, UDialog } from '@/components/ui'
import PatientForm from './PatientForm.vue'
import { patientApi } from '@/services'
import type { PatientInput } from '@/services/patient'
import { useAction } from '@/composables/useService'
import type { Patient } from '@/types'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{
  /** 有值＝修改；沒有＝新增 */
  patient?: Patient | null
  /** 新增時預先帶入的資料（例如健保卡讀到的姓名、生日、身分證） */
  prefill?: Partial<PatientInput>
}>()
const emit = defineEmits<{ saved: [patient: Patient] }>()

const empty = (): PatientInput => ({
  name: '', gender: 'M', birthDate: '', idNo: '', phone: '', address: '', bloodType: '', allergies: [], familyHistory: [],
  smoking: false, betelNut: false, defaultIdentity: '01', emergencyContact: '', emergencyPhone: '', note: '',
})

const form = ref<PatientInput>(empty())
const submitted = ref(false)
const formRef = ref<InstanceType<typeof PatientForm>>()

// 每次打開都重新初始化：修改時複製一份，不直接改傳進來的物件
watch(open, (v) => {
  if (!v) return
  submitted.value = false
  save.fieldErrors.value = {}
  if (props.patient) {
    const { id: _id, chartNo: _c, createdAt: _t, ...rest } = props.patient
    form.value = clonePlain(rest)
  } else {
    form.value = { ...empty(), ...clonePlain(props.prefill ?? {}) }
  }
})

const save = useAction(
  (input: PatientInput) => (props.patient ? patientApi.updatePatient(props.patient.id, input) : patientApi.createPatient(input)),
  { success: (p) => (props.patient ? `已更新 ${p.name} 的資料` : `建檔完成：病歷號 ${p.chartNo}`) },
)

// 使用者一修改內容，服務層回傳的舊錯誤就失效（那是針對上一次送出的資料）
watch(form, () => (save.fieldErrors.value = {}), { deep: true })

async function submit() {
  submitted.value = true
  // 本地檢查沒過就不送出，省一次往返；但服務層仍會再檢查一次
  if (!formRef.value?.isValid()) return
  const p = await save.run(form.value)
  if (p) {
    emit('saved', p)
    open.value = false
  }
}
</script>

<template>
  <UDialog v-model="open" :title="patient ? `修改病患資料：${patient.chartNo}` : '初診建檔'" size="xl" persistent>
    <form id="patient-form" @submit.prevent="submit">
      <PatientForm ref="formRef" v-model="form" :server-errors="save.fieldErrors.value" :submitted="submitted" />
    </form>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton type="submit" form="patient-form" :loading="save.pending.value">{{ patient ? '儲存' : '建檔' }}</UButton>
    </template>
  </UDialog>
</template>
