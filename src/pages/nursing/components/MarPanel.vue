<script setup lang="ts">
// 給藥紀錄（MAR）：醫師開立 → 系統排程 → 護理師在這裡執行。
// 「逾時／待給／未到」由共用規則 marUrgency 依「現在時間」即時計算——時鐘走，顏色就跟著變，不必重新查詢。
// 服務層用同一條規則把關：未到時間按「給藥」會被擋下，畫面上的停用只是讓人不必白按。
import { computed, ref, watch } from 'vue'
import { Check, CircleSlash, Clock, Pause } from 'lucide-vue-next'
import { UBadge, UButton, UQueryState } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { MAR_EARLY_MIN, marUrgency, nursingApi, type AdmissionView, type MarView, type MarUrgency, type PrnView } from '@/services'
import type { OrderView } from '@/services/ipd'
import { useAction, useQuery } from '@/composables/useService'
import { followToday } from '@/composables/useClock'
import { useUi } from '@/stores/ui'
import { addDays, parseDate, today } from '@/utils/date'

const props = defineProps<{ admission: AdmissionView; clock: string }>()
const ui = useUi()

const date = ref(today())
// 跨過午夜時，原本看「今天」的會自動換到新的一天（大夜班不會看到昨天的給藥）
const todayStr = followToday(date)
const dateTabs = computed(() => [
  { key: addDays(todayStr.value, -1), label: '昨天' },
  { key: todayStr.value, label: '今天' },
  { key: addDays(todayStr.value, 1), label: '明天' },
])

// 回傳時帶上「這是誰、哪一天的資料」，切換病人時舊資料不會短暫套到新病人身上
const { data, loading } = useQuery(
  async () => {
    const id = props.admission.id
    const d = date.value
    return { id, d, board: await nursingApi.getMarBoard(id, d) }
  },
  [() => props.admission.id, date],
)
const board = computed(() => (data.value?.id === props.admission.id && data.value.d === date.value ? data.value.board : undefined))

const urgencyOf = (m: MarView): MarUrgency | null => (m.status === 'pending' ? marUrgency(m.scheduledAt, props.clock) : null)
const summary = computed(() => {
  const list = board.value?.mar ?? []
  return {
    overdue: list.filter((m) => urgencyOf(m) === 'overdue').length,
    due: list.filter((m) => urgencyOf(m) === 'due').length,
    done: list.filter((m) => m.status !== 'pending').length,
    total: list.length,
  }
})

const statusView = {
  given: { label: '已給藥', tone: 'green' },
  held: { label: '暫停', tone: 'gray' },
  refused: { label: '拒絕', tone: 'red' },
} as const
const urgencyView = {
  overdue: { label: '逾時', tone: 'red' },
  due: { label: '待給藥', tone: 'yellow' },
  upcoming: { label: '未到', tone: 'gray' },
} as const

const dose = (m: { dose?: number; unit: string; route?: string }) => `每次 ${m.dose ?? ''} ${m.unit}・${m.route ?? ''}`

// ---------- 執行 ----------
const exec = useAction(nursingApi.executeMar, { success: (m) => (m.status === 'given' ? '已記錄給藥' : '已記錄') })

async function give(m: MarView) {
  if (m.highAlert) {
    const ok = await ui.confirm({
      title: '高警訊藥品：雙人核對',
      message: `${m.content}\n${dose(m)}\n病人：${props.admission.bed?.bedNo} ${props.admission.patientName}\n\n請與另一位護理師核對病人、藥名、劑量、途徑、時間後再給藥。`,
      okText: '已雙人核對，給藥',
    })
    if (!ok) return
  }
  exec.run(m.id, 'given')
}

