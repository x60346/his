<script setup lang="ts">
// 單一數列折線圖（生命徵象趨勢用）。
// 刻度不同的量（體溫、脈搏）請各畫一張，不做雙 Y 軸。可標示正常範圍帶，超出範圍的點以紅色並在提示中註明。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface LinePoint {
  /** X 軸標籤（時間） */
  x: string
  y: number
}

const props = withDefaults(
  defineProps<{
    points: LinePoint[]
    title: string
    unit?: string
    height?: number
    /** 正常範圍 [下限, 上限] */
    normal?: [number, number]
    /** 固定的 Y 軸範圍，不給則依資料自動 */
    domain?: [number, number]
    /** X 軸標籤的簡短格式 */
    formatX?: (x: string) => string
  }>(),
  { unit: '', height: 180 },
)

const el = ref<HTMLDivElement>()
const width = ref(480)
let ro: ResizeObserver | undefined
onMounted(() => {
  ro = new ResizeObserver(([e]) => (width.value = Math.max(240, e.contentRect.width)))
  if (el.value) ro.observe(el.value)
})
onBeforeUnmount(() => ro?.disconnect())

const pad = { top: 12, right: 16, bottom: 26, left: 40 }
const plotW = computed(() => width.value - pad.left - pad.right)
const plotH = computed(() => props.height - pad.top - pad.bottom)

const yDomain = computed<[number, number]>(() => {
  if (props.domain) return props.domain
  const ys = props.points.map((p) => p.y).concat(props.normal ?? [])
  if (!ys.length) return [0, 1]
  const min = Math.min(...ys)
  const max = Math.max(...ys)
  const span = max - min || 1
  return [min - span * 0.15, max + span * 0.15]
})

const sx = (i: number) => pad.left + (props.points.length <= 1 ? plotW.value / 2 : (i / (props.points.length - 1)) * plotW.value)
const sy = (v: number) => {
  const [a, b] = yDomain.value
  return pad.top + plotH.value - ((v - a) / (b - a)) * plotH.value
}

const yTicks = computed(() => {
  const [a, b] = yDomain.value
  const step = niceStep((b - a) / 4)
  const out: number[] = []
  for (let v = Math.ceil(a / step) * step; v <= b; v += step) out.push(Math.round(v * 100) / 100)
  return out
})
function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / p
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p
}

// X 軸最多顯示約 6 個標籤，避免重疊
const xLabelEvery = computed(() => Math.max(1, Math.ceil(props.points.length / Math.max(2, Math.floor(plotW.value / 80)))))

const path = computed(() => props.points.map((p, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(p.y).toFixed(1)}`).join(''))
const outOfRange = (y: number) => !!props.normal && (y < props.normal[0] || y > props.normal[1])
const fx = (x: string) => (props.formatX ? props.formatX(x) : x)

const hover = ref<number | null>(null)
function onMove(e: MouseEvent) {
  if (!props.points.length) return
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
  const x = e.clientX - rect.left
  let best = 0
  for (let i = 1; i < props.points.length; i++) if (Math.abs(sx(i) - x) < Math.abs(sx(best) - x)) best = i
  hover.value = best
}
const tip = computed(() => {
  if (hover.value === null) return null
  const p = props.points[hover.value]
  const left = sx(hover.value)
  return { p, left, flip: left > width.value - 140 }
})
</script>

<template>
  <figure ref="el" class="relative w-full">
    <figcaption class="mb-1 flex items-baseline justify-between text-xs">
      <span class="font-medium text-slate-700">{{ title }}<span v-if="unit" class="ml-1 text-slate-400">（{{ unit }}）</span></span>
      <span v-if="normal" class="text-slate-400">正常範圍 {{ normal[0] }}–{{ normal[1] }}</span>
    </figcaption>

    <div v-if="!points.length" class="flex items-center justify-center rounded border border-dashed border-slate-200 text-xs text-slate-400" :style="{ height: `${height}px` }">
      尚無資料
    </div>

    <svg v-else :width="width" :height="height" class="block select-none" role="img" :aria-label="`${title}趨勢圖`" @mousemove="onMove" @mouseleave="hover = null">
      <!-- 正常範圍帶 -->
      <rect
        v-if="normal"
        :x="pad.left"
        :width="plotW"
        :y="sy(Math.min(normal[1], yDomain[1]))"
        :height="Math.max(0, sy(Math.max(normal[0], yDomain[0])) - sy(Math.min(normal[1], yDomain[1])))"
        class="fill-emerald-50"
      />
      <!-- 格線與 Y 軸刻度 -->
      <g v-for="t in yTicks" :key="t">
        <line :x1="pad.left" :x2="pad.left + plotW" :y1="sy(t)" :y2="sy(t)" class="stroke-slate-100" />
        <text :x="pad.left - 6" :y="sy(t) + 3" text-anchor="end" class="fill-slate-400 text-[10px] tabular">{{ t }}</text>
      </g>
      <line :x1="pad.left" :x2="pad.left + plotW" :y1="pad.top + plotH" :y2="pad.top + plotH" class="stroke-slate-300" />
      <!-- X 軸標籤 -->
      <template v-for="(p, i) in points" :key="`x${i}`">
        <!-- 頭尾標籤向內對齊，避免超出圖框被裁掉 -->
        <text
          v-if="i === points.length - 1 || (i % xLabelEvery === 0 && points.length - 1 - i >= xLabelEvery)"
          :x="sx(i)"
          :y="height - 8"
          :text-anchor="points.length > 1 && i === 0 ? 'start' : points.length > 1 && i === points.length - 1 ? 'end' : 'middle'"
          class="fill-slate-400 text-[10px]"
        >{{ fx(p.x) }}</text>
      </template>
      <!-- 十字線 -->
      <line v-if="tip" :x1="tip.left" :x2="tip.left" :y1="pad.top" :y2="pad.top + plotH" class="stroke-slate-300" stroke-dasharray="3 3" />
      <!-- 折線與資料點：2px 線、8px 點、2px 白色外框 -->
      <path :d="path" fill="none" class="stroke-brand-600" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      <circle
        v-for="(p, i) in points"
        :key="`c${i}`"
        :cx="sx(i)"
        :cy="sy(p.y)"
        :r="hover === i ? 5 : 4"
        stroke="white"
        stroke-width="2"
        :class="outOfRange(p.y) ? 'fill-red-600' : 'fill-brand-600'"
      />
      <!-- 只直接標示最後一點的數值 -->
      <text :x="sx(points.length - 1)" :y="sy(points[points.length - 1].y) - 9" text-anchor="middle" class="fill-slate-700 text-[11px] font-medium tabular">
        {{ points[points.length - 1].y }}
      </text>
    </svg>

    <div
      v-if="tip"
      class="pointer-events-none absolute top-6 z-10 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md"
      :style="tip.flip ? { right: `${width - tip.left + 10}px` } : { left: `${tip.left + 10}px` }"
    >
      <div class="text-slate-500">{{ tip.p.x }}</div>
      <div class="tabular font-semibold text-slate-800">{{ tip.p.y }} {{ unit }}</div>
      <div v-if="outOfRange(tip.p.y)" class="text-red-600">⚠ 超出正常範圍</div>
    </div>
  </figure>
</template>
