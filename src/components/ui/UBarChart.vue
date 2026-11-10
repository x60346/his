<script setup lang="ts">
// 單一數列長條圖（例：近 7 日門診人次）。滑鼠移到長條上顯示數值，只直接標示最後一根（通常是今天）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface BarDatum {
  label: string
  value: number
  /** 提示框中顯示的完整標籤 */
  title?: string
}

// valueLabels：'last' 時間序列只標最後一根（今天）；'nonzero' 類別比較時標出每根有值的長條
const props = withDefaults(
  defineProps<{ data: BarDatum[]; title?: string; unit?: string; height?: number; valueLabels?: 'last' | 'nonzero' }>(),
  { title: '', unit: '', height: 180, valueLabels: 'last' },
)

const el = ref<HTMLDivElement>()
const width = ref(480)
let ro: ResizeObserver | undefined
onMounted(() => {
  ro = new ResizeObserver(([e]) => (width.value = Math.max(240, e.contentRect.width)))
  if (el.value) ro.observe(el.value)
})
onBeforeUnmount(() => ro?.disconnect())

const pad = { top: 18, right: 8, bottom: 24, left: 32 }
const plotW = computed(() => width.value - pad.left - pad.right)
const plotH = computed(() => props.height - pad.top - pad.bottom)
const max = computed(() => {
  const m = Math.max(1, ...props.data.map((d) => d.value))
  const step = m <= 5 ? 1 : m <= 10 ? 2 : m <= 25 ? 5 : 10
  // 取 2 倍 step 的倍數，中間刻度（max/2）才會是整數
  return Math.ceil(m / (step * 2)) * step * 2
})
const ticks = computed(() => [0, max.value / 2, max.value])
const slot = computed(() => plotW.value / Math.max(1, props.data.length))
const barW = computed(() => Math.min(40, slot.value * 0.6))
const sy = (v: number) => pad.top + plotH.value - (v / max.value) * plotH.value

/** 上方 4px 圓角、底部貼齊基線的長條路徑 */
function barPath(i: number, v: number) {
  const x = pad.left + slot.value * i + (slot.value - barW.value) / 2
  const y = sy(v)
  const base = pad.top + plotH.value
  const h = base - y
  if (h <= 0) return ''
  const r = Math.min(4, h, barW.value / 2)
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW.value - r}Q${x + barW.value},${y} ${x + barW.value},${y + r}V${base}Z`
}

const hover = ref<number | null>(null)
const tip = computed(() => {
  if (hover.value === null) return null
  const d = props.data[hover.value]
  const left = pad.left + slot.value * hover.value + slot.value / 2
  return { d, left, flip: left > width.value - 120 }
})
</script>

<template>
  <figure ref="el" class="relative w-full">
    <figcaption v-if="title" class="mb-1 text-xs font-medium text-slate-700">{{ title }}</figcaption>
    <svg :width="width" :height="height" class="block select-none" role="img" :aria-label="title" @mouseleave="hover = null">
      <g v-for="t in ticks" :key="t">
        <line :x1="pad.left" :x2="pad.left + plotW" :y1="sy(t)" :y2="sy(t)" :class="t === 0 ? 'stroke-slate-300' : 'stroke-slate-100'" />
        <text :x="pad.left - 6" :y="sy(t) + 3" text-anchor="end" class="fill-slate-400 text-[10px] tabular">{{ t }}</text>
      </g>
      <g v-for="(d, i) in data" :key="d.label">
        <path :d="barPath(i, d.value)" :class="hover === i ? 'fill-brand-700' : 'fill-brand-600'" />
        <!-- 命中區比長條大，整欄都可以觸發提示 -->
        <rect :x="pad.left + slot * i" :y="pad.top" :width="slot" :height="plotH" fill="transparent" @mouseenter="hover = i" />
        <text :x="pad.left + slot * i + slot / 2" :y="height - 8" text-anchor="middle" class="fill-slate-400 text-[10px]">{{ d.label }}</text>
        <text v-if="valueLabels === 'last' ? i === data.length - 1 : d.value > 0" :x="pad.left + slot * i + slot / 2" :y="sy(d.value) - 5" text-anchor="middle" class="fill-slate-700 text-[11px] font-medium tabular">
          {{ d.value }}
        </text>
      </g>
    </svg>
    <div
      v-if="tip"
      class="pointer-events-none absolute top-6 z-10 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md"
      :style="tip.flip ? { right: `${width - tip.left + 8}px` } : { left: `${tip.left + 8}px` }"
    >
      <div class="text-slate-500">{{ tip.d.title ?? tip.d.label }}</div>
      <div class="tabular font-semibold text-slate-800">{{ tip.d.value }} {{ unit }}</div>
    </div>
  </figure>
</template>
