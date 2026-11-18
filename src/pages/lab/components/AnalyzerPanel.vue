<script setup lang="ts">
// 檢驗儀器（醫檢師）：上方「待上機」（已收件、上儀器的項目）掃條碼或按「上機」→ 儀器回傳 → 自動審核；
// 通過的直接發報告（列在「今天自動發出」），沒通過的進「待審核」：標出哪一條（品管、危急值、差異檢查、超出可測範圍）、
// 上一次的值，醫檢師「確認發出」（可改值）或「重測」。規則在服務層 analyzer-rules／analyzer.ts
import { reactive, ref } from 'vue'
import { Cpu, RotateCcw, ScanLine, Send } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UInput, UQueryState } from '@/components/ui'
import { analyzerApi, AUTO_RULE_LABEL, LAB_FLAG_TEXT, type AnalyzerHeldView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => analyzerApi.analyzerBoard())
const code = ref('')
const load = useAction(analyzerApi.loadAnalyzer, { success: (r) => `上機完成：自動發出 ${r.auto} 份${r.held ? `，${r.held} 份待審核` : ''}` })
async function onScan() {
  if (code.value.trim() && (await load.run(code.value.trim()))) code.value = ''
}
// 審核時可改值（換一筆、重測後重設）
const edits = reactive<Record<string, Record<string, string>>>({})
const editOf = (h: AnalyzerHeldView) => (edits[`${h.id}:${h.reruns.length}`] ??= Object.fromEntries(h.rows.map((r) => [r.code, r.value])))
const release = useAction(analyzerApi.releaseAnalyzer, { success: '已審核發出報告' })
const rerun = useAction(analyzerApi.rerunAnalyzer, { success: (x) => (x.holds.length ? `重測完成，仍有 ${x.holds.length} 條沒通過：請確認後發出` : '重測完成，規則都通過了：請確認後發出') })
const RULE_TONE = { qc: 'yellow', critical: 'red', delta: 'purple', amr: 'gray' } as const
</script>

