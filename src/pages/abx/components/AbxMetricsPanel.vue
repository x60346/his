<script setup lang="ts">
// 抗生素指標（醫師都能看）：最近 30 天的用量（每千住院人日 DDD、DOT；全院、病房、藥品，管制性抗生素標出）、
// 院內藥敏統計（最近一年、每病人每菌第一株、少於 30 株標株數不足）、抗生素管理介入的建議數與接受率。算法都在服務層 abx-metrics
import { computed } from 'vue'
import { UBadge, UCard, UQueryState } from '@/components/ui'
import { abxMetricsApi, AST_DRUGS, AST_MIN_ISOLATES } from '@/services'
import { useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => abxMetricsApi.abxMetrics())
const num = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '—' : v.toFixed(d))
// 藥敏表的欄：有出現在任何一種菌的藥敏組合裡的抗生素（依主檔順序）
const astCols = computed(() => AST_DRUGS.filter((d) => data.value?.antibiogram.rows.some((r) => r.drugs.some((x) => x.key === d.key))))
const cell = (r: NonNullable<typeof data.value>['antibiogram']['rows'][number], key: string) => r.drugs.find((x) => x.key === key)
// 敏感率顏色：80% 以上綠、50–80% 黃、以下紅（株數不足一律灰）
const tone = (pct: number | null, insufficient: boolean) => (pct === null || insufficient ? 'text-slate-400' : pct >= 80 ? 'text-emerald-700' : pct >= 50 ? 'text-amber-700' : 'font-semibold text-red-700')
</script>

