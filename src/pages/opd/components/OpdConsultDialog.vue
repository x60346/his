<script setup lang="ts">
// 回覆門診會診（被會診那科的醫師）：看這次看診的摘要（主訴、評估、診斷、處方、生命徵象、過敏），寫評估與建議；
// 要當面看診的勾「建議掛本科門診」（病人另外掛號）。書面會診，病人不必在場、不收費。規則在 consult.answerConsult。
import { reactive, watch } from 'vue'
import { UBadge, UButton, UCheckbox, UDialog, UTextarea } from '@/components/ui'
import { consultApi, type IncomingOpdConsult } from '@/services'
import { useAction } from '@/composables/useService'
import { ageText } from '@/utils/date'

const props = defineProps<{ item: IncomingOpdConsult | null }>()
const emit = defineEmits<{ close: [] }>()
const form = reactive({ findings: '', recommendation: '', suggestVisit: false })
const save = useAction(consultApi.answerConsult, { success: (c) => `已回覆 ${c.fromDeptName} 的門診會診${c.suggestVisit ? '（建議掛本科門診）' : ''}` })
watch(
  () => props.item?.consult.id,
  (v) => {
    if (!v) return
    Object.assign(form, { findings: '', recommendation: '', suggestVisit: false })
    save.fieldErrors.value = {}
  },
  { immediate: true },
)
async function submit() {
  if (props.item && (await save.run(props.item.consult.id, { ...form }))) emit('close')
}
</script>

<template>
  <UDialog :model-value="!!item" :title="`門診會診：${item?.summary.patientName ?? ''}`" size="lg" @update:model-value="(v: boolean) => !v && emit('close')">
    <div v-if="item" class="space-y-3 text-sm">
      <div class="rounded-md bg-amber-50 px-3 py-2">
        <div class="flex flex-wrap items-center gap-2 font-medium text-slate-800">
          {{ item.consult.fromDeptName }} {{ item.consult.fromDoctorName }} → {{ item.consult.toDeptName }}<template v-if="item.consult.toDoctorName">（指定 {{ item.consult.toDoctorName }}）</template>
          <UBadge v-if="item.consult.urgent" tone="red">急會診</UBadge>
          <UBadge v-if="item.overdue" tone="yellow">逾期（{{ item.consult.requestedAt.slice(5, 10) }} 申請）</UBadge>
          <span class="text-xs font-normal text-slate-500">{{ item.consult.requestedAt.slice(5, 16) }} 申請</span>
        </div>
        <div class="mt-1 text-slate-800">{{ item.consult.question }}</div>
      </div>
      <section class="space-y-1 rounded-md border border-slate-200 px-3 py-2">
        <div class="font-medium text-slate-800">{{ item.summary.patientName }} {{ item.summary.chartNo }}（{{ item.summary.gender === 'M' ? '男' : '女' }}・{{ ageText(item.summary.birthDate) }}）・{{ item.summary.date }} {{ item.summary.deptName }} {{ item.summary.doctorName }}</div>
        <div v-if="item.summary.allergies.length" class="text-xs text-red-700">過敏：{{ item.summary.allergies.join('、') }}</div>
        <div v-if="item.summary.vitals" class="tabular text-xs text-slate-600">生命徵象：{{ item.summary.vitals }}</div>
        <div v-if="item.summary.subjective" class="text-xs text-slate-600">S：{{ item.summary.subjective }}</div>
        <div v-if="item.summary.objective" class="text-xs text-slate-600">O：{{ item.summary.objective }}</div>
        <div v-if="item.summary.assessment" class="text-xs text-slate-600">A：{{ item.summary.assessment }}</div>
        <div class="text-xs text-slate-600">診斷：{{ item.summary.diagnoses.join('、') || '—' }}</div>
        <div class="text-xs text-slate-600">處方：{{ item.summary.medications.join('、') || '無' }}</div>
      </section>
      <UTextarea v-model="form.findings" label="評估（看診所見）" required :rows="3" :error="save.fieldErrors.value.findings" />
      <UTextarea v-model="form.recommendation" label="建議" required :rows="2" placeholder="例：眼底未見出血，一年追蹤一次即可" :error="save.fieldErrors.value.recommendation" />
      <UCheckbox v-model="form.suggestVisit" :label="`建議病人掛${item.consult.toDeptName}門診（要當面看診）`" />
    </div>
    <template #footer>
      <UButton variant="secondary" @click="emit('close')">取消</UButton>
      <UButton :loading="save.pending.value" @click="submit">送出回覆</UButton>
    </template>
  </UDialog>
</template>
