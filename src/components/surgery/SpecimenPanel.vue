<script setup lang="ts">
// 手術檢體：手術中護理師逐件登記（部位、容器、固定液；標籤 A、B、C 自動給）、登記錯可以刪（寫稽核）；勾「冰凍切片」的登記就送出，等病理口頭回報（送了不能刪）。
// 手術完成時一起送病理（surgery.finishSurgery）；之後的收件、報告看 PathPanel。欄位檢查在服務層（pathology.addSpecimen）
import { reactive } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import { UButton, UCheckbox, UInput, USelect } from '@/components/ui'
import { CONTAINER_LABEL, FIXATIVE_LABEL, pathologyApi, type SurgeryView } from '@/services'
import type { PathContainer, PathFixative } from '@/types'
import { useAction } from '@/composables/useService'
import { useUi } from '@/stores/ui'

const props = defineProps<{ surgery: SurgeryView; isNurse: boolean }>()
const f = reactive({ site: '', container: 'jar' as string | number | undefined, fixative: 'formalin' as string | number | undefined, note: '', frozen: false })
// 勾冰凍：固定液改成不加（冰凍要新鮮送；服務層也擋福馬林）
const toggleFrozen = (on: boolean) => {
  f.frozen = on
  if (on) f.fixative = 'none'
}
const addAct = useAction(pathologyApi.addSpecimen, { success: (xs) => (xs.at(-1)?.frozen ? `已送冰凍切片 ${xs.at(-1)?.label ?? ''}，等病理回報` : `已登記檢體 ${xs.at(-1)?.label ?? ''}`) })
async function add() {
  if (await addAct.run(props.surgery.id, { site: f.site, container: String(f.container) as PathContainer, fixative: String(f.fixative) as PathFixative, note: f.note, frozen: f.frozen })) Object.assign(f, { site: '', note: '', frozen: false, fixative: 'formalin' })
}
const delAct = useAction(pathologyApi.removeSpecimen, { success: '已刪除檢體' })
const ui = useUi()
// 刪除要確認：標籤不補號（刪了 B 再登記是 C），誤刪後容器上已貼的標籤就對不起來
async function onDelete(surgeryId: string, x: { id: string; text: string }) {
  if (await ui.confirm({ title: '刪除檢體', message: `刪除「${x.text}」？刪除後標籤不補號，已貼在容器上的標籤要一起作廢。`, okText: '刪除檢體', danger: true })) delAct.run(surgeryId, x.id)
}
const live = () => props.isNurse && props.surgery.status === 'in-progress'
</script>

<template>
  <section class="space-y-2 rounded-md border border-slate-200 p-3 text-sm">
    <div class="flex flex-wrap items-center gap-2">
      <h4 class="font-semibold text-slate-700">檢體</h4>
      <span v-if="surgery.noSpecimen" class="text-xs text-slate-500">本台無檢體</span>
      <span v-else-if="!surgery.specimenRows.length" class="text-xs text-slate-400">還沒登記（手術中逐件登記；沒有檢體在離開前查核勾「本台無檢體」）</span>
      <span v-if="surgery.pathStageLabel" class="text-xs font-medium text-slate-600">病理：{{ surgery.pathStageLabel }}</span>
    </div>
    <ul v-if="surgery.specimenRows.length" class="space-y-0.5">
      <li v-for="x in surgery.specimenRows" :key="x.id" class="flex items-center gap-2">
        <span class="text-slate-800">{{ x.text }}</span>
        <span v-if="x.frozen" class="text-xs" :class="x.frozen.overdue ? 'font-semibold text-red-700' : x.frozen.done ? 'text-emerald-700' : 'text-amber-800'">{{ x.frozen.text }}</span>
        <button v-if="live() && !x.frozen" type="button" class="text-slate-400 hover:text-red-600" :aria-label="`刪除檢體 ${x.text}`" @click="onDelete(surgery.id, x)"><Trash2 class="h-3.5 w-3.5" /></button>
      </li>
    </ul>
    <p v-if="surgery.pathMissing" class="text-xs font-semibold text-red-700">{{ surgery.pathMissing }}</p>
    <form v-if="live()" class="grid grid-cols-2 gap-2 rounded bg-slate-50 p-2 sm:grid-cols-4" @submit.prevent="add">
      <UInput v-model="f.site" label="部位" placeholder="例：疝囊" :error="addAct.fieldErrors.value.site" />
      <USelect v-model="f.container" label="容器" :options="Object.entries(CONTAINER_LABEL).map(([value, label]) => ({ label, value }))" :error="addAct.fieldErrors.value.container" />
      <USelect v-model="f.fixative" label="固定液" :options="Object.entries(FIXATIVE_LABEL).map(([value, label]) => ({ label, value }))" :error="addAct.fieldErrors.value.fixative" />
      <div class="flex items-end gap-3 pb-1"><UCheckbox :model-value="f.frozen" label="冰凍切片（馬上送）" @update:model-value="toggleFrozen" /><UButton type="submit" size="sm" :loading="addAct.pending.value">{{ f.frozen ? '送冰凍' : '登記' }}</UButton></div>
    </form>
  </section>
</template>
