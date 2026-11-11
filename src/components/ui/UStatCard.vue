<script setup lang="ts">
// 摘要卡片。給了 @click 就變成按鈕（可用鍵盤操作、報讀器知道能按），active 時加外框表示「目前的篩選」。
// 沒給 @click 的卡片（例：首頁）維持原本的純顯示。
import { computed, type Component } from 'vue'

const props = withDefaults(
  defineProps<{ label: string; value: string | number; hint?: string; icon?: Component; tone?: 'brand' | 'amber' | 'emerald' | 'red' | 'slate'; active?: boolean; onClick?: () => void }>(),
  { tone: 'brand', active: false },
)
const clickable = computed(() => !!props.onClick)

const iconTone = {
  brand: 'bg-brand-50 text-brand-600',
  amber: 'bg-amber-50 text-amber-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  red: 'bg-red-50 text-red-600',
  slate: 'bg-slate-100 text-slate-600',
}
</script>

<template>
  <component
    :is="clickable ? 'button' : 'div'"
    :type="clickable ? 'button' : undefined"
    :aria-pressed="clickable ? active : undefined"
    @click="onClick?.()"
    :class="[
      'flex items-start gap-3 rounded-lg border bg-white p-4 text-left shadow-sm',
      active ? 'border-brand-500 ring-2 ring-brand-200' : 'border-slate-200',
      clickable && 'transition hover:border-brand-300 hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300',
    ]"
  >
    <div v-if="icon" :class="['rounded-md p-2', iconTone[tone]]"><component :is="icon" class="h-5 w-5" /></div>
    <div class="min-w-0">
      <div class="text-xs font-medium text-slate-500">{{ label }}</div>
      <div class="tabular mt-0.5 text-2xl font-semibold text-slate-800">{{ value }}</div>
      <div v-if="hint" class="mt-0.5 text-xs text-slate-500">{{ hint }}</div>
    </div>
  </component>
</template>
