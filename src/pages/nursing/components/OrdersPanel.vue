<script setup lang="ts">
// 護理站「醫囑」：這位病人目前有效的醫囑，依類別分組，飲食在最前面。
// 24 小時內新開的標「新」，24 小時內停止或完成的仍列出（劃掉）——接班的人要知道上一班之後改了什麼。
// 判斷「新／已停」在服務層（nursing-rules.orderChange），頁面只負責呈現。
//
// 核對可以逐筆（每筆「核對」），也可以整批（上方「全部核對」，交班時常用）。
// 對某一筆有疑問：「有疑問」寫原因 → 退回醫師；醫師回覆前不能核對、給藥暫停（服務層擋）。
// 醫師回覆「確認無誤」後要再核對一次（看到回覆才簽收）；醫師停止那筆就自動結案。
import { computed, ref } from 'vue'
import { UBadge, UButton, UQueryState } from '@/components/ui'
import { CheckCheck, HelpCircle } from 'lucide-vue-next'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { nursingApi, type AdmissionView } from '@/services'
import type { NursingOrderView } from '@/services/nursing'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ admission: AdmissionView }>()
const { data, loading } = useQuery(
  async () => ({ id: props.admission.id, groups: await nursingApi.listNursingOrders(props.admission.id) }),
  [() => props.admission.id],
)
// 切換病人時，舊病人的醫囑在新資料回來前不顯示
const groups = computed(() => (data.value?.id === props.admission.id ? data.value.groups : undefined))

// 整批核對：只送出畫面上看得到、還沒核對、沒有疑問的那幾筆（醫師剛好又開的新醫囑，沒顯示前不會被一起簽掉）
const all = computed(() => (groups.value ?? []).flatMap((g) => g.orders))
const unacked = computed(() => all.value.filter((o) => o.needsAck))
const ackable = computed(() => unacked.value.filter((o) => !o.pendingQuery))
const queried = computed(() => all.value.filter((o) => o.pendingQuery))
const ack = useAction(nursingApi.ackOrders, { success: (r) => `已核對 ${r.count} 項醫囑${r.skipped ? `（${r.skipped} 項有疑問待醫師回覆，未核對）` : ''}` })
const onAckAll = () => ack.run(props.admission.id, ackable.value.map((o) => o.id))
const ackOne = (o: NursingOrderView) => ack.run(props.admission.id, [o.id])

// 有疑問 → 退回醫師
const asking = ref<NursingOrderView | null>(null)
const askOpen = computed({ get: () => !!asking.value, set: (v) => !v && (asking.value = null) })
const ask = useAction(nursingApi.queryOrder, { success: '已退回醫師：醫師回覆前這筆醫囑暫停執行' })
async function confirmAsk(reason: string) {
  if (asking.value && (await ask.run(asking.value.id, reason))) asking.value = null
}

const md = (s?: string) => (s ? `${s.slice(5, 10).replace('-', '/')} ${s.slice(11)}` : '')
</script>

<template>
  <div class="space-y-4 p-4">
    <div v-if="unacked.length || queried.length" class="flex flex-wrap items-center gap-3 rounded-md border border-cyan-300 bg-cyan-50 px-3 py-2 text-sm text-cyan-900">
      <span class="min-w-0 flex-1">
        <template v-if="unacked.length">有 <b>{{ unacked.length }}</b> 項醫囑異動尚未核對</template>
        <template v-if="queried.length">{{ unacked.length ? '；' : '' }}<b class="text-amber-800">{{ queried.length }}</b> 項有疑問、待醫師回覆（執行暫停）</template>
      </span>
      <UButton v-if="ackable.length" size="sm" :icon="CheckCheck" :loading="ack.pending.value" @click="onAckAll">全部核對（{{ ackable.length }} 項）</UButton>
    </div>
    <UQueryState :loading="loading && !groups" :ready="!!groups?.length" empty-title="目前沒有醫囑">
      <section v-for="g in groups" :key="g.category" class="mb-4 last:mb-0">
        <h3 class="mb-2 text-sm font-semibold text-slate-700">{{ g.label }}</h3>
        <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
          <li
            v-for="o in g.orders"
            :key="o.id"
            :class="[
              'flex items-start gap-3 px-3 py-2 text-sm',
              o.pendingQuery ? 'border-l-4 border-l-amber-500 bg-amber-50/50' : o.needsAck ? 'border-l-4 border-l-cyan-500' : '',
              o.status !== 'active' && 'bg-slate-50 text-slate-400',
            ]"
          >
            <div class="min-w-0 flex-1">
              <div :class="['font-medium', o.status === 'active' ? 'text-slate-800' : 'line-through']">
                {{ o.content }}
                <template v-if="o.dose">・{{ o.dose }} {{ o.unit }}</template>
                <template v-if="o.freq">・{{ o.freqLabel }}</template><template v-if="o.timingShort">（{{ o.timingShort }}{{ o.timingSet ? '・醫師指定' : '' }}）</template>
                <template v-if="o.route">・{{ o.route }}</template>
              </div>
              <div class="text-xs text-slate-500">
                {{ o.type === 'stat' ? '臨時' : '長期' }}・{{ md(o.startAt) }} {{ o.doctorName }} 開立
                <template v-if="o.stopAt">・{{ md(o.stopAt) }} {{ o.status === 'done' ? '完成' : '停止' }}</template>
              </div>
              <div v-if="o.pendingQuery" class="mt-0.5 text-xs text-amber-800">疑問（{{ o.pendingQuery.byName }} {{ md(o.pendingQuery.at) }}）：{{ o.pendingQuery.reason }}・待醫師回覆，執行暫停</div>
              <div v-else-if="o.lastReply" class="mt-0.5 text-xs text-emerald-800">醫師回覆（{{ o.lastReply.byName }} {{ md(o.lastReply.at) }}）：{{ o.lastReply.reply }}</div>
            </div>
            <UBadge v-if="o.change === 'new'" tone="blue">新</UBadge>
            <UBadge v-else-if="o.change === 'stopped'" tone="gray">已停</UBadge>
            <UBadge v-else-if="o.change === 'done'" tone="green">已完成</UBadge>
            <UBadge v-if="o.highAlert" tone="purple">高警訊</UBadge>
            <UBadge v-if="o.pendingQuery" tone="yellow">待醫師回覆</UBadge>
            <template v-else>
              <UButton v-if="o.needsAck" size="sm" variant="secondary" :loading="ack.pending.value" @click="ackOne(o)">核對</UButton>
            </template>
            <UButton v-if="o.status === 'active' && !o.pendingQuery" size="sm" variant="ghost" :icon="HelpCircle" title="對這筆醫囑有疑問：退回醫師，回覆前暫停執行" @click="asking = o">有疑問</UButton>
          </li>
        </ul>
      </section>
    </UQueryState>

    <ReasonDialog
      v-model="askOpen"
      title="有疑問、退回醫師"
      :subject="asking ? `${asking.content}${asking.dose ? `・${asking.dose} ${asking.unit}` : ''}${asking.freq ? `・${asking.freqLabel}` : ''}` : ''"
      label="疑問（醫師會看到）"
      :presets="['劑量疑似過高', '頻率與一般用法不同', '病人有過敏史', '與其他醫囑重複']"
      ok-text="退回醫師"
      :pending="ask.pending.value"
      :error="ask.fieldErrors.value.reason"
      @confirm="confirmAsk"
    />
  </div>
</template>
