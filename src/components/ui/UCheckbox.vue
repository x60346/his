<script setup lang="ts">
const model = defineModel<boolean>({ default: false })
defineProps<{ label?: string; disabled?: boolean }>()
</script>

<template>
  <label class="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700" :class="disabled && 'cursor-not-allowed opacity-60'">
    <input v-model="model" type="checkbox" :disabled="disabled" class="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
    <slot>{{ label }}</slot>
  </label>
</template>
