<script setup lang="ts">
export interface TabItem {
  key: string
  label: string
  count?: number
}

import { nextTick, ref, watch } from 'vue'

const model = defineModel<string>({ required: true })
const props = defineProps<{ tabs: TabItem[] }>()
// 由程式切換分頁（例：從首頁待辦帶到第 20 個分頁）時，選中的分頁可能在可捲動區域外面：捲到看得見
const bar = ref<HTMLElement>()
// 分頁的數字晚一點才載入、寬度會變：分頁內容變了也再對一次
watch([model, () => props.tabs.map((t) => `${t.key}:${t.label}:${t.count ?? ""}`).join()], async () => {
  await nextTick()
  // 只捲分頁列本身（水平），不要用 scrollIntoView：分頁列在畫面下方時會把整頁捲走
  const b = bar.value
  const el = b?.querySelector<HTMLElement>('[aria-selected="true"]')
  if (!b || !el) return
  if (el.offsetLeft < b.scrollLeft) b.scrollLeft = el.offsetLeft - 8
  else if (el.offsetLeft + el.offsetWidth > b.scrollLeft + b.clientWidth) b.scrollLeft = el.offsetLeft + el.offsetWidth - b.clientWidth + 8
}, { immediate: true })
</script>

<template>
  <div ref="bar" class="relative flex gap-1 overflow-x-auto overflow-y-hidden border-b border-slate-200" role="tablist">
    <button
      v-for="t in tabs"
      :key="t.key"
      type="button"
      role="tab"
      :aria-selected="model === t.key"
      :class="[
        '-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
        model === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700',
      ]"
      @click="model = t.key"
    >
      {{ t.label }}
      <span v-if="t.count !== undefined" :class="['tabular rounded-full px-1.5 text-xs', model === t.key ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-600']">
        {{ t.count }}
      </span>
    </button>
  </div>
</template>
