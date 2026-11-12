<script setup lang="ts" generic="R extends Record<string, any>">
// 主檔通用表格：搜尋 → 表格 → 編輯對話框。藥品、醫令、診斷碼、預防保健項目共用。
// 每種主檔只提供「欄位定義」與「儲存函式」；驗證規則在服務層，這裡只負責收集與顯示。
import { clonePlain } from '@/utils/clone'
import { computed, reactive, ref } from 'vue'
import { Pencil, Plus } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, USelect, UTable, type Column, type SelectOption } from '@/components/ui'
import { useAction } from '@/composables/useService'

export interface FieldDef {
  key: string
  label: string
  type?: 'text' | 'number' | 'select' | 'checkbox' | 'list'
  options?: readonly SelectOption[]
  required?: boolean
  /** 建立後不可修改（例如代碼） */
  lockOnEdit?: boolean
  hint?: string
  /** 佔兩欄 */
  wide?: boolean
  /** 依表單其他欄位決定要不要顯示（例：服用時機只有口服藥才有） */
  showIf?: (form: Record<string, any>) => boolean
}

const props = defineProps<{
  rows: R[] | undefined
  loading?: boolean
  columns: Column<R>[]
  fields: FieldDef[]
  rowKey: (r: R) => string
  /** 搜尋比對的欄位 */
  searchKeys: (keyof R)[]
  /** 新增時的空白資料；不提供表示不能新增 */
  blank?: () => Record<string, unknown>
  save: (form: Record<string, any>, isNew: boolean) => Promise<unknown>
  title: string
  note?: string
}>()

const keyword = ref('')
const showInactive = ref(false)
const shown = computed(() =>
  (props.rows ?? []).filter((r) => (showInactive.value || r.active !== false) && (!keyword.value || props.searchKeys.some((k) => String(r[k] ?? '').toLowerCase().includes(keyword.value.trim().toLowerCase())))),
)

const open = ref(false)
const isNew = ref(false)
const form = reactive<Record<string, any>>({})
function edit(r?: R) {
  isNew.value = !r
  const src: Record<string, any> = r ? clonePlain(r) : props.blank!()
  // list 欄位在表單上用逗號分隔的文字編輯
  for (const f of props.fields) if (f.type === 'list') src[f.key] = (src[f.key] ?? []).join('、')
  for (const k of Object.keys(form)) delete form[k]
  Object.assign(form, src)
  action.fieldErrors.value = {}
  open.value = true
}
const action = useAction((f: Record<string, any>, n: boolean) => props.save(f, n), { success: () => `已儲存${props.title}` })
async function submit() {
  const payload: Record<string, any> = { ...form }
  for (const f of props.fields) if (f.type === 'list') payload[f.key] = String(payload[f.key] ?? '').split(/[、,，]/)
  if ((await action.run(payload, isNew.value)) !== undefined) open.value = false
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-end gap-3">
      <UInput v-model="keyword" placeholder="搜尋代碼、名稱" class="w-56" />
      <UCheckbox v-model="showInactive" label="顯示已停用" class="pb-2" />
      <span class="pb-2 text-xs text-slate-500">共 {{ shown.length }} 筆</span>
      <UButton v-if="blank" class="ml-auto" :icon="Plus" @click="edit()">新增{{ title }}</UButton>
    </div>
    <p v-if="note" class="text-xs text-slate-500">{{ note }}</p>
    <UTable :columns="[...columns, { key: '__active', label: '狀態', width: '5rem' }, { key: '__act', label: '', width: '5rem', align: 'right' }]" :rows="shown" :row-key="rowKey" :loading="loading && !rows" dense class="max-h-[calc(100vh-20rem)]" :row-class="(r) => (r.active === false ? 'text-slate-400' : '')">
      <template v-for="c in columns" :key="c.key" #[`cell-${c.key}`]="{ row }">
        <slot :name="`cell-${c.key}`" :row="row">{{ c.format ? c.format(row) : row[c.key] ?? '—' }}</slot>
      </template>
      <template #cell-__active="{ row }"><UBadge :tone="row.active === false ? 'gray' : 'green'">{{ row.active === false ? '停用' : '使用中' }}</UBadge></template>
      <template #cell-__act="{ row }"><UButton size="sm" variant="ghost" :icon="Pencil" class="whitespace-nowrap" @click="edit(row)">編輯</UButton></template>
    </UTable>

    <UDialog v-model="open" @submit="submit" :title="`${isNew ? '新增' : '編輯'}${title}`" size="lg">
      <div class="grid grid-cols-2 gap-3">
        <template v-for="f in fields.filter((x) => !x.showIf || x.showIf(form))" :key="f.key">
          <div v-if="f.type === 'checkbox'" :class="f.wide && 'col-span-2'">
            <UCheckbox v-model="form[f.key]" :label="f.label" />
            <p v-if="action.fieldErrors.value[f.key]" class="mt-1 text-xs text-red-600">{{ action.fieldErrors.value[f.key] }}</p>
            <p v-else-if="f.hint" class="mt-1 text-xs text-slate-500">{{ f.hint }}</p>
          </div>
          <!-- 寬欄位包一層 div 跨兩欄：UInput／USelect 的 class 會落在內層 input（inheritAttrs:false），放它們身上排不了版 -->
          <div v-else-if="f.type === 'select'" :class="f.wide && 'col-span-2'">
          <USelect
            v-model="form[f.key]"
            :label="f.label"
            :options="f.options ?? []"
            :required="f.required"
            :hint="f.hint"
            :error="action.fieldErrors.value[f.key]"
          />
          </div>
          <div v-else :class="f.wide && 'col-span-2'">
          <UInput
            v-model="form[f.key]"
            :label="f.label"
            :type="f.type === 'number' ? 'number' : 'text'"
            step="any"
            :required="f.required"
            :disabled="f.lockOnEdit && !isNew"
            :hint="f.lockOnEdit && !isNew ? '建立後不可修改' : f.type === 'list' ? `${f.hint ?? ''}以「、」分隔` : f.hint"
            :error="action.fieldErrors.value[f.key]"
          />
          </div>
        </template>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton :loading="action.pending.value" type="submit">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
