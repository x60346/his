<script setup lang="ts">
export interface TabItem {
  key: string
  label: string
  count?: number
}

const model = defineModel<string>({ required: true })
defineProps<{ tabs: TabItem[] }>()
</script>

<template>
  <div class="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-slate-200" role="tablist">
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
