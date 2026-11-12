<script setup lang="ts">
// 申請轉科（原科醫師）：選要轉入的科別，可指定接手醫師（不指定＝該科任一位醫師都能接），原因必填。
// 申請後病人仍歸原科，等新科醫師接受；接受前可以撤回。
import { computed, reactive, watch } from 'vue'
import { UButton, UDialog, USelect, UTextarea } from '@/components/ui'
import { admissionApi, masterApi, type AdmissionView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ admission?: AdmissionView }>()

const form = reactive({ toDeptId: '' as string | number | undefined, toDoctorId: '' as string | number | undefined, reason: '' })
watch(open, (v) => {
  if (v) Object.assign(form, { toDeptId: '', toDoctorId: '', reason: '' })
  save.fieldErrors.value = {}
})
const { data: depts } = useQuery(() => masterApi.listDepartments())
const { data: doctors } = useQuery(() => masterApi.listDoctors())
const deptOptions = computed(() => (depts.value ?? []).filter((d) => d.id !== props.admission?.deptId).map((d) => ({ label: d.name, value: d.id })))
const doctorOptions = computed(() => [
  { label: '不指定（該科任一位醫師都可以接）', value: '' },
  ...(doctors.value ?? []).filter((d) => d.active && d.deptId === form.toDeptId).map((d) => ({ label: `${d.name} ${d.title}`, value: d.id })),
])
// 換科別時，指定的醫師清掉（不能留著別科的醫師）——在選單事件裡處理，不用 watch
function onDept(v: string | number | undefined) {
  form.toDeptId = v
  form.toDoctorId = ''
}

const save = useAction(admissionApi.requestDeptTransfer, { success: (a) => `已申請轉${a.lastTransfer?.toDeptName}：等該科醫師接受` })
async function submit() {
  if (!props.admission) return
  const ok = await save.run(props.admission.id, { toDeptId: String(form.toDeptId ?? ''), ...(form.toDoctorId ? { toDoctorId: String(form.toDoctorId) } : {}), reason: form.reason })
  if (ok) open.value = false
}
</script>

<template>
  <UDialog v-model="open" :title="`申請轉科：${admission?.patientName ?? ''}`" size="sm">
    <div v-if="admission" class="space-y-3 text-sm">
      <p class="rounded-md bg-slate-50 px-3 py-2 text-slate-700">目前：{{ admission.deptName }}・<b>{{ admission.doctorName }}</b>・{{ admission.bed?.bedNo }}</p>
      <USelect :model-value="form.toDeptId" label="轉入科別" required placeholder="請選擇" :options="deptOptions" :error="save.fieldErrors.value.toDeptId" @update:model-value="onDept" />
      <USelect v-model="form.toDoctorId" label="指定接手醫師" :options="doctorOptions" :disabled="!form.toDeptId" :error="save.fieldErrors.value.toDoctorId" />
      <UTextarea v-model="form.reason" label="轉科原因（新科醫師會看到）" required :rows="2" placeholder="例：急性期已穩定，轉復健科接續住院復健" :error="save.fieldErrors.value.reason" />
      <p class="text-xs text-slate-500">新科醫師接受前，病人仍由您負責（醫囑照常開立）；期間不能變更主治、不能准予出院。新科接受時會逐筆決定醫囑延續或停止，也可以一併轉床。</p>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :loading="save.pending.value" @click="submit">送出申請</UButton>
    </template>
  </UDialog>
</template>