<template>
  <UQueryState :loading="loading && !data" :ready="!!data">
    <div v-if="data" class="space-y-4">
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <UCard><div class="text-xs text-slate-500">DDD／千住院人日</div><div class="tabular text-2xl font-bold text-slate-800">{{ num(data.total.dddRate) }}</div></UCard>
        <UCard><div class="text-xs text-slate-500">DOT／千住院人日</div><div class="tabular text-2xl font-bold text-slate-800">{{ num(data.total.dotRate) }}</div></UCard>
        <UCard><div class="text-xs text-slate-500">DDD 合計</div><div class="tabular text-2xl font-bold text-slate-800">{{ num(data.total.ddd) }}</div></UCard>
        <UCard><div class="text-xs text-slate-500">住院人日</div><div class="tabular text-2xl font-bold text-slate-800">{{ data.total.patientDays }}</div></UCard>
      </div>
      <p class="text-xs text-slate-500">期間 {{ data.from }} – {{ data.to }}（最近 30 天）。依給藥紀錄（已給的才算），DDD＝WHO 每日定義劑量；DOT＝每位病人每支抗生素有給藥的天數。病人整段住院算在目前（或出院前）的病房。</p>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <UCard title="依病房" :padded="false">
          <div class="overflow-x-auto">
            <table class="tabular w-full text-sm">
              <thead class="bg-slate-50 text-xs text-slate-500"><tr><th class="px-3 py-2 text-left">病房</th><th class="px-3 py-2 text-right">住院人日</th><th class="px-3 py-2 text-right">DDD</th><th class="px-3 py-2 text-right">DDD／千人日</th><th class="px-3 py-2 text-right">DOT／千人日</th></tr></thead>
              <tbody class="divide-y divide-slate-100">
                <tr v-for="w in data.byWard" :key="w.ward"><td class="whitespace-nowrap px-3 py-1.5">{{ w.ward }}</td><td class="px-3 py-1.5 text-right">{{ w.patientDays }}</td><td class="px-3 py-1.5 text-right">{{ num(w.ddd) }}</td><td class="px-3 py-1.5 text-right">{{ num(w.dddRate) }}</td><td class="px-3 py-1.5 text-right">{{ num(w.dotRate) }}</td></tr>
                <tr class="bg-slate-50 font-semibold"><td class="px-3 py-1.5">全院</td><td class="px-3 py-1.5 text-right">{{ data.total.patientDays }}</td><td class="px-3 py-1.5 text-right">{{ num(data.total.ddd) }}</td><td class="px-3 py-1.5 text-right">{{ num(data.total.dddRate) }}</td><td class="px-3 py-1.5 text-right">{{ num(data.total.dotRate) }}</td></tr>
              </tbody>
            </table>
          </div>
        </UCard>
        <UCard title="依藥品" :padded="false">
          <p v-if="!data.byDrug.length" class="px-4 py-3 text-sm text-slate-500">最近 30 天沒有給過抗生素</p>
          <div v-else class="overflow-x-auto">
            <table class="tabular w-full text-sm">
              <thead class="bg-slate-50 text-xs text-slate-500"><tr><th class="px-3 py-2 text-left">藥品</th><th class="px-3 py-2 text-right">DDD</th><th class="px-3 py-2 text-right">DDD／千人日</th><th class="px-3 py-2 text-right">DOT</th><th class="px-3 py-2 text-right">DOT／千人日</th></tr></thead>
              <tbody class="divide-y divide-slate-100">
                <tr v-for="d in data.byDrug" :key="d.drugId"><td class="px-3 py-1.5"><span class="whitespace-nowrap">{{ d.name }}</span><UBadge v-if="d.restricted" tone="yellow" class="ml-1">管制性</UBadge></td><td class="px-3 py-1.5 text-right">{{ num(d.ddd) }}</td><td class="px-3 py-1.5 text-right">{{ num(d.dddRate) }}</td><td class="px-3 py-1.5 text-right">{{ d.dot }}</td><td class="px-3 py-1.5 text-right">{{ num(d.dotRate) }}</td></tr>
              </tbody>
            </table>
          </div>
        </UCard>
      </div>

      <UCard title="院內藥敏統計" :subtitle="`${data.antibiogram.from} – ${data.antibiogram.to}（最近一年）・每位病人每種菌只算第一株・敏感率 %（中等不算敏感）・少於 ${AST_MIN_ISOLATES} 株標「株數不足」`" :padded="false">
        <p v-if="!data.antibiogram.rows.length" class="px-4 py-3 text-sm text-slate-500">最近一年沒有長菌的培養</p>
        <div v-else class="overflow-x-auto">
          <table class="tabular w-full text-sm">
            <thead class="bg-slate-50 text-xs text-slate-500">
              <tr><th class="px-3 py-2 text-left">菌種</th><th class="px-3 py-2 text-right">株數</th><th v-for="c in astCols" :key="c.key" class="px-2 py-2 text-right" :title="c.name">{{ c.key }}</th></tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="r in data.antibiogram.rows" :key="r.organism" :class="r.insufficient && 'bg-slate-50/60'">
                <td class="px-3 py-1.5"><span class="whitespace-nowrap">{{ r.name }}</span><UBadge v-if="r.insufficient" tone="gray" class="ml-1">株數不足</UBadge></td>
                <td class="px-3 py-1.5 text-right">{{ r.isolates }}</td>
                <td v-for="c in astCols" :key="c.key" class="px-2 py-1.5 text-right" :title="cell(r, c.key) ? `${c.name}：${cell(r, c.key)!.susceptible}/${cell(r, c.key)!.tested} 株敏感` : '不測'">
                  <span v-if="cell(r, c.key)" :class="tone(cell(r, c.key)!.pct, r.insufficient)">{{ num(cell(r, c.key)!.pct, 0) }}</span>
                  <span v-else class="text-slate-300">·</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="px-4 py-2 text-xs text-slate-500">欄位：{{ astCols.map((c) => `${c.key} ${c.name}`).join('、') }}。綠 ≥80%、黃 50–80%、紅 &lt;50%；株數不足的灰色只供參考。</p>
        </div>
      </UCard>

      <UCard title="手術預防性抗生素（最近 30 天完成的手術）" subtitle="只算術前準備連了抗生素醫囑的手術；劃刀前 60 分鐘內給（Vancomycin 120）；24 小時內停藥看最後那筆醫囑，還沒滿 24 小時的不算分母">
        <div class="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div><div class="text-xs text-slate-500">手術台數</div><div class="tabular text-xl font-bold">{{ data.prophylaxis.surgeries }}</div></div>
          <div><div class="text-xs text-slate-500">劃刀前給藥時機符合</div><div class="tabular text-xl font-bold">{{ data.prophylaxis.timingRate === null ? '—' : `${data.prophylaxis.timingRate.toFixed(1)}%` }}</div><div class="tabular text-xs text-slate-500">{{ data.prophylaxis.timingOk }}／{{ data.prophylaxis.surgeries }} 台</div></div>
          <div><div class="text-xs text-slate-500">24 小時內停藥</div><div class="tabular text-xl font-bold">{{ data.prophylaxis.stopRate === null ? '—' : `${data.prophylaxis.stopRate.toFixed(1)}%` }}</div><div class="tabular text-xs text-slate-500">{{ data.prophylaxis.stoppedIn24 }}／{{ data.prophylaxis.stopKnown }} 台</div></div>
        </div>
      </UCard>

      <UCard title="抗生素管理介入（最近 30 天）" subtitle="接受率＝接受 ÷（接受＋不接受）；待回覆不算分母；「不用介入」不算建議" :padded="false">
        <div class="overflow-x-auto">
          <table class="tabular w-full text-sm">
            <thead class="bg-slate-50 text-xs text-slate-500"><tr><th class="px-3 py-2 text-left">建議類型</th><th class="px-3 py-2 text-right">建議</th><th class="px-3 py-2 text-right">接受</th><th class="px-3 py-2 text-right">不接受</th><th class="px-3 py-2 text-right">待回覆</th><th class="px-3 py-2 text-right">不用介入</th><th class="px-3 py-2 text-right">接受率</th></tr></thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="a in data.advice" :key="a.kind" :class="a.kind === 'total' && 'bg-slate-50 font-semibold'"><td class="whitespace-nowrap px-3 py-1.5">{{ a.label }}</td><td class="px-3 py-1.5 text-right">{{ a.sent }}</td><td class="px-3 py-1.5 text-right">{{ a.accepted }}</td><td class="px-3 py-1.5 text-right">{{ a.declined }}</td><td class="px-3 py-1.5 text-right">{{ a.pending }}</td><td class="px-3 py-1.5 text-right">{{ a.dismissed }}</td><td class="px-3 py-1.5 text-right">{{ a.rate === null ? '—' : `${a.rate.toFixed(1)}%` }}</td></tr>
            </tbody>
          </table>
        </div>
      </UCard>
    </div>
  </UQueryState>
</template>
