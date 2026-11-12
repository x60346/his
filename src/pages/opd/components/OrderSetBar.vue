<script setup lang="ts">
// 組套列：套用組套（我的＋本科共用）、把目前的處方存成組套、管理（刪除）。
// 誰能看、能改（個人的只有自己；科室的同科醫師都可以）由服務層判斷，這裡只依 scope 分組顯示。
// 套用時由服務層展開並濾掉已停用的項目；合併進目前處方（不覆蓋、略過重複）由看診頁負責。
import { computed, ref, watch } from 'vue'
import { BookmarkPlus, ListPlus, Trash2 } from 'lucide-vue-next'
import { UButton, UCheckbox, UDialog, UEmpty, UInput, USelect } from '@/components/ui'
import { orderSetApi, ServiceError, type ExpandedOrderSet, type OrderSetView } from '@/services'
import { Cancelled, useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import type { Diagnosis, MedicationOrder, ProcedureOrder } from '@/types'

const props = defineProps<{
  draft: { diagnoses: Diagnosis[]; medications: MedicationOrder[]; procedures: ProcedureOrder[]; subjective: string; plan: string }
}>()
const emit = defineEmits<{ apply: [set: ExpandedOrderSet] }>()
const ui = useUi()

const { data: sets } = useQuery(() => orderSetApi.listOrderSets())
const { data: myDept } = useQuery(() => orderSetApi.myOrderSetDept())
const chosen = ref<string | number>('')
const deptLabel = computed(() => `${myDept.value?.deptName ?? '本科'}組套（同科共用）`)
const options = computed(() =>
  (sets.value ?? []).map((s) => ({ label: `${s.name}（${s.summary}）`, value: s.id, group: s.scope === 'dept' ? deptLabel.value : '我的組套' })),
)
const personal = computed(() => (sets.value ?? []).filter((s) => s.scope !== 'dept'))
const shared = computed(() => (sets.value ?? []).filter((s) => s.scope === 'dept'))

// ---------- 套用 ----------
const expand = useAction(orderSetApi.expandOrderSet)
async function apply() {
  if (!chosen.value) return
  const x = await expand.run(String(chosen.value))
  if (x) emit('apply', x)
}

// ---------- 存成組套 ----------
const saveOpen = ref(false)
const form = ref({ name: '', withText: false, scope: 'personal' as OrderSetView['scope'] })
watch(saveOpen, (v) => v && (form.value = { name: '', withText: false, scope: 'personal' }))
const scopeOptions = computed(() => [
  { label: '我的組套（只有我看得到）', value: 'personal' },
  { label: `${myDept.value?.deptName ?? '本科'}共用（同科醫師都看得到、都能修改）`, value: 'dept' },
])
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
      scope: form.value.scope,
    }
    try {
      return await orderSetApi.saveOrderSet(input)
    } catch (e) {
      if (!(e instanceof ServiceError && e.code === 'CONFLICT' && e.field === 'name')) throw e
      const shared = form.value.scope === 'dept' ? '\n\n這是科室共用組套，覆蓋後同科醫師套用的也會是新的內容。' : ''
      const ok = await ui.confirm({ title: '已有同名組套', message: `${e.message}，要用目前的處方覆蓋嗎？${shared}`, okText: '覆蓋', danger: true })
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
async function onDelete(s: OrderSetView) {
  const shared = s.scope === 'dept' ? `\n\n這是${s.deptName}共用組套，刪除後同科醫師都不能再用。` : ''
  if (await ui.confirm({ title: '刪除組套', message: `確定刪除「${s.name}」？${shared}`, okText: '刪除', danger: true })) {
    await del.run(s.id)
    if (chosen.value === s.id) chosen.value = ''
  }
}
</script>

<template>
  <div class="flex flex-wrap items-end gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
    <div class="w-64">
      <USelect v-model="chosen" label="組套" placeholder="選擇組套" :options="options" />
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
        <USelect v-model="form.scope" label="存到" :options="scopeOptions" />
        <UCheckbox v-model="form.withText" label="一併存入主訴（S）與計畫（P）文字" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="saveOpen = false">取消</UButton>
        <UButton type="submit" :loading="save.pending.value">儲存</UButton>
      </template>
    </UDialog>

    <UDialog v-model="manageOpen" title="組套管理" size="md">
      <UEmpty v-if="!sets?.length" title="還沒有組套" description="開好處方後按「存成組套」" />
      <div v-else class="space-y-4">
        <section v-for="g in [{ title: '我的組套', items: personal }, { title: deptLabel, items: shared }]" :key="g.title">
          <div class="mb-1 text-xs font-semibold text-slate-500">{{ g.title }}</div>
          <p v-if="!g.items.length" class="rounded-md border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-400">沒有</p>
          <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
            <li v-for="s in g.items" :key="s.id" class="flex items-center gap-3 px-3 py-2 text-sm">
              <div class="min-w-0 flex-1">
                <div class="font-medium text-slate-800">{{ s.name }}</div>
                <div class="truncate text-xs text-slate-500">
                  {{ s.summary }}<template v-if="s.scope === 'dept'">・最後修改 {{ s.updatedByName }} {{ s.updatedAt.slice(5, 10).replace('-', '/') }}</template>
                </div>
              </div>
              <UButton size="sm" variant="ghost" :icon="Trash2" :loading="del.pending.value" @click="onDelete(s)">刪除</UButton>
            </li>
          </ul>
        </section>
      </div>
    </UDialog>
  </div>
</template>
