<script setup lang="ts">
// 給藥紀錄（MAR）：醫師開立 → 系統排程 → 護理師在這裡執行。
// 「逾時／待給／未到」由共用規則 marUrgency 依「現在時間」即時計算——時鐘走，顏色就跟著變，不必重新查詢。
// 服務層用同一條規則把關：未到時間按「給藥」會被擋下，畫面上的停用只是讓人不必白按。
import { computed, ref, watch } from 'vue'
import { Check, CircleSlash, Clock, History, Pause } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UQueryState } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import WitnessDialog from '@/components/WitnessDialog.vue'
import { checkGivenAt, MAR_BACKDATE_MAX_MIN, MAR_EARLY_MIN, marUrgency, nursingApi, witnessApi, type AdmissionView, type MarView, type MarUrgency, type PrnView } from '@/services'
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

const dose = (m: { dose?: number; unit: string; route?: string; doseStrength?: string }) => `每次 ${m.dose ?? ''} ${m.unit}${m.doseStrength ? `（${m.doseStrength}）` : ''}・${m.route ?? ''}`

// ---------- 管制藥殘餘量：給不是整數的劑量（Morphine 0.5 AMP），整支扣、剩下的當場銷毀——給之前請另一位護理師見證 ----------
// 拿到見證才真的送出（go 帶著見證 token）；服務層沒有見證一樣擋（nursing.residualCheck）
const residualFor = ref<{ orderId: string; subject: string; go: (witness: string) => Promise<unknown> } | null>(null)
const residualOpen = computed({ get: () => !!residualFor.value, set: (v) => !v && (residualFor.value = null) })
const approveResidual = (cred: { username: string; password: string }) => witnessApi.approveWitness({ purpose: 'residual', orderId: residualFor.value!.orderId, ...cred })
async function onResidualApproved(token: string) {
  const r = residualFor.value
  residualFor.value = null
  if (r) await r.go(token)
}
/** 有殘餘量就先見證，沒有就直接送出 */
function withResidual(x: { residualQty?: number; unit: string; content: string; dose?: number }, orderId: string, go: (witness?: string) => Promise<unknown>) {
  if (!x.residualQty) return go()
  residualFor.value = { orderId, subject: `${x.content}：給 ${x.dose} ${x.unit}、殘餘 ${x.residualQty} ${x.unit} 當場銷毀\n病人：${props.admission.bed?.bedNo} ${props.admission.patientName}`, go }
}

// ---------- 執行 ----------
const exec = useAction(nursingApi.executeMar, { success: (m) => (m.status === 'given' ? '已記錄給藥' : '已記錄') })
const done = useAction(nursingApi.completeStatOrder, { success: '已完成臨時醫囑' })

async function give(m: MarView) {
  // 醫囑有疑問、待醫師回覆：給藥暫停；緊急時寫原因強制（服務層一樣會擋，這裡先問）
  if (m.queried) {
    reasonFor.value = { kind: 'force-mar', mar: m }
    return
  }
  if (m.highAlert) {
    const ok = await ui.confirm({
      title: '高警訊藥品：雙人核對',
      message: `${m.content}\n${dose(m)}\n病人：${props.admission.bed?.bedNo} ${props.admission.patientName}\n\n請與另一位護理師核對病人、藥名、劑量、途徑、時間後再給藥。`,
      okText: '已雙人核對，給藥',
    })
    if (!ok) return
  }
  withResidual(m, m.orderId, (w) => exec.run(m.id, 'given', '', undefined, undefined, w))
}

