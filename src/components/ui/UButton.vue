<script setup lang="ts">
import type { Component } from 'vue'
import { Loader2 } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'ghost'
    size?: 'sm' | 'md'
    type?: 'button' | 'submit'
    icon?: Component
    loading?: boolean
    disabled?: boolean
    block?: boolean
  }>(),
  { variant: 'primary', size: 'md', type: 'button' },
)

const variants = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm',
  secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 shadow-sm',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm',
  ghost: 'text-slate-600 hover:bg-slate-100',
}
const sizes = { sm: 'h-7 px-2.5 text-xs gap-1', md: 'h-9 px-3.5 text-sm gap-1.5' }
</script>

<template>
  <button
    :type="props.type"
    :disabled="disabled || loading"
    :class="[
      'inline-flex items-center justify-center rounded-md font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:cursor-not-allowed disabled:opacity-50',
      variants[variant],
      sizes[size],
      block && 'w-full',
    ]"
  >
    <Loader2 v-if="loading" :class="size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'" class="animate-spin" />
    <component :is="icon" v-else-if="icon" :class="size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'" />
    <slot />
  </button>
</template>
