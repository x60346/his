<script setup lang="ts">
// 狀態徽章：傳入對照表與代碼即可，例如 <UStatusBadge :map="visitStatus" :value="row.status" />
import { computed } from 'vue'
import type { Tone } from '@/utils/labels'
import UBadge from './UBadge.vue'

const props = defineProps<{ map: Record<string, { label: string; tone: Tone }>; value: string }>()
const item = computed(() => props.map[props.value] ?? { label: props.value, tone: 'gray' as Tone })
</script>

<template>
  <UBadge :tone="item.tone" :label="item.label" />
</template>
