<script setup lang="ts">
import type { Tone } from '@/utils/labels'

withDefaults(defineProps<{ tone?: Tone; label?: string }>(), { tone: 'gray' })

const tones: Record<Tone, string> = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  blue: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  yellow: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  red: 'bg-red-50 text-red-700 ring-red-600/20',
  purple: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  cyan: 'bg-cyan-50 text-cyan-800 ring-cyan-600/20',
}
</script>

<template>
  <span :class="['inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', tones[tone]]">
    <slot>{{ label }}</slot>
  </span>
</template>