// 暫停、拒絕、PRN 共用一個原因對話框，以 reasonFor 記住「要做什麼」
type ReasonTarget = { kind: 'held' | 'refused'; mar: MarView } | { kind: 'prn'; order: PrnView }
const reasonFor = ref<ReasonTarget | null>(null)
const reasonOpen = computed({ get: () => !!reasonFor.value, set: (v) => !v && (reasonFor.value = null) })
const reasonConfig = computed(() => {
  const r = reasonFor.value
  if (!r) return { title: '', label: '', presets: [] as string[], subject: '' }
  if (r.kind === 'prn') {
    return { title: 'PRN 給藥', subject: `${r.order.content}・每次 ${r.order.dose} ${r.order.unit}・${r.order.route}`, label: '給藥原因', presets: ['體溫 38.5°C', '疼痛分數 6 分', '噁心嘔吐', '無法入睡'], okText: '給藥' }
  }
  return r.kind === 'held'
    ? { title: '暫停給藥', subject: `${r.mar.scheduledAt.slice(11)} ${r.mar.content}`, label: '暫停原因', presets: ['術前禁食', '病人外出檢查', '血壓過低', '依醫師指示'], okText: '暫停' }
    : { title: '病人拒絕', subject: `${r.mar.scheduledAt.slice(11)} ${r.mar.content}`, label: '拒絕原因', presets: ['病人表示不舒服不想吃', '病人擔心副作用', '已告知醫師'], okText: '記錄拒絕', danger: true }
})

const prn = useAction(nursingApi.givePrn, { success: '已記錄 PRN 給藥' })
// 換了對象就清掉上一次的欄位錯誤，否則對 A 藥的錯誤會出現在 B 藥的對話框裡
watch(reasonFor, () => {
  exec.fieldErrors.value = {}
  prn.fieldErrors.value = {}
})
const reasonPending = computed(() => exec.pending.value || prn.pending.value)
const reasonError = computed(() => exec.fieldErrors.value.note ?? prn.fieldErrors.value.note)
async function confirmReason(note: string) {
  const r = reasonFor.value
  if (!r) return
  const ok = r.kind === 'prn' ? await prn.run(r.order.id, note) : await exec.run(r.mar.id, r.kind, note)
  if (ok) reasonFor.value = null
}

/** 距今多久，例：3 小時前 */
function ago(at: string) {
  const min = Math.round((parseDate(props.clock).getTime() - parseDate(at).getTime()) / 60000)
  if (min < 1) return '剛剛'
  return min < 60 ? `${min} 分鐘前` : `${Math.floor(min / 60)} 小時前`
}

// ---------- 臨時醫囑 ----------
const done = useAction(nursingApi.completeStatOrder, { success: '已完成臨時醫囑' })
async function complete(o: OrderView) {
  if (await ui.confirm({ title: '執行臨時醫囑', message: `確認已完成「${o.content}」？`, okText: '已完成' })) done.run(o.id)
}
</script>

