<script setup lang="ts">
// 片語管理：我的片語、科室（醫師）或病房（護理師）共用片語——新增、修改、刪除。
// 格式、重複、誰能改由服務層檢查（phrase.ts、phrase-rules），錯誤標在欄位上。
// 在門診 SOAP、病程紀錄、出院病摘、護理紀錄、交班輸入「.簡碼」再按空白鍵或 Tab 就展開（composables/usePhrases）。
import { computed, ref, watch } from 'vue'
import { Pencil, Plus, Trash2 } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UEmpty, UInput, UTextarea } from '@/components/ui'
import { phraseApi, type PhraseView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'

const props = defineProps<{ ward?: string }>()
const open = defineModel<boolean>({ default: false })
const ui = useUi()
const { data } = useQuery(() => phraseApi.listPhrases({ ward: props.ward }), [() => props.ward])
const shareTarget = computed(() => data.value?.shareTarget)
const groups = computed(() => {
  const list = data.value?.phrases ?? []
  return [
    { key: 'personal', title: '我的片語', note: '只有自己看得到', items: list.filter((p) => (p.scope ?? 'personal') === 'personal') },
    ...(shareTarget.value ? [{ key: 'shared', title: shareTarget.value.label, note: shareTarget.value.scope === 'dept' ? '同科醫師都能用、能改' : '在這個病房寫紀錄的護理師都能用、能改', items: list.filter((p) => (p.scope ?? 'personal') !== 'personal') }] : []),
  ]
})

const form = ref<{ id?: string; code: string; text: string; shared: boolean }>({ code: '', text: '', shared: false })
const editing = ref(false)
watch(open, (v) => v && close())
function startNew(shared: boolean) {
  form.value = { code: '', text: '', shared }
  editing.value = true
}
function startEdit(p: PhraseView) {
  form.value = { id: p.id, code: p.code, text: p.text, shared: (p.scope ?? 'personal') !== 'personal' }
  editing.value = true
}
function close() {
  editing.value = false
  save.fieldErrors.value = {}
}

const save = useAction(phraseApi.savePhrase, { success: (p) => `已儲存${p.scope && p.scope !== 'personal' ? p.scopeLabel : ''}片語 .${p.code}` })
async function onSave() {
  if (await save.run({ ...form.value, ward: props.ward })) close()
}
const del = useAction((id: string) => phraseApi.deletePhrase(id, { ward: props.ward }), { success: '已刪除片語' })
async function onDelete(p: PhraseView) {
  const shared = (p.scope ?? 'personal') !== 'personal'
  if (await ui.confirm({ title: '刪除片語', message: `確定刪除${shared ? p.scopeLabel : ''}「.${p.code}」？${shared ? '其他人也就不能再用了。' : ''}`, okText: '刪除', danger: true })) await del.run(p.id)
}
</script>

<template>
  <UDialog v-model="open" title="片語" size="md">
    <p class="mb-3 text-xs text-slate-500">
      在病歷、紀錄的文字欄位輸入「.簡碼」再按<b>空白鍵</b>或 <b>Tab</b>，就會換成片語內容。個人和共用片語可以用同一個簡碼，<b>個人的優先</b>。
    </p>
    <form v-if="editing" class="mb-4 space-y-3 rounded-md border border-brand-200 bg-brand-50/40 p-3" @submit.prevent="onSave">
      <p class="text-xs font-medium text-brand-700">{{ form.id ? '修改' : '新增' }}{{ form.shared ? shareTarget?.label : '我的' }}片語</p>
      <UInput v-model="form.code" label="簡碼" required placeholder="例：htn（英文或數字，最多 10 碼）" :error="save.fieldErrors.value.code" />
      <UTextarea v-model="form.text" label="內容" required :rows="3" :error="save.fieldErrors.value.text" />
      <div class="flex justify-end gap-2">
        <UButton variant="secondary" @click="close">取消</UButton>
        <UButton type="submit" :loading="save.pending.value">儲存</UButton>
      </div>
    </form>
    <div class="space-y-4">
      <section v-for="g in groups" :key="g.key">
        <div class="mb-1 flex items-center gap-2">
          <h3 class="text-sm font-semibold text-slate-700">{{ g.title }}</h3>
          <span class="text-xs text-slate-400">{{ g.note }}</span>
          <UButton v-if="!editing" class="ml-auto" size="sm" variant="ghost" :icon="Plus" @click="startNew(g.key === 'shared')">新增</UButton>
        </div>
        <UEmpty v-if="!g.items.length" :title="g.key === 'shared' ? '還沒有共用片語' : '還沒有片語'" :description="g.key === 'shared' ? '大家常打的句子存在這裡，例如交班、衛教的固定說法' : '把常打的句子存起來，例如 .wnl →「理學檢查無特殊異常。」'" />
        <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
          <li v-for="p in g.items" :key="p.id" class="flex items-start gap-3 px-3 py-2 text-sm">
            <code :class="['w-16 shrink-0 font-semibold', p.shadowed ? 'text-slate-400 line-through' : 'text-brand-700']">.{{ p.code }}</code>
            <div class="min-w-0 flex-1">
              <p class="whitespace-pre-wrap text-slate-700">{{ p.text }}</p>
              <p v-if="p.updatedByName || p.shadowed" class="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-slate-400">
                <span v-if="p.updatedByName">最後由 {{ p.updatedByName }} 修改</span>
                <UBadge v-if="p.shadowed" tone="yellow" title="你有同簡碼的個人片語，展開時用的是個人的">被你的個人片語蓋住</UBadge>
              </p>
            </div>
            <UButton size="sm" variant="ghost" :icon="Pencil" @click="startEdit(p)">修改</UButton>
            <UButton size="sm" variant="ghost" :icon="Trash2" :loading="del.pending.value" @click="onDelete(p)">刪除</UButton>
          </li>
        </ul>
      </section>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">關閉</UButton>
    </template>
  </UDialog>
</template>
