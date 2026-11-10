<script setup lang="ts">
// 填寫原因的小對話框：暫停給藥、拒絕給藥、PRN 給藥共用。
// 常用原因做成按鈕，護理師點一下就好——臨床現場打字越少越好，但仍可自由修改。
import { ref, watch } from 'vue'
import { UButton, UDialog, UTextarea } from '@/components/ui'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{
  title: string
  /** 對話框上方的說明，例如藥名與劑量 */
  subject?: string
  label: string
  presets: string[]
  okText?: string
  danger?: boolean
  pending?: boolean
  /** 服務層回傳的欄位錯誤 */
  error?: string
}>()
const emit = defineEmits<{ confirm: [note: string] }>()

const note = ref('')
watch(open, (v) => v && (note.value = ''))
// 錯誤是「針對送出當時的內容」：使用者一修改，舊錯誤就不再成立，先隱藏，下次送出再由服務層判斷
const showError = ref(false)
watch(() => props.error, (e) => (showError.value = !!e))
watch(note, () => (showError.value = false))
</script>

<template>
  <UDialog v-model="open" :title="props.title" size="sm">
    <div class="space-y-3">
      <div v-if="subject" class="rounded-md bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700">{{ subject }}</div>
      <div class="flex flex-wrap gap-1.5">
        <UButton v-for="p in presets" :key="p" size="sm" variant="secondary" @click="note = p">{{ p }}</UButton>
      </div>
      <UTextarea v-model="note" :label="label" required :rows="2" :error="showError ? error : undefined" />
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :variant="danger ? 'danger' : 'primary'" :loading="pending" @click="emit('confirm', note)">{{ okText ?? '確定' }}</UButton>
    </template>
  </UDialog>
</template>