<template>
  <div class="space-y-5 p-4">
    <!-- 日期與摘要 -->
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex rounded-md border border-slate-200 p-0.5">
        <button
          v-for="t in dateTabs"
          :key="t.key"
          :class="['rounded px-3 py-1 text-sm', date === t.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100']"
          @click="date = t.key"
        >{{ t.label }}</button>
      </div>
      <div v-if="board" class="flex gap-2 text-sm">
        <UBadge v-if="summary.overdue" tone="red">逾時 {{ summary.overdue }}</UBadge>
        <UBadge v-if="summary.due" tone="yellow">待給藥 {{ summary.due }}</UBadge>
        <span class="tabular text-slate-500">已執行 {{ summary.done }} / {{ summary.total }}</span>
      </div>
      <span class="ml-auto text-xs text-slate-400">預定時間前 {{ MAR_EARLY_MIN }} 分鐘起可給藥</span>
    </div>

    <UQueryState :loading="loading && !board" :ready="!!board">
      <template v-if="board">
        <!-- 排程給藥 -->
        <section>
          <h3 class="mb-2 text-sm font-semibold text-slate-700">排程給藥</h3>
          <p v-if="!board.mar.length" class="text-sm text-slate-400">這一天沒有給藥排程</p>
          <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
            <li
              v-for="m in board.mar"
              :key="m.id"
              :class="['flex items-center gap-3 px-3 py-2 text-sm', urgencyOf(m) === 'overdue' && 'bg-red-50/60', m.status !== 'pending' && 'text-slate-500']"
            >
              <span :class="['tabular w-12 text-base font-semibold', urgencyOf(m) === 'overdue' ? 'text-red-700' : 'text-slate-700']">{{ m.scheduledAt.slice(11) }}</span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 font-medium text-slate-800">
                  {{ m.content }}
                  <UBadge v-if="m.highAlert" tone="purple">高警訊</UBadge>
                  <UBadge v-if="m.orderType === 'stat'" tone="blue">STAT</UBadge>
                </div>
                <div class="tabular text-xs text-slate-500">{{ dose(m) }}<template v-if="m.freq">・{{ m.freq }}</template></div>
                <div v-if="m.note" class="text-xs text-slate-600">原因：{{ m.note }}</div>
              </div>

              <template v-if="m.status === 'pending'">
                <UBadge :tone="urgencyView[urgencyOf(m)!].tone">{{ urgencyView[urgencyOf(m)!].label }}</UBadge>
                <div class="flex gap-1">
                  <UButton size="sm" variant="success" :icon="Check" :disabled="urgencyOf(m) === 'upcoming'" :title="urgencyOf(m) === 'upcoming' ? '尚未到給藥時間' : ''" @click="give(m)">給藥</UButton>
                  <UButton size="sm" variant="secondary" :icon="Pause" @click="reasonFor = { kind: 'held', mar: m }">暫停</UButton>
                  <UButton size="sm" variant="ghost" :icon="CircleSlash" @click="reasonFor = { kind: 'refused', mar: m }">拒絕</UButton>
                </div>
              </template>
              <template v-else>
                <UBadge :tone="statusView[m.status].tone">{{ statusView[m.status].label }}</UBadge>
                <div class="tabular w-40 text-right text-xs">{{ m.executedAt?.slice(11) }}・{{ m.nurseName }}</div>
              </template>
            </li>
          </ul>
        </section>

        <!-- PRN -->
        <section v-if="date === todayStr">
          <h3 class="mb-2 text-sm font-semibold text-slate-700">需要時給藥（PRN）</h3>
          <p v-if="!board.prn.length" class="text-sm text-slate-400">沒有 PRN 醫囑</p>
          <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
            <li v-for="o in board.prn" :key="o.id" class="flex items-center gap-3 px-3 py-2 text-sm">
              <div class="min-w-0 flex-1">
                <div class="font-medium text-slate-800">{{ o.content }}</div>
                <div class="tabular text-xs text-slate-500">{{ dose(o) }}・PRN</div>
              </div>
              <span class="flex items-center gap-1 text-xs text-slate-500">
                <Clock class="h-3.5 w-3.5" />
                <template v-if="o.lastGivenAt">上次 {{ o.lastGivenAt.slice(5) }}（{{ ago(o.lastGivenAt) }}）</template>
                <template v-else>尚未使用</template>
              </span>
              <UButton size="sm" variant="secondary" @click="reasonFor = { kind: 'prn', order: o }">給藥</UButton>
            </li>
          </ul>
        </section>

        <!-- 臨時醫囑 -->
        <section v-if="date === todayStr">
          <h3 class="mb-2 text-sm font-semibold text-slate-700">待執行臨時醫囑</h3>
          <p v-if="!board.stat.length" class="text-sm text-slate-400">沒有待執行的臨時醫囑</p>
          <ul v-else class="divide-y divide-slate-100 rounded-md border border-amber-200 bg-amber-50/40">
            <li v-for="o in board.stat" :key="o.id" class="flex items-center gap-3 px-3 py-2 text-sm">
              <div class="min-w-0 flex-1">
                <div class="font-medium text-slate-800">{{ o.content }}</div>
                <div class="tabular text-xs text-slate-500">{{ o.startAt.slice(5) }} 開立・{{ o.doctorName }}</div>
              </div>
              <UButton size="sm" :icon="Check" @click="complete(o)">完成</UButton>
            </li>
          </ul>
        </section>
      </template>
    </UQueryState>

    <ReasonDialog
      v-model="reasonOpen"
      v-bind="reasonConfig"
      :pending="reasonPending"
      :error="reasonError"
      @confirm="confirmReason"
    />
  </div>
</template>
