<script setup lang="ts">
// 交互作用、重複用藥提醒的列表（門診處方表、住院開醫囑、藥局都用）：
// 即時提醒傳 RxAlert（還沒確認）；已確認的紀錄傳 RxAlertRecord（有醫師寫的原因）。判斷由服務層做，這裡只顯示
import { AlertTriangle } from 'lucide-vue-next'
import { UBadge } from '@/components/ui'
import { RX_ALERT_LEVEL_LABEL, type RxAlert, type RxAlertRecord } from '@/services'

defineProps<{ alerts: (RxAlert | RxAlertRecord)[]; title?: string }>()
const reasonOf = (a: RxAlert | RxAlertRecord) => ('reason' in a ? a.reason : undefined)
</script>

<template>
  <div v-if="alerts.length" :class="['rounded-lg border px-3 py-2 text-sm', alerts.some((a) => a.level === 'severe') ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900']" role="status">
    <div class="mb-1 flex items-center gap-1.5 font-semibold"><AlertTriangle class="h-4 w-4 shrink-0" />{{ title ?? '用藥提醒：交互作用、重複用藥' }}</div>
    <ul class="space-y-1.5">
      <li v-for="a in alerts" :key="a.key">
        <div class="flex flex-wrap items-center gap-1.5">
          <UBadge :tone="a.level === 'severe' ? 'red' : 'yellow'">{{ RX_ALERT_LEVEL_LABEL[a.level] }}</UBadge>
          <span class="font-medium">{{ a.title }}</span>
        </div>
        <div class="text-xs">{{ a.text }}</div>
        <div v-if="a.other" class="text-xs opacity-80">{{ a.other }}</div>
        <div v-if="reasonOf(a) !== undefined" class="text-xs">醫師確認{{ reasonOf(a) ? `：${reasonOf(a)}` : '' }}</div>
      </li>
    </ul>
  </div>
</template>
