<script setup lang="ts">
// 給藥與採檢的掃描統計（病房層級）：某一天已給的藥有幾筆掃描核對、幾筆略過（原因、誰、哪一劑）；採的檢體幾支掃描、幾支略過；
// 以及掃描不符（差點給錯、差點採錯）的紀錄。
// 護理長看略過的比例與原因（掃描器常壞、腕帶常弄濕，就是要處理的事）。數字由服務層算（scan.scanStats）
import { ref } from 'vue'
import { UBadge, UInput, UQueryState } from '@/components/ui'
import { scanApi } from '@/services'
import { useQuery } from '@/composables/useService'
import { today } from '@/utils/date'

const props = defineProps<{ ward: string }>()
const date = ref(today())
const { data: st, loading } = useQuery(() => scanApi.scanStats(props.ward, date.value), [() => props.ward, date])
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—')
</script>

<template>
  <div class="space-y-4 p-4 text-sm">
    <div class="flex flex-wrap items-end gap-3">
      <div class="w-44"><UInput v-model="date" type="date" :max="today()" label="日期" /></div>
      <p class="text-xs text-slate-500">以病人現在所在的病房計算；不需要掃描時（設定關閉）給的藥另列。</p>
    </div>
    <UQueryState :loading="loading && !st" :ready="!!st">
      <template v-if="st">
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="rounded-md border border-slate-200 px-3 py-2"><div class="text-xs text-slate-500">已給藥</div><div class="tabular text-2xl font-bold">{{ st.given }}</div></div>
          <div class="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2"><div class="text-xs text-emerald-700">掃描核對</div><div class="tabular text-2xl font-bold text-emerald-800">{{ st.scanned }} <span class="text-sm font-normal">{{ pct(st.scanned, st.given) }}</span></div></div>
          <div class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2"><div class="text-xs text-amber-700">略過掃描</div><div class="tabular text-2xl font-bold text-amber-800">{{ st.skipped }} <span class="text-sm font-normal">{{ pct(st.skipped, st.given) }}</span></div></div>
          <div class="rounded-md border border-red-200 bg-red-50 px-3 py-2"><div class="text-xs text-red-700">掃描不符（已擋下）</div><div class="tabular text-2xl font-bold text-red-800">{{ st.mismatches.length }}</div></div>
        </div>
        <p v-if="st.notRequired" class="text-xs text-slate-500">另有 {{ st.notRequired }} 筆是不需要掃描時給的（設定關閉）。</p>
        <div class="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 px-3 py-2 text-xs">
          <b class="text-sm">採檢</b><span>採了 <b class="tabular">{{ st.specimens.collected }}</b> 支</span>
          <span class="text-emerald-700">掃描核對 <b class="tabular">{{ st.specimens.scanned }}</b>（{{ pct(st.specimens.scanned, st.specimens.collected) }}）</span>
          <span class="text-amber-700">略過 <b class="tabular">{{ st.specimens.skipped }}</b></span>
          <span v-if="st.specimens.notRequired" class="text-slate-500">設定關閉時採的 {{ st.specimens.notRequired }}</span>
        </div>

        <section>
          <h3 class="mb-1.5 font-semibold text-slate-700">略過掃描</h3>
          <p v-if="!st.skips.length && !st.specimens.skips.length" class="text-slate-400">沒有略過</p>
          <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
            <li v-for="(x, i) in [...st.skips, ...st.specimens.skips].sort((a, b) => b.at.localeCompare(a.at))" :key="i" class="flex flex-wrap items-center gap-x-3 px-3 py-1.5">
              <span class="tabular w-12">{{ x.at.slice(11) }}</span>
              <span class="w-32">{{ x.bedNo }} {{ x.patientName }}</span>
              <span class="min-w-0 flex-1 truncate">{{ x.content }}</span>
              <UBadge tone="yellow">{{ x.reason }}</UBadge>
              <span v-if="x.note" class="text-xs text-slate-500">{{ x.note }}</span>
              <span class="text-xs text-slate-500">{{ x.nurseName }}</span>
            </li>
          </ul>
        </section>

        <section>
          <h3 class="mb-1.5 font-semibold text-slate-700">掃描不符（差點給錯、差點採錯）</h3>
          <p v-if="!st.mismatches.length" class="text-slate-400">沒有</p>
          <ul v-else class="divide-y divide-slate-100 rounded-md border border-red-200">
            <li v-for="(x, i) in st.mismatches" :key="i" class="flex flex-wrap items-center gap-x-3 px-3 py-1.5">
              <span class="tabular w-12">{{ x.at.slice(11) }}</span>
              <span class="w-32">{{ x.bedNo }} {{ x.patientName }}</span>
              <span class="min-w-0 flex-1 truncate">{{ x.content }}</span>
              <UBadge tone="red">{{ x.kind === 'patient' ? '病人不符' : x.kind === 'specimen' ? '檢體不符' : '藥品不符' }}</UBadge>
              <span class="w-full text-xs text-red-700">{{ x.message }}（{{ x.nurseName }}）
                <span v-if="x.reported" class="ml-1 text-slate-500">已通報</span>
                <RouterLink v-else :to="{ name: 'incidents', query: { fromScan: x.id } }" class="ml-1 text-blue-700 underline">通報病安事件</RouterLink></span>
            </li>
          </ul>
        </section>
      </template>
    </UQueryState>
  </div>
</template>
