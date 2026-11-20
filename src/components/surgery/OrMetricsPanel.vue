<script setup lang="ts">
// 手術室效率（最近 N 天）：首台準時開刀率、換台時間、各房使用率、當天取消（含原因）。
// 計算都在服務層（surgery.orMetrics、or-metrics-rules）；這裡只畫
import { ref } from 'vue'
import { UQueryState, USelect } from '@/components/ui'
import { OR_ONTIME_MINUTES, surgeryApi } from '@/services'
import { useQuery } from '@/composables/useService'

const days = ref<string | number | undefined>(30)
const { data: m, loading } = useQuery(() => surgeryApi.orMetrics(Number(days.value)), [days])
const pctText = (x: number | null) => (x === null ? '—' : `${x}%`)
</script>

<template>
  <div class="space-y-3 text-sm">
    <div class="flex flex-wrap items-end gap-3">
      <div class="w-36"><USelect v-model="days" label="期間" :options="[{ label: '最近 7 天', value: 7 }, { label: '最近 30 天', value: 30 }, { label: '最近 90 天', value: 90 }]" /></div>
      <p v-if="m" class="pb-2 text-xs text-slate-500">{{ m.from }} ～ {{ m.to }}・急刀不算首台與換台（使用率照算）</p>
    </div>
    <UQueryState :loading="loading && !m" :ready="!!m">
      <template v-if="m">
        <div class="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(13rem,1fr))]">
          <section class="rounded-md border border-slate-200 bg-white p-3">
            <div class="text-xs text-slate-500">首台準時開刀率</div>
            <div class="tabular text-2xl font-semibold" :class="m.firstCase.pct !== null && m.firstCase.pct < 80 ? 'text-red-700' : 'text-slate-800'">{{ pctText(m.firstCase.pct) }}</div>
            <div class="text-xs text-slate-500">{{ m.firstCase.ontime }}/{{ m.firstCase.total }} 台：麻醉前查核在排程開始 {{ OR_ONTIME_MINUTES }} 分鐘內</div>
          </section>
          <section class="rounded-md border border-slate-200 bg-white p-3">
            <div class="text-xs text-slate-500">平均換台時間</div>
            <div class="tabular text-2xl font-semibold text-slate-800">{{ m.turnover.avg === null ? '—' : `${m.turnover.avg} 分` }}</div>
            <div class="text-xs text-slate-500">{{ m.turnover.count }} 次：前一台離開前查核 → 下一台麻醉前查核</div>
          </section>
          <section class="rounded-md border border-slate-200 bg-white p-3">
            <div class="text-xs text-slate-500">當天取消率</div>
            <div class="tabular text-2xl font-semibold text-slate-800">{{ pctText(m.cancel.pct) }}</div>
            <div class="text-xs text-slate-500">{{ m.cancel.sameDay }}/{{ m.cancel.scheduled }} 台：排了程、手術當天才取消</div>
          </section>
          <section class="rounded-md border border-slate-200 bg-white p-3">
            <div class="text-xs text-slate-500">被急刀順延</div>
            <div class="tabular text-2xl font-semibold text-slate-800">{{ m.delays.count }} 台</div>
            <div class="text-xs text-slate-500">{{ m.delays.count ? `平均延後 ${m.delays.avg} 分、最多 ${m.delays.max} 分` : '沒有' }}（以被順延那天算）</div>
          </section>
        </div>

        <section class="rounded-md border border-slate-200 bg-white p-3">
          <h4 class="mb-2 font-semibold text-slate-700">各房使用率<span class="ml-2 text-xs font-normal text-slate-500">在房時間（麻醉前查核到離開前查核，只算開放時段 08:00–20:00）÷ 開放時間</span></h4>
          <div v-for="r in m.utilization" :key="r.room" class="mb-1 flex items-center gap-2">
            <span class="w-10 text-slate-700">{{ r.room }}</span>
            <div class="h-3 flex-1 rounded bg-slate-100"><div class="h-3 rounded bg-brand-500" :style="{ width: `${Math.min(r.pct, 100)}%` }" /></div>
            <span class="tabular w-40 text-right text-xs text-slate-600">{{ r.pct }}%（{{ Math.round(r.usedMinutes / 6) / 10 }} 小時{{ m.turnover.byRoom[r.room] ? `・換台 ${m.turnover.byRoom[r.room].avg} 分` : '' }}）</span>
          </div>
        </section>

        <div class="grid gap-3 md:grid-cols-2">
          <section class="rounded-md border border-slate-200 bg-white p-3">
            <h4 class="mb-1 font-semibold text-slate-700">首台延誤</h4>
            <p v-if="!m.firstCase.late.length" class="text-xs text-slate-400">沒有</p>
            <ul class="space-y-0.5 text-xs">
              <li v-for="x in m.firstCase.late" :key="x.no" class="tabular">{{ x.date.slice(5) }} {{ x.room }} {{ x.no }}：晚 {{ x.minutes }} 分{{ x.open ? '（還沒做麻醉前查核）' : '' }}</li>
            </ul>
          </section>
          <section class="rounded-md border border-slate-200 bg-white p-3">
            <h4 class="mb-1 font-semibold text-slate-700">當天取消的原因</h4>
            <p v-if="!m.cancel.reasons.length" class="text-xs text-slate-400">沒有</p>
            <ul class="space-y-0.5 text-xs">
              <li v-for="x in m.cancel.reasons" :key="x.no">{{ x.date.slice(5) }} {{ x.no }} {{ x.patientName }}：{{ x.reason }}</li>
            </ul>
          </section>
        </div>
      </template>
    </UQueryState>
  </div>
</template>
