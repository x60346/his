<script setup lang="ts">
// 開會診單（病人目前科別的醫師）：選科別、可指定醫師（不指定＝該科任一位都能回覆）、會診目的、急會診。
// 會診不等於轉科：多數只要對方的建議；對方回覆時可以「建議轉本科」，再由這裡一鍵申請轉科。
// 門診也用這個（傳 visit）：書面會診，病人不必另外掛號（consult.requestOpdConsult）。
import { computed, reactive, watch } from 'vue'
import { UButton, UCheckbox, UDialog, USelect, UTextarea } from '@/components/ui'
import { consultApi, masterApi, type AdmissionView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ admission?: AdmissionView; visit?: { id: string; deptId: string; patientName: string } }>()

const form = reactive({ toDeptId: '' as string | number | undefined, toDoctorId: '' as string | number | undefined, question: '', urgent: false })
const save = useAction(
  (input: Parameters<typeof consultApi.requestConsult>[1]) => (props.visit ? consultApi.requestOpdConsult(props.visit.id, input) : consultApi.requestConsult(props.admission!.id, input)),
  { success: (c) => `已送出${c.urgent ? '急' : ''}會診：${c.toDeptName}` },
)
watch(
  open,
  (v) => {
    if (!v) return
    Object.assign(form, { toDeptId: '', toDoctorId: '', question: '', urgent: false })
    save.fieldErrors.value = {}
  },
  { immediate: true },
)
const { data: depts } = useQuery(() => masterApi.listDepartments())
const { data: doctors } = useQuery(() => masterApi.listDoctors())
const deptOptions = computed(() => (depts.value ?? []).filter((d) => d.active && d.id !== (props.visit?.deptId ?? props.admission?.deptId)).map((d) => ({ label: d.name, value: d.id })))
const doctorOptions = computed(() => [
  { label: '不指定（該科任一位醫師都可以回覆）', value: '' },
  ...(doctors.value ?? []).filter((d) => d.active && d.deptId === form.toDeptId).map((d) => ({ label: `${d.name} ${d.title}`, value: d.id })),
])
function onDept(v: string | number | undefined) {
  form.toDeptId = v
  form.toDoctorId = ''
}
async function submit() {
  if (!props.admission && !props.visit) return
  const ok = await save.run({ toDeptId: String(form.toDeptId ?? ''), ...(form.toDoctorId ? { toDoctorId: String(form.toDoctorId) } : {}), question: form.question, urgent: form.urgent })
  if (ok) open.value = false
}
</script>

<template>
  <UDialog v-model="open" :title="`${visit ? '門診會診' : '會診'}：${visit?.patientName ?? admission?.patientName ?? ''}`" size="sm" @submit="submit">
    <div v-if="admission || visit" class="space-y-3 text-sm">
      <USelect :model-value="form.toDeptId" label="會診科別" required placeholder="請選擇" :options="deptOptions" :error="save.fieldErrors.value.toDeptId" @update:model-value="onDept" />
      <USelect v-model="form.toDoctorId" label="指定醫師" :options="doctorOptions" :disabled="!form.toDeptId" :error="save.fieldErrors.value.toDoctorId" />
      <UTextarea v-model="form.question" label="會診目的（想請對方評估什麼）" required :rows="3" placeholder="例：左下肢腫脹，請評估是否深部靜脈栓塞" :error="save.fieldErrors.value.question" />
      <UCheckbox v-model="form.urgent" label="急會診（對方首頁待辦標紅、排最前面）" />
      <p v-if="visit" class="text-xs text-slate-500">書面會診：病人不必另外掛號、不收費。會診醫師看這次看診的主訴、評估、診斷、處方、生命徵象；要當面看診會建議病人掛該科門診。</p>
      <p v-else class="text-xs text-slate-500">會診醫師看到的是會診單附上的病人摘要（診斷、執行中醫囑、最新生命徵象、最近的病程紀錄）。申請與回覆都會寫進病程紀錄。</p>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton type="submit" :loading="save.pending.value">送出會診</UButton>
    </template>
  </UDialog>
</template>
