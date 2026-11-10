<script setup lang="ts">
// 補登報告：抹片、糞便潛血等檢體送驗後，報告回來再補上結果。只能補「待報告」的紀錄，補完即定案。
import { reactive, watch } from 'vue'
import { UButton, UDialog, UInput, USelect } from '@/components/ui'
import { preventApi, type PreventRecordView } from '@/services'
import { useAction } from '@/composables/useService'
import { toRoc } from '@/utils/date'
import type { PreventItem } from '@/types'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ record?: PreventRecordView; item?: PreventItem }>()

const form = reactive({ result: '正常' as string | number | undefined, data: {} as Record<string, string> })
watch(open, (v) => {
  if (!v || !props.item) return
  form.result = '正常'
  form.data = Object.fromEntries(props.item.fields.map((f) => [f, '']))
})

const save = useAction(preventApi.fillReport, { success: '已補登報告' })
async function submit() {
  if (!props.record) return
  if (await save.run(props.record.id, form.result as '正常' | '異常需追蹤', form.data)) open.value = false
}
</script>

<template>
  <UDialog v-model="open" :title="`補登報告：${record?.itemName ?? ''}`">
    <div v-if="record && item" class="space-y-3">
      <div class="rounded-md bg-slate-50 px-3 py-2 text-sm">
        <span class="font-medium text-slate-800">{{ record.patientName }}</span>
        <span class="ml-2 text-slate-500">病歷號 {{ record.chartNo }}・{{ toRoc(record.date) }} 執行</span>
      </div>
      <USelect v-model="form.result" label="報告結果" required :options="['正常', '異常需追蹤']" :error="save.fieldErrors.value.result" />
      <div class="grid grid-cols-2 gap-3">
        <UInput v-for="f in item.fields" :key="f" v-model="form.data[f]" :label="f" />
      </div>
      <p class="text-xs text-slate-500">報告補登後即定案，不可再修改。</p>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :loading="save.pending.value" @click="submit">補登</UButton>
    </template>
  </UDialog>
</template>
