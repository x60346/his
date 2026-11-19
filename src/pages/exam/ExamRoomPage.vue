<script setup lang="ts">
// 影像檢查室：上方「待排程」（門診批價後、住院開立後還沒排的影像，舊的在前；取消的回到這裡）——選時間排進對應的檢查室，
// 有檢查前準備（禁食、顯影劑同意書、腎功能）的先列出來，排的時候告訴病人；含顯影劑的看 CrCl。
// 下方各檢查室當天的排程（依時間）：病人到了按「報到」→ 逐項確認檢查前準備（沒完成寫原因）→「完成」（住院醫囑一起完成），完成後進判讀清單。
// 過了排程 30 分鐘沒到標「未到」，可以改時間或取消（寫原因）。分工：排程＝櫃台；報到、取消＝櫃台或放射師；確認準備、完成＝放射師
// （放射科醫師都能支援）；護理師、其他醫師只能看。含顯影劑的完成時記用量，有不良反應記嚴重度（中度以上自動通報藥師）。規則由服務層擋（exam.ts、exam-rules）
import { computed, reactive, ref } from 'vue'
import { CalendarClock, Check, Wrench, X } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UCheckbox, UDialog, UInput, UPageHeader, UQueryState, USelect, UTextarea } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import ContrastClearDialog from '@/components/ContrastClearDialog.vue'
import { CONTRAST_REACTION_LABEL, DOWNTIME_REASON_LABEL, EXAM_DAY, EXAM_ROOMS, examApi, type ExamBoard, type ExamView } from '@/services'
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
const done = useAction(examApi.completeExam, { success: (e) => `檢查完成：${e.patientName} ${e.procName}，進判讀清單${e.contrastReaction?.adrId ? '；顯影劑不良反應已通報藥師' : ''}` })
// 含顯影劑的完成：用量、有沒有不良反應
const finishing = ref<ExamView>()
const finishOpen = computed({ get: () => !!finishing.value, set: (x) => !x && (finishing.value = undefined) })
const fin = reactive({ ml: '', hasReaction: false, severity: 'mild' as 'mild' | 'moderate' | 'severe', symptoms: '', action: '' })
function finish(e: ExamView) {
  if (!e.contrast) return void done.run(e.id)
  Object.assign(fin, { ml: '', hasReaction: false, severity: 'mild', symptoms: '', action: '' })
  done.fieldErrors.value = {}
  finishing.value = e
}
async function confirmFinish() {
  if (!finishing.value) return
  const input = { contrastMl: fin.ml === '' ? undefined : Number(fin.ml), ...(fin.hasReaction ? { reaction: { severity: fin.severity, symptoms: fin.symptoms, action: fin.action } } : {}) }
  if (await done.run(finishing.value.id, input)) finishing.value = undefined
}
// 停機：登記（放射師、放射科醫師）、提早結束；排在停機時段的一鍵排到下一個空檔（櫃台）
const dtOpen = ref(false)
const dt = reactive({ room: 'XR', fromD: today(), fromT: '', toD: today(), toT: '', reason: 'maintenance' as 'maintenance' | 'breakdown', note: '' })
function openDowntime() {
  const t = now()
  Object.assign(dt, { room: 'XR', fromD: t.slice(0, 10), fromT: t.slice(11), toD: t.slice(0, 10), toT: '', reason: 'breakdown', note: '' })
  addDt.fieldErrors.value = {}
  dtOpen.value = true
}
const addDt = useAction(examApi.addDowntime, { success: (d) => `已登記停機：${d.roomName} ${d.text}${d.clashes ? `，${d.clashes} 筆檢查需改期` : ''}` })
async function saveDowntime() {
  if (await addDt.run({ room: dt.room as ExamView['room'], from: `${dt.fromD} ${dt.fromT}`, to: `${dt.toD} ${dt.toT}`, reason: dt.reason, note: dt.note })) dtOpen.value = false
}
const endDt = useAction(examApi.endDowntime, { success: (d) => `${d.roomName}停機已結束` })
const resched = useAction(examApi.rescheduleNext, { success: (e) => `已改到 ${e.start.slice(5)}（${e.patientName} ${e.procName}）` })
const roomOptions = EXAM_ROOMS.map((r) => ({ value: r.id, label: r.name }))
const reasonOptions = (Object.keys(DOWNTIME_REASON_LABEL) as (keyof typeof DOWNTIME_REASON_LABEL)[]).map((k) => ({ value: k, label: DOWNTIME_REASON_LABEL[k] }))
const severityOptions = (Object.keys(CONTRAST_REACTION_LABEL) as (keyof typeof CONTRAST_REACTION_LABEL)[]).map((k) => ({ value: k, label: CONTRAST_REACTION_LABEL[k] }))
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
const clearing = ref<{ key: string; subject: string }>()
const clearOpen = computed({ get: () => !!clearing.value, set: (x) => !x && (clearing.value = undefined) })
// 腎功能依據：「CrCl 31 ml/min（肌酸酐 1.8、60 kg…）」只留括號裡（CrCl 已在判斷文字裡）
const basis = (renal: string) => renal.match(/^CrCl \d+ ml\/min（(.*)）$/)?.[1] ?? renal
const CONTRAST_TONE = { ok: 'text-slate-600', hydrate: 'text-amber-800', unknown: 'text-amber-800', block: 'text-red-700 font-semibold' } as const
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="影像檢查室" :description="`排程（${EXAM_DAY.start}–${EXAM_DAY.end}，同一間不能撞期）、報到、確認檢查前準備、完成；完成後才進判讀清單`">
      <UButton v-if="board?.canPerform" variant="secondary" :icon="Wrench" @click="openDowntime">登記停機</UButton>
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
                <div v-if="w.safety.allergy" :class="['text-xs', w.safety.allergy.cleared ? 'text-slate-600' : 'font-semibold text-red-700']">顯影劑過敏（{{ w.safety.allergy.text }}）：{{ w.safety.allergy.cleared ? `${w.safety.allergy.cleared.byName} 已放行` : '開立醫師確認前置用藥並放行後才能報到' }}
                  <UButton v-if="board.canClear && !w.safety.allergy.cleared" size="sm" variant="danger" @click="clearing = { key: w.key, subject: `${w.patientName} ${w.procName}：過敏 ${w.safety.allergy.text}` }">放行</UButton></div>
                <div v-if="w.safety.metformin" class="text-xs text-amber-800">{{ w.safety.metformin }}</div>
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
          <p v-if="!board.canSchedule" class="px-4 pb-2 text-xs text-slate-500">排程由櫃台處理（放射科醫師可支援）；報到後由放射師確認準備、完成檢查。</p>
        </UCard>
        <div v-if="board.downtimes.length || board.downtimeStats.some((x) => x.count)" class="space-y-1 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm">
          <div v-for="d in board.downtimes" :key="d.id" class="flex flex-wrap items-center gap-2">
            <Wrench class="h-4 w-4 text-amber-700" /><b>{{ d.roomName }}</b><span>{{ d.text }}</span><UBadge v-if="d.active" tone="red">停機中</UBadge>
            <span class="text-xs text-slate-600">{{ d.note }}・{{ d.byName }} 登記{{ d.endedAt ? `・已提早結束` : '' }}</span>
            <span v-if="d.clashes" class="text-xs font-semibold text-red-700">{{ d.clashes }} 筆需改期</span>
            <UButton v-if="board.canPerform && !d.endedAt" size="sm" variant="ghost" class="ml-auto" :loading="endDt.pending.value" @click="endDt.run(d.id)">{{ d.active ? '結束停機' : '取消停機' }}</UButton>
          </div>
          <p class="text-xs text-slate-500">近 30 天停機：{{ board.downtimeStats.filter((x) => x.count).map((x) => `${x.name} ${x.hours} 小時（${x.count} 次）`).join('、') || '沒有' }}</p>
        </div>
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
                <div v-if="(board.canArrive || board.canSchedule) && e.stage !== 'done'" class="flex flex-wrap justify-end gap-1">
                  <UButton v-if="e.stage === 'scheduled' && board.canArrive" size="sm" variant="secondary" :loading="arrive.pending.value" @click="arrive.run(e.id)">報到</UButton>
                  <UButton v-else-if="e.stage === 'arrived' && board.canPerform" size="sm" :loading="done.pending.value" @click="finish(e)">完成</UButton>
                  <span v-else-if="e.stage === 'arrived'" class="text-xs text-slate-500">等放射師檢查</span>
                  <UButton v-if="e.stage === 'scheduled' && board.canSchedule" size="sm" variant="ghost" @click="moving = moving === e.id ? undefined : e.id">改時間</UButton>
                  <UButton v-if="board.canArrive" size="sm" variant="ghost" @click="cancelling = e">取消</UButton>
                </div>
                <p v-if="e.stage === 'done' && (e.contrastMl || e.contrastReaction)" class="text-xs text-slate-600">{{ e.doneByName }} 完成{{ e.contrastMl ? `・顯影劑 ${e.contrastMl} mL` : '' }}
                  <span v-if="e.contrastReaction" :class="e.contrastReaction.severity === 'mild' ? 'text-amber-800' : 'font-semibold text-red-700'">・不良反應（{{ CONTRAST_REACTION_LABEL[e.contrastReaction.severity].split('（')[0] }}）：{{ e.contrastReaction.symptoms }}，{{ e.contrastReaction.action }}{{ e.contrastReaction.adrId ? '（已通報藥師評估）' : '' }}</span></p>
                <p v-if="e.downtimeClash" class="flex flex-wrap items-center gap-2 text-xs font-semibold text-red-700">{{ e.downtimeClash }}
                  <UButton v-if="board.canSchedule" size="sm" :loading="resched.pending.value" @click="resched.run(e.id)">排到下一個空檔</UButton></p>
                <p v-if="e.noShow" class="text-xs text-red-700">過了排程 30 分鐘還沒報到{{ e.where === '門診' ? '（開立醫師首頁看得到）' : '（請聯絡病房）' }}：改時間或取消</p>
                <div v-if="moving === e.id" class="flex flex-wrap items-end gap-2">
                  <UInput v-model="slotOf(e.key).d" type="date" class="w-40" label="新日期" />
                  <UInput v-model="slotOf(e.key).tm" type="time" class="w-28" label="新時間" />
                  <UButton size="sm" :loading="sched.pending.value" @click="schedule(e.key)">改期</UButton>
                  <p v-if="err?.key === e.key && err.msg" class="w-full text-xs text-red-600">{{ err.msg }}</p>
                </div>
                <div v-if="e.contrast" :class="['text-xs', CONTRAST_TONE[e.contrast.level]]">顯影劑：{{ e.contrast.text }}<span class="text-slate-500">（{{ basis(e.contrast.renal) }}）</span></div>
                <div v-if="e.safety.allergy" :class="['text-xs', e.safety.allergy.cleared ? 'text-slate-600' : 'font-semibold text-red-700']">顯影劑過敏（{{ e.safety.allergy.text }}）：{{ e.safety.allergy.cleared ? `${e.safety.allergy.cleared.byName} 已放行（${e.safety.allergy.cleared.reason}）` : '還沒放行，不能報到' }}
                  <UButton v-if="board.canClear && !e.safety.allergy.cleared" size="sm" variant="danger" @click="clearing = { key: e.key, subject: `${e.patientName} ${e.procName}：過敏 ${e.safety.allergy.text}` }">放行</UButton></div>
                <div v-if="e.safety.metformin" class="text-xs text-amber-800">{{ e.safety.metformin }}</div>
                <ul v-if="e.prepItems.length && e.stage !== 'done'" class="space-y-0.5 text-xs">
                  <li v-for="p in e.prepItems" :key="p.id" class="flex flex-wrap items-center gap-2">
                    <span :class="['inline-flex h-4 w-4 items-center justify-center rounded-full', p.ok === true ? 'bg-emerald-600 text-white' : p.ok === false ? 'bg-red-600 text-white' : 'border border-slate-400']"><Check v-if="p.ok === true" class="h-3 w-3" /><X v-else-if="p.ok === false" class="h-3 w-3" /></span>
                    <span :class="p.ok === false && 'text-red-700'">{{ p.label }}</span>
                    <span v-if="p.note" class="text-slate-500">（{{ p.note }}）</span>
                    <template v-if="board.canPerform && e.stage === 'arrived' && p.ok !== true">
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
    <UDialog v-model="dtOpen" title="登記檢查室停機" size="md">
      <div class="space-y-3 text-sm">
        <div class="grid grid-cols-2 gap-3">
          <USelect v-model="dt.room" label="檢查室" :options="roomOptions" :error="addDt.fieldErrors.value.room" />
          <USelect v-model="dt.reason" label="原因" :options="reasonOptions" :error="addDt.fieldErrors.value.reason" />
          <UInput v-model="dt.fromD" type="date" label="開始日期" />
          <UInput v-model="dt.fromT" type="time" label="開始時間" :error="addDt.fieldErrors.value.from" />
          <UInput v-model="dt.toD" type="date" label="結束日期" />
          <UInput v-model="dt.toT" type="time" label="結束時間" :error="addDt.fieldErrors.value.to" />
        </div>
        <UInput v-model="dt.note" label="說明（選填）" placeholder="例：球管故障，等廠商" />
        <p class="text-xs text-slate-500">停機時段排不進去、不能報到；已排在這段的會列「需改期」，櫃台可以一鍵排到下一個空檔。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="dtOpen = false">取消</UButton>
        <UButton :loading="addDt.pending.value" @click="saveDowntime">登記</UButton>
      </template>
    </UDialog>
    <UDialog v-model="finishOpen" title="完成檢查（含顯影劑）" size="md">
      <div v-if="finishing" class="space-y-3 text-sm">
        <p><b>{{ finishing.patientName }}</b> {{ finishing.where }}・{{ finishing.procName }}</p>
        <UInput v-model="fin.ml" type="number" label="顯影劑用量（mL）" placeholder="例：80" :error="done.fieldErrors.value.contrastMl" />
        <UCheckbox v-model="fin.hasReaction" label="有顯影劑不良反應" />
        <template v-if="fin.hasReaction">
          <USelect v-model="fin.severity" label="嚴重度" :options="severityOptions" :error="done.fieldErrors.value.severity" />
          <UInput v-model="fin.symptoms" label="症狀" placeholder="例：前胸蕁麻疹、癢" :error="done.fieldErrors.value.symptoms" />
          <UTextarea v-model="fin.action" label="處置" :rows="2" placeholder="例：觀察 30 分鐘緩解；給抗組織胺" :error="done.fieldErrors.value.action" />
          <p v-if="fin.severity !== 'mild'" class="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800">中度以上會自動產生藥物不良反應通報（碘化顯影劑），送藥師評估；要不要加入過敏由藥師決定。</p>
        </template>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="finishing = undefined">取消</UButton>
        <UButton :loading="done.pending.value" @click="confirmFinish">完成</UButton>
      </template>
    </UDialog>
    <ContrastClearDialog v-model="clearOpen" :exam-key="clearing?.key ?? ''" :subject="clearing?.subject ?? ''" />
    <ReasonDialog v-model="cancelOpen" title="取消影像檢查" :subject="cancelling ? `${cancelling.patientName} ${cancelling.procName}（${cancelling.start.slice(5)}）` : ''" label="取消原因（影像會回到待排程）" :presets="['病人未禁食，改期', '病人未到', '病人拒絕', '醫師改檢查']" ok-text="取消檢查" danger :pending="cancel.pending.value" :error="cancel.fieldErrors.value.reason" @confirm="confirmCancel" />
    <ReasonDialog v-model="notReadyOpen" title="檢查前準備沒完成" :subject="notReady ? `${notReady.e.patientName}：${notReady.item.label}` : ''" label="原因（沒完成不能做，請取消改期）" :presets="['早上吃過早餐', '同意書還沒簽', '病人拒絕']" ok-text="記錄" :pending="prep.pending.value" :error="prep.fieldErrors.value.note" @confirm="confirmNotReady" />
  </div>
</template>
