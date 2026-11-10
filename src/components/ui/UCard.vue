<script setup lang="ts">
// 注意：Vue 會把沒傳的 boolean prop 視為 false，所以「預設要內距」必須明確給預設值 true
withDefaults(defineProps<{ title?: string; subtitle?: string; padded?: boolean }>(), { padded: true })
</script>

<template>
  <section class="rounded-lg border border-slate-200 bg-white shadow-sm">
    <header v-if="title || $slots.actions || $slots.title" class="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
      <div class="min-w-0">
        <slot name="title">
          <h3 class="truncate text-sm font-semibold text-slate-800">{{ title }}</h3>
        </slot>
        <p v-if="subtitle" class="truncate text-xs text-slate-500">{{ subtitle }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2"><slot name="actions" /></div>
    </header>
    <div :class="padded ? 'p-4' : ''"><slot /></div>
  </section>
</template>
