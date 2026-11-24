<script setup lang="ts">
// 抗生素時間軸（內嵌 SVG，不用圖表套件）：橫軸是這次住院的每一天，每支抗生素一列——實心＝那天有給藥、空心＝有醫囑但沒給；
// 下面三列：細菌培養（空心圈＝送檢、實心圈＝報告，點了看藥敏）、肌酸酐與 Vancomycin 谷濃度（異常紅字）、感染科建議（菱形）。
// 滑鼠移到格子上看當天給了幾劑（SVG <title>）。住得久的橫向捲動，一打開就捲到最近幾天。資料來自 abxTimelineApi（服務層算好）
import { computed, nextTick, ref, watch } from 'vue'
import { UQueryState } from '@/components/ui'
import CultureView from '@/components/CultureView.vue'
import { abxTimelineApi, type AbxTimeline } from '@/services'
import { useQuery } from '@/composables/useService'
import { today } from '@/utils/date'

const props = defineProps<{ admissionId: string }>()
const { data, loading } = useQuery(() => abxTimelineApi.abxTimeline(props.admissionId), [() => props.admissionId])

const LABEL_W = 168
const CELL = 22
const ROW = 22
const HEAD = 30
const t = computed<AbxTimeline | undefined>(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const col = (date: string) => t.value!.days.indexOf(date.slice(0, 10))
const cx = (date: string) => LABEL_W + col(date) * CELL + CELL / 2
// 列：抗生素 n 列＋培養、肌酸酐、谷濃度、建議 4 列
const extraY = computed(() => HEAD + (t.value?.rows.length ?? 0) * ROW + 8)
const height = computed(() => extraY.value + 4 * ROW + 6)
const width = computed(() => LABEL_W + (t.value?.days.length ?? 0) * CELL + 6)
const td = today()
const dayLabel = (d: string, i: number) => (i === 0 || d.slice(8) === '01' ? `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` : String(Number(d.slice(8))))

// 同一天同一種檢驗有好幾份：只畫最後一份（tooltip 寫全部）
const labsOn = (kind: 'cre' | 'vant') => {
  const by = new Map<string, AbxTimeline['labs']>()
  for (const l of t.value?.labs.filter((x) => x.kind === kind && col(x.at) >= 0) ?? []) by.set(l.at.slice(0, 10), [...(by.get(l.at.slice(0, 10)) ?? []), l])
  return [...by.entries()].map(([date, ls]) => ({ date, last: ls.at(-1)!, all: ls }))
}

const selCulture = ref<string>()
const culture = computed(() => t.value?.cultures.find((c) => c.id === selCulture.value))
watch(() => props.admissionId, () => (selCulture.value = undefined))

// 一打開捲到最右邊（最近的日子）
const scroller = ref<HTMLElement>()
watch(t, async () => {
  await nextTick()
  if (scroller.value) scroller.value.scrollLeft = scroller.value.scrollWidth
})
</script>

<template>
  <UQueryState :loading="loading && !t" :ready="!!t">
    <div v-if="t" class="space-y-2">
      <p v-if="!t.rows.length && !t.cultures.length" class="text-sm text-slate-500">這次住院沒有用過抗生素、也沒有細菌培養。</p>
      <div v-else ref="scroller" class="overflow-x-auto rounded border border-slate-200 bg-white">
        <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" class="block text-[11px]" role="img" :aria-label="`抗生素時間軸 ${t.from} 到 ${t.to}`">
          <!-- 日期 -->
          <g v-for="(d, i) in t.days" :key="d">
            <rect v-if="d === td" :x="LABEL_W + i * CELL" y="0" :width="CELL" :height="height" class="fill-amber-50" />
            <text :x="LABEL_W + i * CELL + CELL / 2" :y="HEAD - 10" text-anchor="middle" :class="d === td ? 'fill-amber-700 font-semibold' : 'fill-slate-500'">{{ dayLabel(d, i) }}</text>
            <line :x1="LABEL_W + i * CELL" :x2="LABEL_W + i * CELL" :y1="HEAD - 4" :y2="height" class="stroke-slate-100" />
          </g>
          <!-- 抗生素 -->
          <g v-for="(r, ri) in t.rows" :key="r.drugId">
            <text x="6" :y="HEAD + ri * ROW + 15" class="fill-slate-800">{{ r.name.length > 18 ? `${r.name.slice(0, 17)}…` : r.name }}<title>{{ r.name }}{{ r.restricted ? '（管制性抗生素）' : '' }}：{{ r.first.slice(5).replace('-', '/') }}–{{ r.last.slice(5).replace('-', '/') }}，給藥 {{ r.dot }} 天</title></text>
            <text :x="LABEL_W - 6" :y="HEAD + ri * ROW + 15" text-anchor="end" class="fill-slate-400">{{ r.dot }} 天</text>
            <template v-for="(c, ci) in r.cells" :key="c.date">
              <rect
                v-if="c.given || c.ordered"
                :x="LABEL_W + ci * CELL + 2" :y="HEAD + ri * ROW + 4" :width="CELL - 4" :height="ROW - 8" rx="3"
                :class="c.given ? (r.restricted ? 'fill-amber-500' : 'fill-sky-500') : (r.restricted ? 'fill-white stroke-amber-500' : 'fill-white stroke-sky-500')"
                stroke-width="1.5"
              ><title>{{ c.date.slice(5).replace('-', '/') }} {{ r.name }}：{{ c.given ? `給 ${c.given} 劑` : '有醫囑、沒有給藥' }}</title></rect>
            </template>
          </g>
          <line x1="0" :x2="width" :y1="extraY - 4" :y2="extraY - 4" class="stroke-slate-200" />
          <!-- 培養：空心＝送檢、實心＝報告（點了看藥敏） -->
          <text x="6" :y="extraY + 15" class="fill-slate-600">細菌培養</text>
          <!-- 先畫所有送檢（空心），再畫報告（實心）：同一天送檢與報告時，報告不會被下一份培養的送檢圈蓋住 -->
          <circle v-for="c in t.cultures.filter((x) => col(x.orderedAt) >= 0)" :key="`o-${c.id}`" :cx="cx(c.orderedAt)" :cy="extraY + 11" r="4" class="cursor-pointer fill-white stroke-violet-500" stroke-width="1.5" @click="selCulture = selCulture === c.id ? undefined : c.id"><title>{{ c.orderedAt.slice(5).replace('-', '/') }} 送檢（{{ c.specimen }}）</title></circle>
          <circle v-for="c in t.cultures.filter((x) => col(x.reportedAt) >= 0)" :key="`r-${c.id}`" :cx="cx(c.reportedAt)" :cy="extraY + 11" r="6" :class="['cursor-pointer', c.culture.isolates.length ? 'fill-violet-600' : 'fill-emerald-500']" :stroke="selCulture === c.id ? '#1e293b' : 'none'" stroke-width="2" @click="selCulture = selCulture === c.id ? undefined : c.id"><title>{{ c.reportedAt.slice(5).replace('-', '/') }} 報告（{{ c.specimen }}）：{{ c.summary }}——點了看藥敏</title></circle>
          <!-- 肌酸酐、谷濃度 -->
          <template v-for="(k, ki) in (['cre', 'vant'] as const)" :key="k">
            <text x="6" :y="extraY + (ki + 1) * ROW + 15" class="fill-slate-600">{{ k === 'cre' ? '肌酸酐' : 'Vanco 谷濃度' }}</text>
            <text v-for="l in labsOn(k)" :key="l.date" :x="cx(l.date)" :y="extraY + (ki + 1) * ROW + 15" text-anchor="middle" :class="l.last.flag ? 'fill-red-600 font-semibold' : 'fill-slate-700'">
              {{ l.last.value }}<title>{{ l.all.map((x) => `${x.at.slice(5).replace('-', '/')} ${x.label} ${x.value}${x.flag === 'H' ? '↑' : x.flag === 'L' ? '↓' : ''}`).join('\n') }}</title>
            </text>
          </template>
          <!-- 感染科建議 -->
          <text x="6" :y="extraY + 3 * ROW + 15" class="fill-slate-600">感染科建議</text>
          <g v-for="(a, ai) in t.advice.filter((x) => col(x.at) >= 0)" :key="ai">
            <rect :x="cx(a.at) - 5" :y="extraY + 3 * ROW + 6" width="10" height="10" :transform="`rotate(45 ${cx(a.at)} ${extraY + 3 * ROW + 11})`" :class="a.statusLabel === '已接受' ? 'fill-emerald-500' : a.statusLabel === '不接受' ? 'fill-red-500' : 'fill-sky-600'"><title>{{ a.at.slice(5).replace('-', '/') }} {{ a.kindLabel }}（{{ a.orderText }}）：{{ a.note }}——{{ a.statusLabel }}</title></rect>
          </g>
        </svg>
      </div>
      <p class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        <span><span class="mr-1 inline-block h-2.5 w-4 rounded-sm bg-sky-500 align-middle" />當天有給藥</span>
        <span><span class="mr-1 inline-block h-2.5 w-4 rounded-sm bg-amber-500 align-middle" />管制性抗生素</span>
        <span><span class="mr-1 inline-block h-2.5 w-4 rounded-sm border-2 border-sky-500 bg-white align-middle" />有醫囑、沒有給藥</span>
        <span>培養：空心圈送檢、紫色長菌、綠色無菌生長（點圈看藥敏）</span>
        <span>菱形：感染科建議（綠接受、紅不接受、藍待回覆）</span>
        <span>滑鼠移到格子上看細節</span>
      </p>
      <div v-if="culture" class="rounded border border-violet-200 bg-violet-50/40 p-3">
        <div class="mb-1 text-sm font-medium text-slate-800">{{ culture.reportedAt.slice(5).replace('-', '/') }} {{ culture.specimen }}培養：{{ culture.summary }}</div>
        <CultureView :culture="culture.culture" />
      </div>
    </div>
  </UQueryState>
</template>
