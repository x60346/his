<script setup lang="ts">
// 組套列：套用我的組套、把目前的處方存成組套、管理（刪除）。
// 套用時由服務層展開並濾掉已停用的項目；合併進目前處方（不覆蓋、略過重複）由看診頁負責。
import { ref, watch } from 'vue'
import { BookmarkPlus, ListPlus, Trash2 } from 'lucide-vue-next'
import { UButton, UCheckbox, UDialog, UEmpty, UInput, USelect } from '@/components/ui'
import { orderSetApi, ServiceError, type ExpandedOrderSet } from '@/services'
import { Cancelled, useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import type { Diagnosis, MedicationOrder, ProcedureOrder } from '@/types'

const props = defineProps<{
  draft: { diagnoses: Diagnosis[]; medications: MedicationOrder[]; procedures: ProcedureOrder[]; subjective: string; plan: string }
}>()
const emit = defineEmits<{ apply: [set: ExpandedOrderSet] }>()
const ui = useUi()

const { data: sets } = useQuery(() => orderSetApi.listOrderSets())
const chosen = ref<string | number>('')

// ---------- 套用 ----------
const expand = useAction(orderSetApi.expandOrderSet)
async function apply() {
  if (!chosen.value) return
  const x = await expand.run(String(chosen.value))
  if (x) emit('apply', x)
}

// ---------- 存成組套 ----------
const saveOpen = ref(false)
const form = ref({ name: '', withText: false })
watch(saveOpen, (v) => v && (form.value = { name: '', withText: false }))
// 同名：先送出，服務層回 CONFLICT 再確認覆蓋（和藥品同名提醒同一個做法；取消時丟 Cancelled，安靜結束）
const save = useAction(
  async () => {
    const strip = <T extends object>(arr: T[]) => arr.map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('_'))) as T)
    const input = {
      name: form.value.name,
      diagnoses: props.draft.diagnoses,
      medications: strip(props.draft.medications),
      procedures: strip(props.draft.procedures),
      subjective: form.value.withText ? props.draft.subjective : undefined,
      plan: form.value.withText ? props.draft.plan : undefined,
    }
    try {
      return await orderSetApi.saveOrderSet(input)
    } catch (e) {
      if (!(e instanceof ServiceError && e.code === 'CONFLICT' && e.field === 'name')) throw e
      const ok = await ui.confirm({ title: '已有同名組套', message: `${e.message}，要用目前的處方覆蓋嗎？`, okText: '覆蓋', danger: true })
      if (!ok) throw new Cancelled()
      return orderSetApi.saveOrderSet({ ...input, overwrite: true })
    }
  },
  { success: (s) => `已存成組套「${s.name}」` },
)
async function onSave() {
  if (await save.run()) saveOpen.value = false
}

// ---------- 管理 ----------
const manageOpen = ref(false)
const del = useAction(orderSetApi.deleteOrderSet, { success: '已刪除組套' })
async function onDelete(id: string, name: string) {
  if (await ui.confirm({ title: '刪除組套', message: `確定刪除「${name}」？`, okText: '刪除', danger: true })) {
    await del.run(id)
    if (chosen.value === id) chosen.value = ''
  }
}
</script>

<template>
  <div class="flex flex-wrap items-end gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
    <div class="w-64">
      <USelect v-model="chosen" label="我的組套" placeholder="選擇組套" :options="(sets ?? []).map((s) => ({ label: `${s.name}（${s.summary}）`, value: s.id }))" />
    </div>
    <UButton size="sm" :icon="ListPlus" :disabled="!chosen" :loading="expand.pending.value" @click="apply">套用</UButton>
    <span class="ml-auto flex gap-2">
      <UButton size="sm" variant="secondary" :icon="BookmarkPlus" @click="saveOpen = true">存成組套</UButton>
      <UButton size="sm" variant="ghost" @click="manageOpen = true">管理</UButton>
    </span>

    <UDialog v-model="saveOpen" title="存成組套" size="sm" @submit="onSave">
      <div class="space-y-3">
        <p class="text-sm text-slate-600">
          將目前的 {{ draft.diagnoses.length }} 個診斷、{{ draft.medications.length }} 種藥、{{ draft.procedures.length }} 項處置存成組套。
        </p>
        <UInput v-model="form.name" label="組套名稱" required placeholder="例：上呼吸道感染" :error="save.fieldErrors.value.name" />
        <UCheckbox v-model="form.withText" label="一併存入主訴（S）與計畫（P）文字" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="saveOpen = false">取消</UButton>
        <UButton type="submit" :loading="save.pending.value">儲存</UButton>
      </template>
    </UDialog>

    <UDialog v-model="manageOpen" title="我的組套" size="md">
      <UEmpty v-if="!sets?.length" title="還沒有組套" description="開好處方後按「存成組套」" />
      <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
        <li v-for="s in sets" :key="s.id" class="flex items-center gap-3 px-3 py-2 text-sm">
          <div class="min-w-0 flex-1">
            <div class="font-medium text-slate-800">{{ s.name }}</div>
            <div class="truncate text-xs text-slate-500">{{ s.summary }}</div>
          </div>
          <UButton size="sm" variant="ghost" :icon="Trash2" :loading="del.pending.value" @click="onDelete(s.id, s.name)">刪除</UButton>
        </li>
      </ul>
    </UDialog>
  </div>
</template>