<template>
  <UQueryState :loading="loading && !data" :ready="!!data">
    <div v-if="data" class="space-y-4">
      <div class="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 bg-white px-4 py-2 text-sm">
        <Cpu class="h-4 w-4 text-slate-500" />
        <span>今天上機 <b class="tabular">{{ data.today.total }}</b> 份，自動審核發出 <b class="tabular">{{ data.today.auto }}</b> 份</span>
        <UBadge :tone="data.today.pct >= 70 ? 'green' : 'yellow'">自動發報告 {{ data.today.pct }}%</UBadge>
        <span class="text-xs text-slate-500">只有數值型、上儀器的項目（CBC、生化、電解質、血糖）；尿液、快篩、培養、血液氣體照舊人工登打</span>
      </div>

      <UCard :padded="false">
        <template #title><span class="flex items-center gap-2 text-sm font-semibold">待上機 <UBadge v-if="data.toLoad.length" tone="blue">{{ data.toLoad.length }}</UBadge></span></template>
        <div class="space-y-2 p-3 text-sm">
          <form class="flex items-end gap-2" @submit.prevent="onScan">
            <UInput v-model="code" class="flex-1" label="掃檢體條碼上機" placeholder="S2026…" />
            <UButton type="submit" :icon="ScanLine" :loading="load.pending.value">上機</UButton>
          </form>
          <p v-if="!data.toLoad.length" class="text-xs text-slate-400">沒有待上機的檢體（要先收件）</p>
          <ul v-else class="divide-y divide-slate-100 rounded border border-slate-200">
            <li v-for="s in data.toLoad" :key="s.barcode" class="flex flex-wrap items-center gap-2 px-2 py-1.5">
              <span class="tabular text-xs">{{ s.barcode }}</span><b>{{ s.patientName }}</b><span class="text-xs text-slate-500">{{ s.where }}</span>
              <span class="min-w-0 flex-1 text-xs text-slate-700">{{ s.tests.join('、') }}</span>
              <UButton size="sm" variant="secondary" :loading="load.pending.value" @click="load.run(s.barcode)">上機</UButton>
            </li>
          </ul>
        </div>
      </UCard>

      <UCard :padded="false">
        <template #title><span class="flex items-center gap-2 text-sm font-semibold">待審核（沒通過自動審核） <UBadge v-if="data.held.length" tone="red">{{ data.held.length }}</UBadge></span></template>
        <p v-if="!data.held.length" class="px-4 py-3 text-sm text-slate-400">沒有待審核的儀器結果</p>
        <ul v-else class="divide-y divide-slate-200">
          <li v-for="h in data.held" :key="h.id" class="space-y-2 px-4 py-3 text-sm">
            <div class="flex flex-wrap items-center gap-2">
              <b>{{ h.patientName }}</b><span class="text-xs text-slate-500">{{ h.chartNo }}・{{ h.where }}</span>
              <span>{{ h.procName }}</span><span class="tabular text-xs text-slate-500">{{ h.barcode }}・上機 {{ h.loadedAt.slice(11) }}{{ h.reruns.length ? `・重測 ${h.reruns.length} 次` : '' }}</span>
              <span class="ml-auto flex flex-wrap gap-1"><UBadge v-for="r in [...new Set(h.holds.map((x) => x.rule))]" :key="r" :tone="RULE_TONE[r]">{{ AUTO_RULE_LABEL[r] }}</UBadge></span>
            </div>
            <div class="overflow-x-auto"><table class="w-full min-w-[34rem] text-xs">
              <thead class="text-left text-slate-500"><tr><th class="py-1">項目</th><th>儀器值</th><th>參考範圍</th><th>上一次</th><th>沒通過</th></tr></thead>
              <tbody>
                <tr v-for="r in h.rows" :key="r.code" :class="['border-t border-slate-100', r.holds.length && 'bg-red-50']">
                  <td class="py-1 pr-2">{{ r.name }}<span v-if="r.unit" class="block text-[11px] text-slate-400">{{ r.unit }}</span></td>
                  <td class="w-28 pr-2"><UInput v-model="editOf(h)[r.code]" :aria-label="`${r.name} 數值`" inputmode="decimal" /></td>
                  <td class="pr-2 text-slate-600">{{ r.ref }} <span :class="['font-semibold', r.critical ? 'text-red-700' : 'text-amber-700']">{{ r.critical ? '危急' : LAB_FLAG_TEXT[r.flag] }}</span></td>
                  <td class="tabular pr-2 text-slate-600">{{ r.prev ? `${r.prev.value}（${r.prev.at.slice(5, 10)}）` : '—' }}</td>
                  <td class="text-red-800">{{ r.holds.join('；') }}</td>
                </tr>
              </tbody>
            </table></div>
            <p v-if="h.holds.some((x) => !x.code)" class="text-xs text-red-800">{{ h.holds.filter((x) => !x.code).map((x) => x.text).join('；') }}</p>
            <p v-if="h.reruns.length" class="text-xs text-slate-500">重測前：{{ h.reruns.map((x) => Object.entries(x.values).map(([k, v]) => `${k} ${v}`).join('、')).join(' → ') }}</p>
            <div class="flex justify-end gap-2">
              <UButton size="sm" variant="secondary" :icon="RotateCcw" :loading="rerun.pending.value" @click="rerun.run(h.id)">重測</UButton>
              <UButton size="sm" :icon="Send" :loading="release.pending.value" @click="release.run(h.id, editOf(h))">確認發出</UButton>
            </div>
          </li>
        </ul>
      </UCard>

      <UCard v-if="data.autoToday.length" title="今天自動審核發出" :padded="false">
        <ul class="divide-y divide-slate-100 text-sm">
          <li v-for="a in data.autoToday" :key="a.no" class="flex flex-wrap items-center gap-2 px-4 py-1.5">
            <span class="tabular text-xs text-slate-500">{{ a.at.slice(11) }}</span><span class="tabular text-xs">{{ a.no }}</span><b>{{ a.patientName }}</b><span class="text-xs text-slate-700">{{ a.procName }}</span>
          </li>
        </ul>
      </UCard>
    </div>
  </UQueryState>
</template>
