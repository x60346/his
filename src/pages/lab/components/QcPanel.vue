<script setup lang="ts">
// 檢驗品管（檢驗頁「品管」）：每個品管項目今天的狀態（通過、警告、拒絕、未做——拒絕和未做的不能發報告）；
// 選一個項目看 Levey-Jennings 圖（近 20 天，兩個濃度各一條，平均值與 ±1/2/3SD 線，內嵌 SVG）與紀錄，登打今天的兩個濃度。
// 上一次被拒絕的，重做要寫矯正措施。判定規則在服務層 qc-rules（Westgard）
import { computed, reactive, ref, watch } from 'vue'
import { UBadge, UButton, UCard, UInput, UQueryState } from '@/components/ui'
import { qcApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => qcApi.qcOverview())
const sel = ref('K')
const a = computed(() => data.value?.analytes.find((x) => x.code === sel.value))
const form = reactive({ v1: '' as string | number, v2: '' as string | number, correction: '' })
watch(sel, () => Object.assign(form, { v1: '', v2: '', correction: '' }))
const rec = useAction(qcApi.recordQc, { success: (r) => `${r.resultLabel}${r.rules.length ? `（${r.rules.join('、')}）` : ''}` })
async function submit() {
  if (await rec.run({ analyte: sel.value, values: [Number(form.v1), Number(form.v2)], correction: form.correction })) Object.assign(form, { v1: '', v2: '', correction: '' })
}
const ST = { ok: { t: '通過', tone: 'green' }, warn: { t: '警告', tone: 'yellow' }, reject: { t: '拒絕', tone: 'red' }, missing: { t: '未做', tone: 'gray' } } as const
const lastReject = computed(() => a.value?.runs.filter((r) => r.date === data.value?.date).at(-1)?.result === 'reject')

// Levey-Jennings：y 軸是 z 值（−3.5～+3.5），x 軸是第幾次；兩個濃度兩條線
const W = 560
const H = 220
const PADL = 34
const y = (z: number) => H / 2 - (Math.max(-3.5, Math.min(3.5, z)) / 3.5) * (H / 2 - 12)
const x = (i: number, n: number) => PADL + (n <= 1 ? 0 : (i / (n - 1)) * (W - PADL - 12))
const pts = (lv: 0 | 1) => (a.value?.runs ?? []).map((r, i, arr) => ({ x: x(i, arr.length), y: y(r.z[lv]), r }))
const path = (lv: 0 | 1) => pts(lv).map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
const dot = (z: number) => (Math.abs(z) > 3 ? 'fill-red-600' : Math.abs(z) > 2 ? 'fill-amber-500' : '')
</script>

<template>
  <UQueryState :loading="loading && !data" :ready="!!data">
    <div v-if="data" class="grid grid-cols-1 gap-4 xl:grid-cols-[18rem_1fr]">
      <UCard :padded="false" class="self-start" title="今日品管">
        <ul class="divide-y divide-slate-100">
          <li v-for="x in data.analytes" :key="x.code">
            <button type="button" :class="['flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-slate-50', x.code === sel && '!bg-brand-50']" @click="sel = x.code">
              <span class="font-medium">{{ x.name }}</span>
              <UBadge :tone="ST[x.status].tone" class="ml-auto">{{ ST[x.status].t }}</UBadge>
            </button>
          </li>
        </ul>
        <p class="px-4 py-2 text-xs text-slate-500">拒絕、未做的項目不能發報告（含這個項目的檢驗都擋）。</p>
      </UCard>
      <div v-if="a" class="min-w-0 space-y-3">
        <UCard :title="`${a.name} Levey-Jennings 圖`" :subtitle="`近 20 天・濃度 1 平均 ${a.levels[0].mean}（SD ${a.levels[0].sd}）、濃度 2 平均 ${a.levels[1].mean}（SD ${a.levels[1].sd}）${a.unit}`">
          <div class="overflow-x-auto">
            <svg :width="W" :height="H" :viewBox="`0 0 ${W} ${H}`" class="block text-[10px]" role="img" :aria-label="`${a.name} 品管圖`">
              <template v-for="z in [3, 2, 1, 0, -1, -2, -3]" :key="z">
                <line :x1="PADL" :x2="W - 8" :y1="y(z)" :y2="y(z)" :class="z === 0 ? 'stroke-slate-500' : Math.abs(z) === 3 ? 'stroke-red-300' : Math.abs(z) === 2 ? 'stroke-amber-300' : 'stroke-slate-200'" :stroke-dasharray="z === 0 ? '' : '4 3'" />
                <text x="2" :y="y(z) + 3" class="fill-slate-500">{{ z === 0 ? '平均' : `${z > 0 ? '+' : ''}${z}SD` }}</text>
              </template>
              <path :d="path(0)" class="fill-none stroke-sky-600" stroke-width="1.5" />
              <path :d="path(1)" class="fill-none stroke-violet-600" stroke-width="1.5" />
              <template v-for="lv in ([0, 1] as const)" :key="lv">
                <circle v-for="p in pts(lv)" :key="`${lv}-${p.r.id}`" :cx="p.x" :cy="p.y" r="3.5" :class="dot(p.r.z[lv]) || (lv ? 'fill-violet-600' : 'fill-sky-600')"><title>{{ p.r.date.slice(5).replace('-', '/') }} 濃度 {{ lv + 1 }}：{{ p.r.values[lv] }}（z {{ p.r.z[lv] }}）{{ p.r.resultLabel }}</title></circle>
              </template>
            </svg>
          </div>
          <p class="mt-1 text-xs text-slate-500"><span class="text-sky-700">● 濃度 1</span>　<span class="text-violet-700">● 濃度 2</span>　超過 2SD 黃、3SD 紅；滑鼠移到點上看數值</p>
        </UCard>
        <UCard title="登打今天的品管">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <UInput v-model="form.v1" type="number" :label="`濃度 1（目標 ${a.levels[0].mean}）`" :error="rec.fieldErrors.value.level1" />
            <UInput v-model="form.v2" type="number" :label="`濃度 2（目標 ${a.levels[1].mean}）`" :error="rec.fieldErrors.value.level2" />
            <UInput v-if="lastReject" v-model="form.correction" class="sm:col-span-2" label="矯正措施（上一次被拒絕，必填）" placeholder="例：重新校正、換新試劑批號" :error="rec.fieldErrors.value.correction" />
          </div>
          <div class="mt-3 text-right"><UButton :loading="rec.pending.value" @click="submit">登打並判定</UButton></div>
        </UCard>
        <UCard title="紀錄" :padded="false">
          <ul class="divide-y divide-slate-100 text-sm">
            <li v-for="r in [...a.runs].reverse().slice(0, 8)" :key="r.id" class="flex flex-wrap items-center gap-2 px-4 py-1.5">
              <span class="tabular text-xs text-slate-500">{{ r.at.slice(5).replace('-', '/') }}</span>
              <span class="tabular">{{ r.values.join('／') }}</span>
              <span class="tabular text-xs text-slate-500">z {{ r.z.join('／') }}</span>
              <UBadge :tone="r.result === 'reject' ? 'red' : r.result === 'warn' ? 'yellow' : 'green'">{{ r.resultLabel }}{{ r.rules.length ? ` ${r.rules.join('、')}` : '' }}</UBadge>
              <span v-if="r.correction" class="text-xs text-slate-600">矯正：{{ r.correction }}</span>
              <span class="ml-auto text-xs text-slate-500">{{ r.byName }}</span>
            </li>
          </ul>
        </UCard>
      </div>
    </div>
  </UQueryState>
</template>
