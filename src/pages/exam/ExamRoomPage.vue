<script setup lang="ts">
// 影像檢查室：上方「待排程」（門診批價後、住院開立後還沒排的影像，舊的在前；取消的回到這裡）——選時間排進對應的檢查室，
// 有檢查前準備（禁食、顯影劑同意書、腎功能）的先列出來，排的時候告訴病人；含顯影劑的看 CrCl。
// 下方各檢查室當天的排程（依時間）：病人到了按「報到」→ 逐項確認檢查前準備（沒完成寫原因）→「完成」（住院醫囑一起完成），完成後進判讀清單。
// 過了排程 30 分鐘沒到標「未到」，可以改時間或取消（寫原因）。排程與操作由櫃台或放射科醫師；護理師只能看。規則由服務層擋（exam.ts、exam-rules）
import { computed, reactive, ref } from 'vue'
import { CalendarClock, Check, X } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UInput, UPageHeader, UQueryState } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { EXAM_DAY, examApi, type ExamBoard, type ExamView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { addDays, now, today } from '@/utils/date'

const date = ref(today())
const { data, loading } = useQuery(() => examApi.examBoard(date.value), [date])
const board = computed<ExamBoard | undefined>(() => (data.value?.date === date.value ? data.value : undefined))
// 預設排在下一個整點（開放時段內）
const nextSlot = () => {
  const t = now()
  const h = Number(t.slice(11, 13)) + 1
  return h < Number(EXAM_DAY.start.slice(0, 2)) ? { d: t.slice(0, 10), tm: EXAM_DAY.start } : h >= Number(EXAM_DAY.end.slice(0, 2)) ? { d: addDays(t.slice(0, 10), 1), tm: EXAM_DAY.start } : { d: t.slice(0, 10), tm: `${String(h).padStart(2, '0')}:00` }
}
const slot = reactive<Record<string, { d: string; tm: string }>>({})
const slotOf = (key: string) => (slot[key] ??= nextSlot())
const sched = useAction(examApi.scheduleExam, { success: (e) => `已排程：${e.roomName} ${e.start.slice(5)}（${e.patientName} ${e.procName}）` })
const err = ref<{ key: string; msg: string }>()
async function schedule(key: string) {
  const s = slotOf(key)
  const r = await sched.run(key, `${s.d} ${s.tm}`)
  err.value = r ? undefined : { key, msg: sched.fieldErrors.value.start ?? '' }
  if (r) moving.value = undefined
}
// 改時間（還沒報到的、未到的）
const moving = ref<string>()
const arrive = useAction(examApi.arriveExam, { success: (e) => `已報到：${e.patientName}${e.prepItems.length ? '，請逐項確認檢查前準備' : ''}` })
const done = useAction(examApi.completeExam, { success: (e) => `檢查完成：${e.patientName} ${e.procName}，進判讀清單` })
const prep = useAction(examApi.confirmExamPrep, { success: (e) => `已記錄：${e.patientName} 檢查前準備` })
// 取消、準備沒完成：寫原因
const cancelling = ref<ExamView>()
const cancelOpen = computed({ get: () => !!cancelling.value, set: (x) => !x && (cancelling.value = undefined) })
const cancel = useAction(examApi.cancelExam, { success: (e) => `已取消：${e.patientName} ${e.procName}，回到待排程` })
async function confirmCancel(reason: string) {
  if (cancelling.value && (await cancel.run(cancelling.value.id, reason))) cancelling.value = undefined
}
const notReady = ref<{ e: ExamView; item: { id: string; label: string } }>()
const notReadyOpen = computed({ get: () => !!notReady.value, set: (x) => !x && (notReady.value = undefined) })
async function confirmNotReady(note: string) {
  if (notReady.value && (await prep.run(notReady.value.e.id, notReady.value.item.id, false, note))) notReady.value = undefined
}
const TONE = { scheduled: 'blue', arrived: 'yellow', done: 'green' } as const
// 腎功能依據：「CrCl 31 ml/min（肌酸酐 1.8、60 kg…）」只留括號裡（CrCl 已在判斷文字裡）
const basis = (renal: string) => renal.match(/^CrCl \d+ ml\/min（(.*)）$/)?.[1] ?? renal
const CONTRAST_TONE = { ok: 'text-slate-600', hydrate: 'text-amber-800', unknown: 'text-amber-800', block: 'text-red-700 font-semibold' } as const
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="影像檢查室" :description="`排程（${EXAM_DAY.start}–${EXAM_DAY.end}，同一間不能撞期）、報到、確認檢查前準備、完成；完成後才進判讀清單`">
      <input v-model="date" type="date" class="form-control w-44" aria-label="日期" />
    </UPageHeader>
    <UQueryState :loading="loading && !board" :ready="!!board">
      <template v-if="board">
        <UCard :padded="false">
          <template #title><span class="flex items-center gap-2 text-sm font-semibold"><CalendarClock class="h-4 w-4" />待排程 <UBadge v-if="board.toSchedule.length" tone="yellow">{{ board.toSchedule.length }}</UBadge></span></template>
          <p v-if="!board.toSchedule.length" class="px-4 py-3 text-sm text-slate-400">沒有待排程的影像檢查</p>
          <ul v-else class="divide-y divide-slate-100 text-sm">
            <li v-for="w in board.toSchedule" :key="w.key" class="flex flex-wrap items-end gap-2 px-4 py-2">
              <div class="min-w-[14rem] flex-1">
                <b>{{ w.patientName }}</b> <span class="text-xs text-slate-500">{{ w.where }}</span>
                <div class="text-xs text-slate-700">{{ w.procName }}・{{ w.roomName }}・約 {{ w.minutes }} 分・{{ w.doctorName }} {{ w.orderedAt.slice(5) }} 開立</div>
                <div v-if="w.prep.length" class="text-xs text-indigo-800">檢查前準備（排程時告知病人／病房）：{{ w.prep.join('、') }}</div>
                <div v-if="w.contrast" :class="['text-xs', CONTRAST_TONE[w.contrast.level]]">顯影劑：{{ w.contrast.text }}<span class="text-slate-500">（{{ basis(w.contrast.renal) }}）</span></div>
                <div v-if="w.cancelledReason" class="text-xs text-slate-500">上次取消：{{ w.cancelledReason }}</div>
                <p v-if="err?.key === w.key && err.msg" class="text-xs text-red-600">{{ err.msg }}</p>
              </div>
              <template v-if="board.canSchedule">
                <UInput v-model="slotOf(w.key).d" type="date" class="w-40" label="日期" />
                <UInput v-model="slotOf(w.key).tm" type="time" class="w-28" label="時間" />
                <UButton size="sm" :loading="sched.pending.value" @click="schedule(w.key)">排程</UButton>
              </template>
            </li>
          </ul>
          <p v-if="!board.canSchedule" class="px-4 pb-2 text-xs text-slate-500">排程與報到、完成由櫃台或放射科處理。</p>
        </UCard>
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <UCard v-for="r in board.rooms" :key="r.room" :title="r.name" :padded="false">
            <p v-if="!r.exams.length" class="px-4 py-3 text-sm text-slate-400">這天沒有排檢查</p>
            <ul v-else class="divide-y divide-slate-100 text-sm">
              <li v-for="e in r.exams" :key="e.id" class="space-y-1 px-4 py-2">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="tabular w-24 text-xs text-slate-600">{{ e.start.slice(11) }}–{{ e.end.slice(11) }}</span>
                  <span class="min-w-[9rem] flex-1"><b>{{ e.patientName }}</b> <span class="text-xs text-slate-500">{{ e.where }}</span><span class="block text-xs text-slate-700">{{ e.procName }}</span></span>
                  <UBadge :tone="e.noShow ? 'red' : TONE[e.stage]">{{ e.stageLabel }}</UBadge>
                </div>
                <div v-if="board.canSchedule && e.stage !== 'done'" class="flex flex-wrap justify-end gap-1">
                  <UButton v-if="e.stage === 'scheduled'" size="sm" variant="secondary" :loading="arrive.pending.value" @click="arrive.run(e.id)">報到</UButton>
                  <UButton v-else size="sm" :loading="done.pending.value" @click="done.run(e.id)">完成</UButton>
                  <UButton v-if="e.stage === 'scheduled'" size="sm" variant="ghost" @click="moving = moving === e.id ? undefined : e.id">改時間</UButton>
                  <UButton size="sm" variant="ghost" @click="cancelling = e">取消</UButton>
                </div>
                <p v-if="e.noShow" class="text-xs text-red-700">過了排程 30 分鐘還沒報到{{ e.where === '門診' ? '（開立醫師首頁看得到）' : '（請聯絡病房）' }}：改時間或取消</p>
                <div v-if="moving === e.id" class="flex flex-wrap items-end gap-2">
                  <UInput v-model="slotOf(e.key).d" type="date" class="w-40" label="新日期" />
                  <UInput v-model="slotOf(e.key).tm" type="time" class="w-28" label="新時間" />
                  <UButton size="sm" :loading="sched.pending.value" @click="schedule(e.key)">改期</UButton>
                  <p v-if="err?.key === e.key && err.msg" class="w-full text-xs text-red-600">{{ err.msg }}</p>
                </div>
                <div v-if="e.contrast" :class="['text-xs', CONTRAST_TONE[e.contrast.level]]">顯影劑：{{ e.contrast.text }}<span class="text-slate-500">（{{ basis(e.contrast.renal) }}）</span></div>
                <ul v-if="e.prepItems.length && e.stage !== 'done'" class="space-y-0.5 text-xs">
                  <li v-for="p in e.prepItems" :key="p.id" class="flex flex-wrap items-center gap-2">
                    <span :class="['inline-flex h-4 w-4 items-center justify-center rounded-full', p.ok === true ? 'bg-emerald-600 text-white' : p.ok === false ? 'bg-red-600 text-white' : 'border border-slate-400']"><Check v-if="p.ok === true" class="h-3 w-3" /><X v-else-if="p.ok === false" class="h-3 w-3" /></span>
                    <span :class="p.ok === false && 'text-red-700'">{{ p.label }}</span>
                    <span v-if="p.note" class="text-slate-500">（{{ p.note }}）</span>
                    <template v-if="board.canSchedule && e.stage === 'arrived' && p.ok !== true">
                      <UButton size="sm" variant="secondary" :loading="prep.pending.value" @click="prep.run(e.id, p.id, true)">確認</UButton>
                      <UButton v-if="p.ok === undefined" size="sm" variant="ghost" @click="notReady = { e, item: p }">沒完成</UButton>
                    </template>
                  </li>
                </ul>
                <p v-if="e.stage === 'scheduled' && e.prepItems.length" class="text-xs text-slate-500">報到後逐項確認檢查前準備，全部完成才能做</p>
              </li>
            </ul>
          </UCard>
        </div>
      </template>
    </UQueryState>
    <ReasonDialog v-model="cancelOpen" title="取消影像檢查" :subject="cancelling ? `${cancelling.patientName} ${cancelling.procName}（${cancelling.start.slice(5)}）` : ''" label="取消原因（影像會回到待排程）" :presets="['病人未禁食，改期', '病人未到', '病人拒絕', '醫師改檢查']" ok-text="取消檢查" danger :pending="cancel.pending.value" :error="cancel.fieldErrors.value.reason" @confirm="confirmCancel" />
    <ReasonDialog v-model="notReadyOpen" title="檢查前準備沒完成" :subject="notReady ? `${notReady.e.patientName}：${notReady.item.label}` : ''" label="原因（沒完成不能做，請取消改期）" :presets="['早上吃過早餐', '同意書還沒簽', '病人拒絕']" ok-text="記錄" :pending="prep.pending.value" :error="prep.fieldErrors.value.note" @confirm="confirmNotReady" />
  </div>
</template>
