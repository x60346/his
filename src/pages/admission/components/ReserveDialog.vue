<script setup lang="ts">
// 新增住院預約（不經門診的情況，例如他院轉入、急診收治）。
import { computed, reactive, ref, watch } from 'vue'
import { UButton, UDialog, UInput, USearchSelect, USelect, UTextarea } from '@/components/ui'
import { admissionApi, masterApi, patientApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { addDays, ageText, today } from '@/utils/date'
import type { Bed, Patient } from '@/types'

const open = defineModel<boolean>({ default: false })

const patient = ref<Patient | null>(null)
const form = reactive({ deptId: '' as string | number | undefined, doctorId: '' as string | number | undefined, preferBedClass: '健保床' as Bed['bedClass'], diagnosis: '', reason: '', expectedDate: today() })

const { data: depts } = useQuery(() => masterApi.listDepartments())
const { data: doctors } = useQuery(() => masterApi.listDoctors())
const deptDoctors = computed(() => (doctors.value ?? []).filter((d) => d.deptId === form.deptId))
// 換科別時，主治醫師預設為該科第一位
watch(() => form.deptId, () => (form.doctorId = deptDoctors.value[0]?.id))

watch(open, (v) => {
  if (!v) return
  patient.value = null
  Object.assign(form, { deptId: 'D02', preferBedClass: '健保床', diagnosis: '', reason: '', expectedDate: today() })
})

const save = useAction(admissionApi.reserve, { success: (a) => `已建立住院預約（預計 ${a.expectedDate} 入院）` })
/** 還缺哪些必填：按鈕反灰時直接列出來，不讓人猜為什麼按不下去 */
const missing = computed(() => [!patient.value && '病人', !form.doctorId && '主治醫師', !form.diagnosis.trim() && '入院診斷'].filter(Boolean) as string[])
const canSave = computed(() => missing.value.length === 0)

async function submit() {
  if (!patient.value || !canSave.value) return
  const ok = await save.run({
    patientId: patient.value.id,
    deptId: String(form.deptId),
    doctorId: String(form.doctorId),
    preferBedClass: form.preferBedClass,
    diagnosis: form.diagnosis,
    reason: form.reason || form.diagnosis,
    expectedDate: form.expectedDate,
  })
  if (ok) open.value = false
}
</script>

<template>
  <UDialog v-model="open" title="新增住院預約" size="lg">
    <div class="grid grid-cols-2 gap-3">
      <div class="col-span-2">
        <USearchSelect
          label="病人"
          required
          placeholder="病歷號、姓名、身分證"
          :search="(kw) => patientApi.searchPatients(kw, 10)"
          :item-key="(p) => p.id"
          :item-label="(p) => `${p.chartNo}　${p.name}`"
          :item-sub="(p) => `${p.gender === 'M' ? '男' : '女'}・${ageText(p.birthDate)}`"
          :clear-on-select="false"
          @select="(p) => (patient = p)"
        />
        <p v-if="patient" class="mt-1 text-xs text-slate-500">
          已選：{{ patient.name }}（{{ patient.chartNo }}）<span v-if="patient.allergies.length" class="text-red-600">・過敏 {{ patient.allergies.join('、') }}</span>
        </p>
      </div>
      <USelect v-model="form.deptId" label="科別" :options="(depts ?? []).map((d) => ({ label: d.name, value: d.id }))" />
      <USelect v-model="form.doctorId" label="主治醫師" required :options="deptDoctors.map((d) => ({ label: `${d.name} ${d.title}`, value: d.id }))" />
      <USelect v-model="form.preferBedClass" label="希望床等" :options="['健保床', '雙人房', '單人房']" />
      <UInput v-model="form.expectedDate" label="預計入院日" type="date" :min="today()" :max="addDays(today(), 60)" />
      <div class="col-span-2"><UInput v-model="form.diagnosis" label="入院診斷" required placeholder="例：J18.9 肺炎" /></div>
      <div class="col-span-2"><UTextarea v-model="form.reason" label="入院原因" :rows="2" placeholder="例：發燒咳嗽、血氧偏低" /></div>
    </div>
    <template #footer>
      <span v-if="missing.length" class="mr-auto self-center text-xs text-slate-500">還需要：{{ missing.join('、') }}</span>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :disabled="!canSave" :loading="save.pending.value" @click="submit">建立預約</UButton>
    </template>
  </UDialog>
</template>
