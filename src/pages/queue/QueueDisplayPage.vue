<script setup lang="ts">
// 抽血候診螢幕（掛在候診區，不用登入）：目前叫號（帶窗口號，其他窗口在叫的也列）、接下來五位、等候人數、今天平均等候分鐘。
// 只顯示號碼與遮過的姓名（王○明）；櫃台叫號後自動更新（多分頁同步）。資料在服務層 lab-desk.labQueueDisplay
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { labDeskApi } from '@/services'
import { useQuery } from '@/composables/useService'
import { now } from '@/utils/date'

const { data } = useQuery(() => labDeskApi.labQueueDisplay())
const clock = ref(now().slice(11))
let timer: number | undefined
onMounted(() => (timer = window.setInterval(() => (clock.value = now().slice(11)), 10000)))
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <div class="flex min-h-screen flex-col bg-slate-900 p-6 text-white">
    <header class="flex items-center justify-between text-xl text-slate-300">
      <span class="font-semibold">門診抽血櫃台・候診</span>
      <span class="tabular">{{ clock }}</span>
    </header>
    <main v-if="data" class="grid flex-1 grid-cols-1 gap-6 py-6 lg:grid-cols-[1.3fr_1fr]">
      <section class="flex flex-col items-center justify-center rounded-2xl bg-slate-800 p-8" aria-live="polite">
        <span class="text-2xl text-slate-300">請下列號碼到抽血櫃台</span>
        <span class="tabular my-4 text-[9rem] font-bold leading-none text-amber-300">{{ data.current ? data.current.no : '—' }}</span>
        <span v-if="data.current" class="text-4xl">{{ data.current.name }}<template v-if="data.current.window">　請到 <b class="text-amber-300">{{ data.current.window }} 號窗口</b></template></span>
        <span v-else class="text-2xl text-slate-400">請稍候</span>
        <ul v-if="data.calling.length > 1" class="mt-6 space-y-1 text-2xl text-slate-300">
          <li v-for="c in data.calling.slice(1)" :key="c.no" class="tabular">{{ c.no }} 號 {{ c.name }} → {{ c.window }} 號窗口</li>
        </ul>
      </section>
      <section class="flex flex-col rounded-2xl bg-slate-800 p-6">
        <h2 class="mb-4 text-2xl text-slate-300">接下來</h2>
        <p v-if="!data.next.length" class="text-xl text-slate-500">目前沒有人等候</p>
        <ol v-else class="space-y-3">
          <li v-for="n in data.next" :key="n.no" class="flex items-center gap-4 text-3xl">
            <span class="tabular w-24 font-bold">{{ n.no }}</span><span>{{ n.name }}</span>
            <span v-if="n.priority" class="rounded bg-violet-500 px-2 py-0.5 text-lg">優先</span>
          </li>
        </ol>
        <template v-if="data.nextDrop">
          <h3 class="mb-2 mt-6 text-xl text-amber-300">只交檢體（尿液、痰液）→ 3 號檢體窗口</h3>
          <p v-if="!data.nextDrop.length" class="text-lg text-slate-500">目前沒有</p>
          <ol v-else class="space-y-2">
            <li v-for="n in data.nextDrop" :key="n.no" class="flex items-center gap-4 text-2xl"><span class="tabular w-24 font-bold">{{ n.no }}</span><span>{{ n.name }}</span></li>
          </ol>
        </template>
        <div class="mt-auto space-y-1 pt-6 text-xl text-slate-300">
          <p>等候 <b class="tabular text-white">{{ data.waitingCount }}</b> 位</p>
          <p>今天平均等候 <b class="tabular text-white">{{ data.avgWait ?? '—' }}</b> 分鐘</p>
          <p class="text-base text-slate-400">75 歲以上、身心障礙、行動不便優先；叫三次未到請到櫃台重新排隊</p>
        </div>
      </section>
    </main>
  </div>
</template>
