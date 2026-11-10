<script setup lang="ts" generic="T">
// 自動完成搜尋：輸入關鍵字 → 呼叫 search（通常是服務層的查詢）→ 下拉選擇。
// 支援鍵盤 ↑↓ Enter Esc。用在 ICD 診斷、藥品、病患等「資料太多無法做成下拉選單」的地方。
import { onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import { Search } from 'lucide-vue-next'
import UField from './UField.vue'

const props = withDefaults(
  defineProps<{
    search: (keyword: string) => Promise<T[]>
    itemKey: (item: T) => string
    itemLabel: (item: T) => string
    itemSub?: (item: T) => string
    label?: string
    placeholder?: string
    /** 選取後清空輸入框（連續加入多筆時使用） */
    clearOnSelect?: boolean
    /** 輸入框為空時是否也查詢 */
    searchEmpty?: boolean
  }>(),
  { clearOnSelect: true, searchEmpty: false },
)
const emit = defineEmits<{ select: [item: T] }>()

const id = useId()
const keyword = ref('')
const items = shallowRef<T[]>([])
const open = ref(false)
const active = ref(0)
const loading = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let ticket = 0

async function runSearch() {
  const kw = keyword.value.trim()
  if (!kw && !props.searchEmpty) {
    items.value = []
    loading.value = false
    return
  }
  const my = ++ticket
  loading.value = true
  try {
    const r = await props.search(kw)
    if (my === ticket) {
      items.value = r
      active.value = 0
    }
  } finally {
    if (my === ticket) loading.value = false
  }
}

// 防抖：停止輸入 200ms 才查詢，避免每打一個字就打一次 API
// 選取時程式會改寫輸入框內容，那次變動不算使用者輸入
let selecting = false
watch(keyword, (kw) => {
  if (selecting) {
    selecting = false
    return
  }
  // 選取後下拉會關閉；使用者繼續打字（連續加入多筆）時要重新打開
  if (kw) open.value = true
  clearTimeout(timer)
  // 防抖等待的 200ms 也算「搜尋中」：否則這段時間清單是空的，會先閃一下「查無資料」
  loading.value = !!kw.trim() || !!props.searchEmpty
  timer = setTimeout(runSearch, 200)
})
onBeforeUnmount(() => clearTimeout(timer))

function choose(item: T) {
  emit('select', item)
  const next = props.clearOnSelect ? '' : props.itemLabel(item)
  if (next !== keyword.value) selecting = true
  keyword.value = next
  items.value = []
  open.value = false
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    open.value = true
    active.value = Math.min(active.value + 1, items.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    active.value = Math.max(active.value - 1, 0)
  } else if (e.key === 'Enter') {
    const it = items.value[active.value]
    if (open.value && it !== undefined) {
      e.preventDefault()
      choose(it)
    }
  } else if (e.key === 'Escape') {
    open.value = false
  } else {
    return
  }
  e.preventDefault()
}

function onFocus() {
  open.value = true
  if (props.searchEmpty && !items.value.length) runSearch()
}
</script>

<template>
  <UField :label="label" :for-id="id">
    <div class="relative">
      <Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        :id="id"
        v-model="keyword"
        class="form-control pl-8"
        :placeholder="placeholder"
        autocomplete="off"
        role="combobox"
        :aria-expanded="open"
        @focus="onFocus"
        @blur="open = false"
        @keydown="onKey"
      />
      <ul
        v-if="open && (items.length || loading || keyword)"
        class="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg"
      >
        <li v-if="loading && !items.length" class="px-3 py-2 text-slate-400">搜尋中…</li>
        <li v-else-if="!items.length" class="px-3 py-2 text-slate-400">查無資料</li>
        <!-- mousedown.prevent：避免點選時 input 先 blur 導致清單消失 -->
        <li
          v-for="(it, i) in items"
          :key="itemKey(it)"
          :class="['cursor-pointer px-3 py-1.5', i === active ? 'bg-brand-50 text-brand-800' : 'hover:bg-slate-50']"
          @mousedown.prevent="choose(it)"
          @mouseenter="active = i"
        >
          <div class="truncate">{{ itemLabel(it) }}</div>
          <div v-if="itemSub" class="truncate text-xs text-slate-500">{{ itemSub(it) }}</div>
        </li>
      </ul>
    </div>
  </UField>
</template>
