<script setup lang="ts">
// 病歷影本（A4 列印）：每一項一頁，頁首印醫院、病人、申請單號、第幾頁；斜向浮水印「影本」。資料由服務層 copy.printRecordCopy 整理
import type { CopyPrint } from '@/services'
import { HOSPITAL } from '@/utils/hospital'
import { toRoc } from '@/utils/date'

defineProps<{ c: CopyPrint }>()
</script>

<template>
  <div class="print-area space-y-4">
    <article v-for="(p, i) in c.pages" :key="i" class="relative break-after-page overflow-hidden border border-slate-400 p-6 text-sm leading-relaxed text-slate-900 last:break-after-auto">
      <div aria-hidden="true" class="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span class="-rotate-[30deg] select-none text-[7rem] font-bold tracking-[0.5em] text-slate-300/50">影本</span>
      </div>
      <header class="relative border-b border-slate-700 pb-2">
        <div class="flex items-baseline justify-between">
          <span class="font-bold">{{ HOSPITAL.name }}</span>
          <span class="tabular text-xs">申請單號 {{ c.no }}・第 {{ i + 1 }}／{{ c.pages.length }} 頁</span>
        </div>
        <div class="tabular mt-1 text-xs text-slate-600">{{ c.patient.name }}・{{ c.patient.gender }}・病歷號 {{ c.patient.chartNo }}・出生 {{ toRoc(c.patient.birthDate) }}</div>
      </header>
      <h2 class="relative mt-3 text-lg font-bold">{{ p.title }}</h2>
      <p class="tabular relative text-xs text-slate-600">{{ p.meta }}</p>
      <section v-for="s in p.sections" :key="s.heading" class="relative mt-2">
        <div class="font-semibold">{{ s.heading }}</div>
        <p class="whitespace-pre-line break-words">{{ s.text }}</p>
      </section>
      <table v-if="p.table" class="relative mt-3 w-full border-collapse text-xs">
        <thead><tr><th v-for="h in p.table.head" :key="h" class="border border-slate-400 bg-slate-50 px-2 py-1 text-left">{{ h }}</th></tr></thead>
        <tbody><tr v-for="(row, ri) in p.table.rows" :key="ri"><td v-for="(cell, ci) in row" :key="ci" class="border border-slate-300 px-2 py-1">{{ cell }}</td></tr></tbody>
      </table>
      <footer class="relative mt-6 border-t border-slate-300 pt-2 text-xs text-slate-600">
        本頁為病歷影本，與原本相符。申請人：{{ c.applicantText }}・用途：{{ c.purpose }}・列印 {{ c.printedAt }}{{ c.times > 1 ? `（補印第 ${c.times} 次）` : '' }}
      </footer>
    </article>
  </div>
</template>
