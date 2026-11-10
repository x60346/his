<script setup lang="ts" generic="T">
// 資料表：欄位定義驅動。元件不知道資料是病人還是藥品，只知道「欄位」和「列」。
// 客製某欄的呈現：<template #cell-status="{ row }">…</template>
import { computed } from 'vue'
import { Loader2 } from 'lucide-vue-next'

export interface Column<R> {
  key: string
  label: string
  align?: 'left' | 'center' | 'right'
  width?: string
  /** 沒有提供 slot 時，用來把值轉成文字 */
  format?: (row: R) => string | number
}

const props = withDefaults(
  defineProps<{
    columns: Column<T>[]
    rows: T[] | undefined
    rowKey: (row: T) => string
    loading?: boolean
    emptyText?: string
    /** 目前選取的列（高亮） */
    selectedKey?: string
    clickable?: boolean
    dense?: boolean
    rowClass?: (row: T) => string
  }>(),
  { emptyText: '沒有資料' },
)
defineEmits<{ 'row-click': [row: T] }>()

const list = computed(() => props.rows ?? [])
const alignCls = { left: 'text-left', center: 'text-center', right: 'text-right' }

function cellText(row: T, col: Column<T>) {
  if (col.format) return col.format(row)
  const v = (row as Record<string, unknown>)[col.key]
  return v === undefined || v === null || v === '' ? '—' : String(v)
}
</script>

<template>
  <div class="relative overflow-x-auto">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
          <!-- sticky：放在可捲動容器中時表頭固定在上方 -->
          <th v-for="c in columns" :key="c.key" :style="{ width: c.width }" :class="['sticky top-0 z-[1] whitespace-nowrap bg-slate-50 px-3 py-2', alignCls[c.align ?? 'left']]">
            {{ c.label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in list"
          :key="rowKey(row)"
          :class="[
            'border-b border-slate-100 last:border-0',
            clickable && 'cursor-pointer hover:bg-brand-50/60',
            selectedKey === rowKey(row) && 'bg-brand-50',
            rowClass?.(row),
          ]"
          @click="$emit('row-click', row)"
        >
          <td v-for="c in columns" :key="c.key" :class="[dense ? 'px-3 py-1.5' : 'px-3 py-2.5', alignCls[c.align ?? 'left'], 'tabular']">
            <slot :name="`cell-${c.key}`" :row="row">{{ cellText(row, c) }}</slot>
          </td>
        </tr>
        <tr v-if="!list.length && !loading">
          <td :colspan="columns.length" class="px-3 py-10 text-center text-sm text-slate-400">{{ emptyText }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="loading" class="absolute inset-0 flex items-start justify-center bg-white/60 pt-10">
      <Loader2 class="h-5 w-5 animate-spin text-brand-600" />
    </div>
  </div>
</template>
