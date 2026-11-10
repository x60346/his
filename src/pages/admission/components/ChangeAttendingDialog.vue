<script setup lang="ts">
// 變更主治醫師：醫師離職、休假交班時，把住院中（或預約住院）的病人交給同科另一位在職醫師。
// 只列得出「同科、在職、不是目前主治」的醫師；變更原因必填並留下紀錄（attendingHistory、稽核）。
// 已開立的醫囑不會改——醫囑記的是當時誰開的，那是歷史，不是「現在誰負責」。
import { reactive, watch } from 'vue'
import { UButton, UDialog, USelect, UTextarea } from '@/components/ui'
import { admissionApi, type AdmissionView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ admission?: AdmissionView }>()

const form = reactive({ doctorId: '' as string | number | undefined, reason: '' })
watch(open, (v) => {
  if (v) Object.assign(form, { doctorId: '', reason: '' })
  save.fieldErrors.value = {}
})

const { data: candidates } = useQuery(
  async () => (props.admission ? admissionApi.listAttendingCandidates(props.admission.id) : []),
  [() => props.admission?.id],
)
const presets = ['醫師離職', '醫師休假', '病情需要', '病人要求']

const save = useAction(admissionApi.changeAttending, { success: (a) => `${a.patientName} 的主治醫師已改為 ${a.doctorName}` })
async function submit() {
  if (!props.admission) return
  if (await save.run(props.admission.id, String(form.doctorId ?? ''), form.reason)) open.value = false
}
</script>

<template>
  <UDialog v-model="open" :title="`變更主治醫師：${admission?.patientName ?? ''}`" size="sm">
    <div v-if="admission" class="space-y-3 text-sm">
      <p class="rounded-md bg-slate-50 px-3 py-2 text-slate-700">
        目前：{{ admission.deptName }}・<b>{{ admission.doctorName }}</b>
        <span class="text-slate-500">（{{ admission.admitNo ? `住院號 ${admission.admitNo}` : '預約住院' }}）</span>
      </p>
      <USelect
        v-model="form.doctorId"
        label="新的主治醫師"
        required
        placeholder="請選擇"
        :options="(candidates ?? []).map((d) => ({ label: `${d.name} ${d.title}`, value: d.id }))"
        :hint="candidates && !candidates.length ? `${admission.deptName}沒有其他在職醫師可以接手（跨科請辦理轉科）` : '只列出同科、在職的醫師'"
        :error="save.fieldErrors.value.doctorId"
      />
      <div class="flex flex-wrap gap-1.5">
        <UButton v-for="p in presets" :key="p" size="sm" variant="secondary" @click="form.reason = p">{{ p }}</UButton>
      </div>
      <UTextarea v-model="form.reason" label="變更原因" required :rows="2" :error="save.fieldErrors.value.reason" />
      <p class="text-xs text-slate-500">已開立的醫囑與病程紀錄不會改變（仍記錄原開立醫師）；之後的醫囑由新的主治醫師開立。</p>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :loading="save.pending.value" @click="submit">確認變更</UButton>
    </template>
  </UDialog>
</template>