// ---------- 補登給藥時間：先給藥、後登打（規則 checkGivenAt 與服務層共用） ----------
const backdateFor = ref<MarView | null>(null)
const backdateOpen = computed({ get: () => !!backdateFor.value, set: (v) => !v && (backdateFor.value = null) })
const givenAtInput = ref('') // datetime-local：YYYY-MM-DDTHH:mm（可跨午夜：23:30 的藥 00:10 才給）
const givenAt = computed(() => givenAtInput.value.replace('T', ' '))
const backdateProblem = computed(() => (backdateFor.value ? checkGivenAt(backdateFor.value.scheduledAt, givenAt.value, props.clock) : null))
function openBackdate(m: MarView) {
  exec.fieldErrors.value = {}
  // 預設預定時間（最常見：照時間給了、晚點才登打）；預定時間還沒到就預設現在
  givenAtInput.value = (m.scheduledAt <= props.clock ? m.scheduledAt : props.clock).replace(' ', 'T')
  backdateFor.value = m
}
async function submitBackdate() {
  const m = backdateFor.value
  if (!m || backdateProblem.value) return
  if (m.highAlert) {
    const ok = await ui.confirm({
      title: '高警訊藥品：雙人核對',
      message: `${m.content}\n${dose(m)}\n病人：${props.admission.bed?.bedNo} ${props.admission.patientName}\n實際給藥時間：${givenAt.value.slice(5)}\n\n補登也要確認當時已雙人核對。`,
      okText: '已雙人核對，補登',
    })
    if (!ok) return
  }
  const at = givenAt.value
  if (m.residualQty) {
    backdateFor.value = null
    withResidual(m, m.orderId, (w) => exec.run(m.id, 'given', '', at, undefined, w))
    return
  }
  if (await exec.run(m.id, 'given', '', at)) backdateFor.value = null
}

// 暫停、拒絕、PRN 共用一個原因對話框，以 reasonFor 記住「要做什麼」
type ReasonTarget =
  | { kind: 'held' | 'refused' | 'force-mar'; mar: MarView }
  | { kind: 'prn'; order: PrnView }
  | { kind: 'force-stat'; order: OrderView }
