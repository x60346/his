<script setup lang="ts">
// 我的片語：新增、修改、刪除。格式與重複由服務層檢查（phrase-rules），錯誤標在欄位上。
// 看診時在 S／O／A／P 輸入「.簡碼」再按空白鍵或 Tab 就展開（看診頁的 onPhraseKey）。
import { ref, watch } from 'vue'
import { Pencil, Plus, Trash2 } from 'lucide-vue-next'
import { UButton, UDialog, UEmpty, UInput, UTextarea } from '@/components/ui'
import { phraseApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import type { Phrase } from '@/types'

const open = defineModel<boolean>({ default: false })
const ui = useUi()
const { data: phrases } = useQuery(() => phraseApi.listPhrases())

const form = ref<{ id?: string; code: string; text: string }>({ code: '', text: '' })
const editing = ref(false)
watch(open, (v) => v && close())
function startNew() {
  form.value = { code: '', text: '' }
  editing.value = true
}
function startEdit(p: Phrase) {
  form.value = { id: p.id, code: p.code, text: p.text }
  editing.value = true
}
function close() {
  editing.value = false
  save.fieldErrors.value = {}
}

const save = useAction(phraseApi.savePhrase, { success: (p) => `已儲存片語 .${p.code}` })
async function onSave() {
  if (await save.run(form.value)) close()
}
const del = useAction(phraseApi.deletePhrase, { success: '已刪除片語' })
async function onDelete(p: Phrase) {
  if (await ui.confirm({ title: '刪除片語', message: `確定刪除「.${p.code}」？`, okText: '刪除', danger: true })) await del.run(p.id)
}
</script>

<template>
  <UDialog v-model="open" title="我的片語" size="md">
    <p class="mb-3 text-xs text-slate-500">在 S／O／A／P 欄位輸入「.簡碼」再按<b>空白鍵</b>或 <b>Tab</b>，就會換成片語內容。片語只有自己看得到。</p>
    <form v-if="editing" class="mb-4 space-y-3 rounded-md border border-brand-200 bg-brand-50/40 p-3" @submit.prevent="onSave">
      <UInput v-model="form.code" label="簡碼" required placeholder="例：htn（英文或數字，最多 10 碼）" :error="save.fieldErrors.value.code" />
      <UTextarea v-model="form.text" label="內容" required :rows="3" :error="save.fieldErrors.value.text" />
      <div class="flex justify-end gap-2">
        <UButton variant="secondary" @click="close">取消</UButton>
        <UButton type="submit" :loading="save.pending.value">儲存</UButton>
      </div>
    </form>
    <UEmpty v-if="!phrases?.length && !editing" title="還沒有片語" description="把常打的句子存起來，例如 .wnl →「理學檢查無特殊異常。」" />
    <ul v-else-if="phrases?.length" class="divide-y divide-slate-100 rounded-md border border-slate-200">
      <li v-for="p in phrases" :key="p.id" class="flex items-start gap-3 px-3 py-2 text-sm">
        <code class="w-16 shrink-0 font-semibold text-brand-700">.{{ p.code }}</code>
        <span class="min-w-0 flex-1 whitespace-pre-wrap text-slate-700">{{ p.text }}</span>
        <UButton size="sm" variant="ghost" :icon="Pencil" @click="startEdit(p)">修改</UButton>
        <UButton size="sm" variant="ghost" :icon="Trash2" :loading="del.pending.value" @click="onDelete(p)">刪除</UButton>
      </li>
    </ul>
    <template #footer>
      <UButton v-if="!editing" variant="secondary" :icon="Plus" @click="startNew">新增片語</UButton>
      <UButton variant="secondary" @click="open = false">關閉</UButton>
    </template>
  </UDialog>
</template>
