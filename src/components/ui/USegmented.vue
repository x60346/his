<script setup lang="ts">
// 切換鈕組（病房、我的病人／全病房、今天／明天、本月／上月…）：
// 選中的用白底藍字，不用實心藍底——實心藍底留給「要按下去做事」的主要按鈕，
// 否則一進頁面就好幾顆藍底，分不出哪顆是動作、哪顆只是目前的篩選
export interface SegmentItem {
  key: string
  label: string
  count?: number
}

const model = defineModel<string>({ required: true })
withDefaults(defineProps<{ options: SegmentItem[]; size?: 'sm' | 'md'; label?: string }>(), { size: 'md' })
</script>

<template>
  <div class="inline-flex shrink-0 rounded-lg border border-slate-200 bg-slate-100 p-0.5" role="group" :aria-label="label">
    <button
      v-for="o in options"
      :key="o.key"
      type="button"
      :aria-pressed="model === o.key"
      :class="[
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        size === 'sm' ? 'h-6 px-2.5 text-xs' : 'h-8 px-3 text-sm',
        model === o.key ? 'bg-white font-medium text-brand-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white/60 hover:text-slate-800',
      ]"
      @click="model = o.key"
    >
      {{ o.label }}
      <span v-if="o.count !== undefined" class="tabular" :class="model === o.key ? 'text-brand-600' : 'text-slate-500'">{{ o.count }}</span>
    </button>
  </div>
</template>
