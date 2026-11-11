<script setup lang="ts">
// Code 39 條碼（SVG）：向量圖，列印時不會糊。兩側留白（靜區）至少 10 個窄條寬，掃描器才找得到起點。
import { computed } from 'vue'
import { code39Bars } from '@/utils/code39'

const props = withDefaults(defineProps<{ value: string; height?: number; module?: number }>(), { height: 40, module: 1.4 })
const QUIET = 10
const data = computed(() => code39Bars(props.value))
const total = computed(() => (data.value.width + QUIET * 2) * props.module)
</script>

<template>
  <figure class="inline-flex flex-col items-center">
    <svg :width="total" :height="height" :viewBox="`0 0 ${total} ${height}`" role="img" :aria-label="`條碼 ${value}`" shape-rendering="crispEdges">
      <rect width="100%" height="100%" fill="#fff" />
      <rect v-for="(b, i) in data.bars" :key="i" :x="(b.x + QUIET) * module" y="0" :width="b.w * module" :height="height" fill="#000" />
    </svg>
    <figcaption class="tabular text-xs tracking-[0.3em]">{{ value }}</figcaption>
  </figure>
</template>
