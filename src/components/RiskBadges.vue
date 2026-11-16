<script setup lang="ts">
// 跌倒、壓傷風險標記（最新一次評估的等級）：只標高風險與中度；護理站清單、病人資訊列、醫師的住院醫囑頁共用
import { UBadge } from '@/components/ui'
import type { RiskLevel } from '@/types'

defineProps<{ levels?: { fall?: RiskLevel; pressure?: RiskLevel }; compact?: boolean }>()
</script>

<template>
  <span v-if="levels && (levels.fall === 'high' || levels.pressure === 'high' || (!compact && (levels.fall === 'moderate' || levels.pressure === 'moderate')))" class="inline-flex gap-1">
    <UBadge v-if="levels.fall === 'high'" tone="red" title="Morse 跌倒量表高風險：床欄、呼叫鈴、下床有人陪同">跌倒高風險</UBadge>
    <UBadge v-else-if="!compact && levels.fall === 'moderate'" tone="yellow">跌倒中度</UBadge>
    <UBadge v-if="levels.pressure === 'high'" tone="purple" title="Braden 壓傷量表高風險：翻身、減壓">壓傷高風險</UBadge>
    <UBadge v-else-if="!compact && levels.pressure === 'moderate'" tone="yellow">壓傷中度</UBadge>
  </span>
</template>
