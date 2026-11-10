<script setup lang="ts">
import type { Component } from 'vue'

withDefaults(defineProps<{ label: string; value: string | number; hint?: string; icon?: Component; tone?: 'brand' | 'amber' | 'emerald' | 'red' | 'slate' }>(), { tone: 'brand' })

const iconTone = {
  brand: 'bg-brand-50 text-brand-600',
  amber: 'bg-amber-50 text-amber-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  red: 'bg-red-50 text-red-600',
  slate: 'bg-slate-100 text-slate-600',
}
</script>

<template>
  <div class="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
    <div v-if="icon" :class="['rounded-md p-2', iconTone[tone]]"><component :is="icon" class="h-5 w-5" /></div>
    <div class="min-w-0">
      <div class="text-xs font-medium text-slate-500">{{ label }}</div>
      <div class="tabular mt-0.5 text-2xl font-semibold text-slate-800">{{ value }}</div>
      <div v-if="hint" class="mt-0.5 text-xs text-slate-500">{{ hint }}</div>
    </div>
  </div>
</template>
