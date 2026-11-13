<script setup lang="ts">
// 申請轉科（原科醫師）：選要轉入的科別，可指定接手醫師（不指定＝該科任一位醫師都能接），原因必填。
// 申請後病人仍歸原科，等新科醫師接受；接受前可以撤回。
// 轉出摘要（住院經過、目前問題必填，待追蹤選填）：新科決定接不接之前就看得到，也寫進病程紀錄。
// 從會診「建議轉本科」打開時（fromConsult）：科別、醫師、原因都帶好，申請記下是依哪張會診。
import { computed, reactive, watch } from 'vue'
import { UButton, UDialog, USelect, UTextarea } from '@/components/ui'
import { admissionApi, masterApi, type AdmissionView, type ConsultView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ admission?: AdmissionView; fromConsult?: ConsultView }>()

const form = reactive({ toDeptId: '' as string | number | undefined, toDoctorId: '' as string | number | undefined, reason: '', course: '', problems: '', pending: '' })
const save = useAction(admissionApi.requestDeptTransfer, { success: (a) => `已申請轉${a.lastTransfer?.toDeptName}：等該科醫師接受` })
// 打開時重設（從會診打開就帶入會診建議）；放在 save 之後：immediate 會用到它
watch(
  open,
  (v) => {
    if (!v) return
    const c = props.fromConsult
    Object.assign(form, {
      toDeptId: c?.toDeptId ?? '', toDoctorId: c?.answeredBy ?? '', reason: c ? `依${c.toDeptName}會診建議（${c.answeredByName}）：${c.recommendation}` : '',
      course: '', problems: '', pending: '',
    })
    save.fieldErrors.value = {}
  },
  { immediate: true },
)
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

async function submit() {
  if (!props.admission) return
  const ok = await save.run(props.admission.id, {
    toDeptId: String(form.toDeptId ?? ''), ...(form.toDoctorId ? { toDoctorId: String(form.toDoctorId) } : {}), reason: form.reason,
    course: form.course, problems: form.problems, pending: form.pending, ...(props.fromConsult ? { consultId: props.fromConsult.id } : {}),
  })
  if (ok) open.value = false
}
</script>

<template>
  <UDialog v-model="open" :title="`申請轉科：${admission?.patientName ?? ''}`" size="md">
    <div v-if="admission" class="space-y-3 text-sm">
      <p class="rounded-md bg-slate-50 px-3 py-2 text-slate-700">目前：{{ admission.deptName }}・<b>{{ admission.doctorName }}</b>・{{ admission.bed?.bedNo }}</p>
      <USelect :model-value="form.toDeptId" label="轉入科別" required placeholder="請選擇" :options="deptOptions" :error="save.fieldErrors.value.toDeptId" @update:model-value="onDept" />
      <USelect v-model="form.toDoctorId" label="指定接手醫師" :options="doctorOptions" :disabled="!form.toDeptId" :error="save.fieldErrors.value.toDoctorId" />
      <p v-if="fromConsult" class="rounded-md bg-sky-50 px-3 py-2 text-xs text-sky-900">依 {{ fromConsult.toDeptName }} {{ fromConsult.answeredByName }} 的會診建議（{{ fromConsult.answeredAt?.slice(5) }}）：{{ fromConsult.findings }}</p>
      <UTextarea v-model="form.reason" label="轉科原因（新科醫師會看到）" required :rows="2" placeholder="例：急性期已穩定，轉復健科接續住院復健" :error="save.fieldErrors.value.reason" />
      <div class="space-y-2 rounded-md border border-slate-200 p-3">
        <div class="text-xs font-semibold text-slate-600">轉出摘要（新科接手要看，也寫進病程紀錄）</div>
        <UTextarea v-model="form.course" label="住院經過" required :rows="3" placeholder="入院原因、做過的檢查與治療、反應" :error="save.fieldErrors.value.course" />
        <UTextarea v-model="form.problems" label="目前問題" required :rows="2" placeholder="還沒解決的問題、目前的狀態" :error="save.fieldErrors.value.problems" />
        <UTextarea v-model="form.pending" label="待追蹤事項（選填）" :rows="2" placeholder="例：明早抽血追蹤 K、等病理報告" />
      </div>
      <p class="text-xs text-slate-500">新科醫師接受前，病人仍由您負責（醫囑照常開立）；期間不能變更主治、不能准予出院。新科接受時會逐筆決定醫囑延續或停止，也可以一併轉床。</p>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :loading="save.pending.value" @click="submit">送出申請</UButton>
    </template>
  </UDialog>
</template>
