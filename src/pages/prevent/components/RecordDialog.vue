<script setup lang="ts">
// 登錄預防保健服務。要填的欄位來自項目主檔（item.fields），頁面不寫死「成人健檢要填血壓」——
// 以後在系統管理改項目設定，這裡自動跟著變。
// 執行醫師：醫師登錄就是本人；護理師登錄要指定（從掛號帶入預設）。
import { computed, reactive, watch } from 'vue'
import { UButton, UDialog, UInput, USelect } from '@/components/ui'
import { masterApi, preventApi, type PatientBrief } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import type { PreventItem, PreventRecord } from '@/types'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ item?: PreventItem; patient?: PatientBrief; visitId?: string; defaultDoctorId?: string }>()

const auth = useAuth()
const isDoctor = computed(() => auth.user?.role === 'doctor')
const { data: doctors } = useQuery(async () => (isDoctor.value ? [] : masterApi.listDoctors()))

const results: PreventRecord['result'][] = ['正常', '異常需追蹤', '待報告']
const form = reactive({ result: '正常' as string | number | undefined, doctorId: undefined as string | number | undefined, data: {} as Record<string, string> })
watch(open, (v) => {
  if (!v || !props.item) return
  // 檢體要送驗的項目，當下還沒有結果
  form.result = props.item.needsReport ? '待報告' : '正常'
  form.doctorId = props.defaultDoctorId
  form.data = Object.fromEntries(props.item.fields.map((f) => [f, '']))
})

const save = useAction(preventApi.addPreventRecord, { success: (r) => `已登錄：${props.item?.name}（${r.result}）` })
async function submit() {
  if (!props.item || !props.patient) return
  const ok = await save.run({
    patientId: props.patient.patientId,
    itemCode: props.item.code,
    result: form.result as PreventRecord['result'],
    data: form.result === '待報告' ? {} : form.data,
    visitId: props.visitId,
    doctorId: form.doctorId ? String(form.doctorId) : undefined,
  })
  if (ok) open.value = false
}
</script>

<template>
  <UDialog v-model="open" :title="`登錄：${item?.name ?? ''}`">
    <div v-if="item && patient" class="space-y-3">
      <div class="rounded-md bg-slate-50 px-3 py-2 text-sm">
        <span class="font-medium text-slate-800">{{ patient.patientName }}</span>
        <span class="ml-2 text-slate-500">病歷號 {{ patient.chartNo }}・案件代碼 {{ item.caseCode }}</span>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <USelect v-model="form.result" label="結果" required :options="results" :error="save.fieldErrors.value.result" />
        <USelect
          v-if="!isDoctor"
          v-model="form.doctorId"
          label="執行醫師"
          required
          placeholder="請選擇"
          :options="(doctors ?? []).map((d) => ({ label: d.name, value: d.id }))"
          :error="save.fieldErrors.value.doctorId"
        />
      </div>
      <!-- 待報告：結果還沒出來，不填數值；報告回來後由「待補登報告」補上 -->
      <p v-if="form.result === '待報告'" class="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">檢體送驗中，報告回來後請至「今日工作 → 待補登報告」補上結果。</p>
      <div v-else class="grid grid-cols-2 gap-3">
        <UInput v-for="f in item.fields" :key="f" v-model="form.data[f]" :label="f" />
      </div>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :loading="save.pending.value" @click="submit">登錄</UButton>
    </template>
  </UDialog>
</template>