const reasonFor = ref<ReasonTarget | null>(null)
const reasonOpen = computed({ get: () => !!reasonFor.value, set: (v) => !v && (reasonFor.value = null) })
const reasonConfig = computed(() => {
  const r = reasonFor.value
  if (!r) return { title: '', label: '', presets: [] as string[], subject: '' }
  if (r.kind === 'prn') {
    // 醫囑有疑問時：同一個原因也當作「疑問期間仍給藥」的理由（服務層兩者都記下）
    const q = r.order.pendingQuery
    return q
      ? { title: 'PRN 給藥（醫囑有疑問、待醫師回覆）', subject: `${r.order.content}・疑問：${q.reason}`, label: '給藥原因，並寫明為何不等醫師回覆', presets: ['已電話請示醫師，口頭確認', '病人急需，依標準處置'], okText: '仍要給藥', danger: true }
      : { title: 'PRN 給藥', subject: `${r.order.content}・${dose(r.order)}`, label: '給藥原因', presets: ['體溫 38.5°C', '疼痛分數 6 分', '噁心嘔吐', '無法入睡'], okText: '給藥' }
  }
  if (r.kind === 'force-mar') {
    return { title: '醫囑有疑問、待醫師回覆', subject: `${r.mar.scheduledAt.slice(11)} ${r.mar.content}・疑問：${r.mar.queried}`, label: '仍要給藥的原因（會記在給藥紀錄與稽核）', presets: ['已電話請示醫師，口頭確認', '病人急需，依標準處置'], okText: '仍要給藥', danger: true }
  }
  if (r.kind === 'force-stat') {
    return { title: '醫囑有疑問、待醫師回覆', subject: `${r.order.content}・疑問：${r.order.pendingQuery?.reason}`, label: '仍要執行的原因（會記在稽核）', presets: ['已電話請示醫師，口頭確認', '病人急需，依標準處置'], okText: '仍要執行', danger: true }
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
const reasonPending = computed(() => exec.pending.value || prn.pending.value || done.pending.value)
const reasonError = computed(() => exec.fieldErrors.value.note ?? prn.fieldErrors.value.note)
async function confirmReason(note: string) {
  const r = reasonFor.value
  if (!r) return
  const force = { reason: note }
  // 管制藥殘餘量：原因寫好了，接著請另一位護理師見證銷毀，見證後才送出
  if (r.kind === 'prn' && r.order.residualQty) {
    reasonFor.value = null
    withResidual(r.order, r.order.id, (w) => prn.run(r.order.id, note, r.order.pendingQuery ? force : undefined, w))
    return
  }
  if (r.kind === 'force-mar' && r.mar.residualQty) {
    reasonFor.value = null
    withResidual(r.mar, r.mar.orderId, (w) => exec.run(r.mar.id, 'given', '', undefined, force, w))
    return
  }
  const ok =
    r.kind === 'prn' ? await prn.run(r.order.id, note, r.order.pendingQuery ? force : undefined)
    : r.kind === 'force-mar' ? await exec.run(r.mar.id, 'given', '', undefined, force)
    : r.kind === 'force-stat' ? await done.run(r.order.id, force)
    : await exec.run(r.mar.id, r.kind, note)
  if (ok !== undefined) reasonFor.value = null
}

/** 距今多久，例：3 小時前 */
function ago(at: string) {
  const min = Math.round((parseDate(props.clock).getTime() - parseDate(at).getTime()) / 60000)
  if (min < 1) return '剛剛'
  return min < 60 ? `${min} 分鐘前` : `${Math.floor(min / 60)} 小時前`
}

// ---------- 臨時醫囑 ----------
async function complete(o: OrderView) {
  if (o.pendingQuery) {
    reasonFor.value = { kind: 'force-stat', order: o }
    return
  }
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
              <span :class="['tabular w-12 text-base font-semibold', urgencyOf(m) === 'overdue' ? 'text-red-700' : 'text-slate-700']">{{ m.scheduledAt.slice(11) }}<span v-if="m.timingShort" class="block text-[11px] font-normal text-amber-700" title="依服用時機對齊病房用餐時間">{{ m.timingShort }}</span></span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 font-medium text-slate-800">
                  {{ m.content }}
                  <UBadge v-if="m.highAlert" tone="purple">高警訊</UBadge>
                  <UBadge v-if="m.orderType === 'stat'" tone="blue">STAT</UBadge>
                  <UBadge v-if="m.queried" tone="yellow" :title="`疑問：${m.queried}`">待醫師回覆</UBadge>
                  <UBadge v-if="m.stockFrom === 'pharmacy'" tone="purple" title="病房常備不夠，改由住院藥局直送（扣藥局的帳）">藥局直送</UBadge>
                  <UBadge v-if="m.udDelivery === 'notReceived'" tone="cyan" title="藥局已核對送出，病房還沒點收這一盒（「本班待辦」點收）；照樣可以給">藥車未點收</UBadge>
                  <UBadge v-else-if="m.udDelivery === 'issue'" tone="red" title="點收時回報不符，藥局處理中；請確認藥品正確再給">藥盒不符</UBadge>
                  <UBadge v-if="m.awaitingUd" tone="gray" :title="m.awaitingUd === 'checking' ? '藥局已調劑、核對中，送出後才能給' : '住院藥局還沒調劑這一劑，藥還沒到病房'">{{ m.awaitingUd === 'checking' ? '藥局核對中' : '待藥局調劑' }}</UBadge>
                </div>
                <div v-if="m.awaitingUd && urgencyOf(m) !== 'upcoming'" class="text-xs text-slate-600">{{ m.awaitingUd === 'checking' ? '藥局已調劑、核對中，送到病房後才能給' : '藥局還沒調劑這一劑：請聯絡住院藥局補調劑' }}（暫停、拒絕照常可記）</div>
                <div v-if="m.queried" class="text-xs text-amber-800">護理師疑問：{{ m.queried }}（給藥暫停）</div>
                <div class="tabular text-xs text-slate-500">{{ dose(m) }}<template v-if="m.freq">・{{ m.freq }}</template></div>
                <div v-if="m.note" class="text-xs text-slate-600">原因：{{ m.note }}</div>
              </div>

              <template v-if="m.status === 'pending'">
                <UBadge :tone="urgencyView[urgencyOf(m)!].tone">{{ urgencyView[urgencyOf(m)!].label }}</UBadge>
                <div class="flex gap-1">
                  <UButton size="sm" variant="success" :icon="Check" :disabled="urgencyOf(m) === 'upcoming' || !!m.awaitingUd" :title="urgencyOf(m) === 'upcoming' ? '尚未到給藥時間' : m.awaitingUd ? '藥還沒送到病房' : ''" @click="give(m)">給藥</UButton>
                  <UButton v-if="urgencyOf(m) !== 'upcoming' && !m.queried && !m.awaitingUd" size="sm" variant="ghost" :icon="History" title="先給藥、後登打：記錄實際給藥時間" @click="openBackdate(m)">補登</UButton>
                  <UButton size="sm" variant="secondary" :icon="Pause" @click="reasonFor = { kind: 'held', mar: m }">暫停</UButton>
                  <UButton size="sm" variant="ghost" :icon="CircleSlash" @click="reasonFor = { kind: 'refused', mar: m }">拒絕</UButton>
                </div>
              </template>
              <template v-else>
                <UBadge :tone="statusView[m.status].tone">{{ statusView[m.status].label }}</UBadge>
                <div class="tabular w-40 text-right text-xs">
                  {{ m.executedAt?.slice(11) }}<span v-if="m.recordedAt" class="text-amber-700">（{{ m.recordedAt.slice(11) }} 補登）</span>・{{ m.nurseName }}
                  <div v-if="m.residual" class="text-purple-700">殘餘 {{ m.residual.qty }} {{ m.unit }} 銷毀・見證 {{ m.residualWitnessName }}</div>
                </div>
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
                <div class="font-medium text-slate-800">{{ o.content }}<UBadge v-if="o.pendingQuery" tone="yellow" class="ml-1">待醫師回覆</UBadge></div>
                <div class="tabular text-xs text-slate-500">{{ dose(o) }}・PRN<template v-if="o.residualQty">・管制藥，殘餘 {{ o.residualQty }} {{ o.unit }} 要見證銷毀</template></div>
                <div v-if="o.pendingQuery" class="text-xs text-amber-800">護理師疑問：{{ o.pendingQuery.reason }}</div>
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
                <div v-if="o.pendingQuery" class="text-xs text-amber-800">護理師疑問：{{ o.pendingQuery.reason }}（執行暫停）</div>
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

    <UDialog v-model="backdateOpen" title="補登給藥時間" size="sm" @submit="submitBackdate">
      <div v-if="backdateFor" class="space-y-3 text-sm">
        <div class="rounded-md bg-slate-50 px-3 py-2">
          <div class="font-medium text-slate-800">{{ backdateFor.content }}<span v-if="backdateFor.highAlert" class="ml-1 text-violet-700">（高警訊）</span></div>
          <div class="tabular text-xs text-slate-500">預定 {{ backdateFor.scheduledAt.slice(5) }}・{{ dose(backdateFor) }}</div>
        </div>
        <UInput v-model="givenAtInput" type="datetime-local" label="實際給藥時間" required :error="backdateProblem ?? exec.fieldErrors.value.givenAt" :hint="`最多往前 ${MAR_BACKDATE_MAX_MIN / 60} 小時；登打的時間也會一併記錄`" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="backdateOpen = false">取消</UButton>
        <UButton type="submit" variant="success" :disabled="!!backdateProblem" :loading="exec.pending.value">補登給藥</UButton>
      </template>
    </UDialog>
    <WitnessDialog
      v-model="residualOpen"
      title="管制藥殘餘量銷毀見證"
      who="見證護理師"
      ok-text="見證並給藥"
      :subject="residualFor?.subject"
      note="見證人要當場看著殘餘量銷毀。"
      :approve="approveResidual"
      @approved="onResidualApproved"
    />
  </div>
</template>
