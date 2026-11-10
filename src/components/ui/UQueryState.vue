<script setup lang="ts">
// 非同步資料的三種狀態：載入中 / 沒有資料 / 有資料。
// 「載入中」若顯示成空白或「沒有資料」，使用者會誤判（例如以為今天沒有病人），所以統一用這個元件處理。
import { Loader2 } from 'lucide-vue-next'
import UEmpty from './UEmpty.vue'

defineProps<{
  loading: boolean
  /** 是否已有可顯示的資料 */
  ready: boolean
  /** 載入完成但沒有資料時顯示；不給則不顯示空狀態 */
  emptyTitle?: string
  emptyDescription?: string
}>()
</script>

<template>
  <slot v-if="ready" />
  <div v-else-if="loading" class="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
    <Loader2 class="h-4 w-4 animate-spin" />載入中…
  </div>
  <UEmpty v-else-if="emptyTitle" :title="emptyTitle" :description="emptyDescription" />
</template>
