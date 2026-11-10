<script setup lang="ts">
import type { Component } from 'vue'
import { Inbox } from 'lucide-vue-next'

defineProps<{ title?: string; description?: string; icon?: Component }>()
</script>

<template>
  <div class="flex flex-col items-center justify-center px-4 py-12 text-center">
    <component :is="icon ?? Inbox" class="h-10 w-10 text-slate-300" />
    <p class="mt-3 text-sm font-medium text-slate-600">{{ title ?? '沒有資料' }}</p>
    <p v-if="description" class="mt-1 text-xs text-slate-400">{{ description }}</p>
    <div v-if="$slots.default" class="mt-4"><slot /></div>
  </div>
</template>
