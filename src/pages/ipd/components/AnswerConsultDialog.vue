<script setup lang="ts">
// 回覆會診（會診科醫師）：看會診單附上的病人摘要（不是整份病歷），寫評估與建議；可以「建議轉入本科」。
import { reactive, watch } from 'vue'
import { UBadge, UButton, UCheckbox, UDialog, UTextarea } from '@/components/ui'
import { consultApi, type IncomingConsult } from '@/services'
import { useAction } from '@/composables/useService'

const props = defineProps<{ item: IncomingConsult | null }>()
const emit = defineEmits<{ close: [] }>()
const form = reactive({ findings: '', recommendation: '', suggestTransfer: false })
const save = useAction(consultApi.answerConsult, { success: (c) => `已回覆 ${c.fromDeptName} 的會診${c.suggestTransfer ? '（建議轉本科）' : ''}` })
watch(
  () => props.item,
  (v) => {
    if (!v) return
    Object.assign(form, { findings: '', recommendation: '', suggestTransfer: false })
    save.fieldErrors.value = {}
  },
  { immediate: true },
)
async function submit() {
  if (props.item && (await save.run(props.item.consult.id, { ...form }))) emit('close')
}
</script>

<template>
  <UDialog :model-value="!!item" :title="`回覆會診：${item?.summary.admission.patientName ?? ''}`" size="lg" @update:model-value="(v: boolean) => !v && emit('close')">
    <div v-if="item" class="space-y-3 text-sm">
      <div class="rounded-md bg-amber-50 px-3 py-2">
        <div class="flex flex-wrap items-center gap-2 font-medium text-slate-800">
          {{ item.consult.fromDeptName }} {{ item.consult.fromDoctorName }} → {{ item.consult.toDeptName }}<template v-if="item.consult.toDoctorName">（指定 {{ item.consult.toDoctorName }}）</template>
          <UBadge v-if="item.consult.urgent" tone="red">急會診</UBadge>
          <span class="text-xs font-normal text-slate-500">{{ item.consult.requestedAt.slice(5) }} 申請・已等 {{ item.consult.waitingHours }} 小時</span>
        </div>
        <div class="mt-1 text-slate-800">{{ item.consult.question }}</div>
      </div>
      <!-- 病人摘要：會診醫師不是主治，看這份就夠 -->
      <section class="space-y-1 rounded-md border border-slate-200 px-3 py-2">
        <div class="font-medium text-slate-800">
          {{ item.summary.admission.bed?.bedNo }} {{ item.summary.admission.patientName }}（{{ item.summary.admission.gender === 'M' ? '男' : '女' }}・{{ item.summary.admission.age }} 歲）・{{ item.summary.admission.diagnosis }}・第 {{ item.summary.admission.days }} 天
        </div>
        <div v-if="item.summary.allergies.length" class="text-xs text-red-700">過敏：{{ item.summary.allergies.join('、') }}</div>
        <div v-if="item.summary.latestVital" class="tabular text-xs text-slate-600">生命徵象（{{ item.summary.latestVital.at.slice(5) }}）：{{ item.summary.latestVital.text }}</div>
        <div v-if="item.summary.latestNote" class="text-xs text-slate-600">最近病程（{{ item.summary.latestNote.at.slice(5) }} {{ item.summary.latestNote.doctorName }}）：A {{ item.summary.latestNote.assessment }}／P {{ item.summary.latestNote.plan }}</div>
        <div class="text-xs text-slate-600">
          執行中醫囑：<template v-if="!item.summary.orders.length">無</template>
          <span v-for="(o, i) in item.summary.orders" :key="o.id"><template v-if="i">、</template>{{ o.content }}<template v-if="o.category === 'medication'">（{{ o.dose }} {{ o.unit }} {{ o.freq }}）</template></span>
        </div>
      </section>
      <UTextarea v-model="form.findings" label="評估（看診所見）" required :rows="3" :error="save.fieldErrors.value.findings" />
      <UTextarea v-model="form.recommendation" label="建議" required :rows="2" placeholder="例：續用目前抗生素；三天後未改善請再會診" :error="save.fieldErrors.value.recommendation" />
      <UCheckbox v-model="form.suggestTransfer" :label="`建議轉入${item.consult.toDeptName}（原科可一鍵申請轉科）`" />
    </div>
    <template #footer>
      <UButton variant="secondary" @click="emit('close')">取消</UButton>
      <UButton :loading="save.pending.value" @click="submit">送出回覆</UButton>
    </template>
  </UDialog>
</template>
