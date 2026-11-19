<script setup lang="ts">
// 手術（醫師住院醫囑、護理站病人分頁共用）：
//   - 醫師：申請手術（術式、左右側、麻醉、預計日期與時間、術前診斷）、取消（進手術室前）、手術紀錄（做完後）
//   - 護理師：術前準備逐項勾（不需要要寫原因；備血連備血單、抗生素連醫囑）、送手術室（準備沒完成擋）
// 排程與三段查核在「手術室」頁；規則都在服務層（surgery.ts、surgery-rules）
import { computed, reactive, ref } from 'vue'
import { Plus, Send } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UQueryState, USelect, UTextarea } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import PacuPanel from './PacuPanel.vue'
import PostopDialog from './PostopDialog.vue'
import PathPanel from './PathPanel.vue'
import { ANESTHESIA_LABEL, SIDE_LABEL, surgeryApi, URGENCY_LABEL, URGENCY_MINUTES, type SurgeryView } from '@/services'
import type { AnesthesiaType, SurgeryPrepKey, SurgerySide, SurgeryUrgency } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { addDays, today } from '@/utils/date'

const props = defineProps<{ admissionId: string }>()
const auth = useAuth()
const isDoctor = computed(() => auth.user?.role === 'doctor')
const isNurse = computed(() => auth.user?.role === 'nurse')
const { data, loading } = useQuery(() => surgeryApi.patientSurgeries(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const { data: opts } = useQuery(() => surgeryApi.surgeryOptions())
const tone = (s: SurgeryView) => (s.status === 'cancelled' ? 'gray' : s.status === 'done' ? 'green' : s.status === 'in-progress' || s.status === 'sent' ? 'red' : s.status === 'scheduled' ? 'blue' : 'yellow')

// ---------- 申請 ----------
const reqOpen = ref(false)
const form = reactive({ urgency: '' as SurgeryUrgency | '', procId: '' as string | number | undefined, side: '' as SurgerySide | '', anesthesia: 'general' as AnesthesiaType, requestedDate: addDays(today(), 1), estMinutes: 60 as number | undefined, diagnosis: '', note: '' })
function openReq() {
  Object.assign(form, { urgency: '', procId: '', side: '', anesthesia: 'general', requestedDate: addDays(today(), 1), estMinutes: 60, diagnosis: '', note: '' })
  req.fieldErrors.value = {}
  reqOpen.value = true
}
function pickProc(id: string | number | undefined) {
  form.procId = id
  const p = opts.value?.procs.find((x) => x.id === id)
  if (p) form.estMinutes = p.minutes
}
const req = useAction(surgeryApi.requestSurgery, { success: (s) => (s.urgency ? `已申請${s.urgencyLabel}急刀 ${s.no}：${s.emergency!.due.slice(11)} 前要入刀房，手術室已收到` : `已申請手術 ${s.no}：等手術室排程`) })
async function submitReq() {
  const ok = await req.run({ admissionId: props.admissionId, procId: String(form.procId ?? ''), side: form.side as SurgerySide, anesthesia: form.anesthesia, requestedDate: form.requestedDate, ...(form.urgency ? { urgency: form.urgency } : {}), estMinutes: Number(form.estMinutes), diagnosis: form.diagnosis, note: form.note })
  if (ok) reqOpen.value = false
}

const cancelling = ref<SurgeryView>()
const cancelOpen = computed({ get: () => !!cancelling.value, set: (x) => !x && (cancelling.value = undefined) })
const cancel = useAction(surgeryApi.cancelSurgery, { success: '已取消手術' })
async function confirmCancel(reason: string) {
  if (cancelling.value && (await cancel.run(cancelling.value.id, reason))) cancelling.value = undefined
}

// ---------- 手術紀錄 ----------
// 術後醫囑（套組套或沿用術前醫囑）
const postopFor = ref<string>()
const postopOpen = computed({ get: () => !!postopFor.value, set: (x) => !x && (postopFor.value = undefined) })
const recording = ref<SurgeryView>()
const recOpen = computed({ get: () => !!recording.value, set: (x) => !x && (recording.value = undefined) })
const rec = reactive({ performed: '', findings: '', bloodLoss: undefined as number | undefined, complications: '', specimen: '' })
function openRec(s: SurgeryView) {
  Object.assign(rec, { performed: `${s.procName}（${s.sideText}）`, findings: '', bloodLoss: undefined, complications: '無', specimen: '無' })
  recAct.fieldErrors.value = {}
  recording.value = s
}
const recAct = useAction(surgeryApi.writeOpRecord, { success: '已寫手術紀錄' })
async function submitRec() {
  if (recording.value && (await recAct.run(recording.value.id, { ...rec, bloodLoss: Number(rec.bloodLoss) }))) recording.value = undefined
}

// ---------- 護理師：術前準備、送手術室 ----------
const marking = ref<{ s: SurgeryView; key: SurgeryPrepKey; label: string; optional: boolean }>()
const markOpen = computed({ get: () => !!marking.value, set: (x) => !x && (marking.value = undefined) })
const mk = reactive({ mode: 'done' as 'done' | 'na', refId: '' as string | number | undefined, notNeeded: '' })
function openMark(s: SurgeryView, row: SurgeryView['prepRows'][number]) {
  Object.assign(mk, { mode: 'done', refId: '', notNeeded: '' })
  markAct.fieldErrors.value = {}
  marking.value = { s, key: row.key as SurgeryPrepKey, label: row.label, optional: row.optional }
}
const needsRef = computed(() => marking.value?.key === 'blood' || marking.value?.key === 'abx')
// 禁食可以連禁食醫囑（選填）
const npoRef = computed(() => marking.value?.key === 'npo')
const refOptions = computed(() => (marking.value?.key === 'blood' ? v.value?.bloodOptions : marking.value?.key === 'npo' ? v.value?.npoOptions : v.value?.abxOptions)?.map((o) => ({ label: o.text, value: o.id })) ?? [])
const markAct = useAction(surgeryApi.markPrep, { success: '已記錄' })
async function submitMark() {
  const m = marking.value
  if (!m) return
  const ok = await markAct.run(m.s.id, m.key, mk.mode === 'na' ? { notNeeded: mk.notNeeded } : needsRef.value || (npoRef.value && mk.refId) ? { refId: String(mk.refId ?? '') } : {})
  if (ok) marking.value = undefined
}
const unmark = useAction(surgeryApi.unmarkPrep)
const send = useAction(surgeryApi.sendToOr, { success: '已送手術室' })
</script>

<template>
  <div class="space-y-4 p-4 text-sm">
    <UQueryState :loading="loading && !v" :ready="!!v">
      <template v-if="v">
        <div class="flex items-center gap-2">
          <p class="text-slate-500">手術室排程、三段安全查核在「手術室」頁；病房在這裡做術前準備、送手術室。</p>
          <UButton v-if="v.canRequest" size="sm" class="ml-auto" :icon="Plus" @click="openReq">申請手術</UButton>
        </div>
        <p v-if="!v.list.length" class="text-slate-500">這次住院沒有手術。</p>
        <section v-for="s in v.list" :key="s.id" :class="['space-y-2 rounded-md border p-3', s.status === 'cancelled' ? 'border-slate-200 opacity-70' : 'border-slate-300']">
          <div class="flex flex-wrap items-center gap-2">
            <b class="text-slate-800">{{ s.procName }}</b>
            <span class="text-slate-600">{{ s.sideText }}・{{ s.anesthesiaText }}・預估 {{ s.estMinutes }} 分</span>
            <UBadge v-if="s.urgencyLabel" tone="red">急刀・{{ s.urgencyLabel }}</UBadge>
            <UBadge :tone="tone(s)">{{ s.statusLabel }}</UBadge>
            <span v-if="s.scheduleText" class="tabular rounded bg-blue-50 px-1.5 text-xs font-medium text-blue-800">{{ s.scheduleText }}</span>
            <span class="tabular ml-auto text-xs text-slate-500">{{ s.no }}・主刀 {{ s.doctorName }}</span>
          </div>
          <div class="text-xs text-slate-600">術前診斷：{{ s.diagnosis }}・<template v-if="s.emergency">{{ s.emergency.due.slice(11) }} 前入刀房</template><template v-else>預計 {{ s.requestedDate }}</template><span v-if="s.note">・{{ s.note }}</span></div>
          <p v-if="s.bumpedBy" class="text-xs font-medium text-red-700">{{ s.bumpedBy }}</p>
          <PacuPanel v-if="s.pacu" :surgery-id="s.id" />
          <p v-if="s.preAnesText" class="text-xs" :class="s.preAnes?.difficult ? 'font-medium text-red-700' : 'text-slate-600'">麻醉前評估：{{ s.preAnesText }}（{{ s.preAnesByName }}）</p>
          <p v-else-if="s.preAnesMissing" class="text-xs text-amber-800">麻醉前評估還沒做（由麻醉醫師在手術室頁評估）</p>
          <p v-if="s.team && s.status !== 'cancelled'" class="text-xs text-slate-600">手術團隊：{{ s.teamText }}</p>
          <p v-if="s.cancelled" class="text-xs text-slate-500">已取消：{{ s.cancelled.reason }}・{{ s.cancelledByName }}</p>

          <!-- 術前準備 -->
          <div v-if="s.status !== 'cancelled'" class="rounded border border-slate-200">
            <div class="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600">
              術前準備
              <span v-if="s.prepMissing.length && ['requested', 'scheduled'].includes(s.status)" class="text-amber-800">還差：{{ s.prepMissing.join('、') }}</span>
              <UButton v-if="isNurse && s.status === 'scheduled'" size="sm" class="ml-auto" :icon="Send" :disabled="!!s.prepMissing.length" :loading="send.pending.value" @click="send.run(s.id)">送手術室</UButton>
            </div>
            <ul class="divide-y divide-slate-100">
              <li v-for="row in s.prepRows" :key="row.key" class="flex flex-wrap items-center gap-2 px-3 py-1.5">
                <span :class="['inline-block h-4 w-4 rounded-full border text-center text-[10px] leading-4', row.done ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300']">{{ row.done ? '✓' : '' }}</span>
                <span class="font-medium text-slate-700">{{ row.label }}</span>
                <span class="text-xs text-slate-500">{{ row.text ?? row.hint }}</span>
                <span v-if="isNurse && ['requested', 'scheduled'].includes(s.status)" class="ml-auto">
                  <UButton v-if="!row.done" size="sm" variant="secondary" @click="openMark(s, row)">記錄</UButton>
                  <UButton v-else size="sm" variant="ghost" :loading="unmark.pending.value" @click="unmark.run(s.id, row.key as SurgeryPrepKey)">取消勾選</UButton>
                </span>
              </li>
            </ul>
          </div>

          <!-- 手術室 -->
          <div v-if="['sent', 'in-progress', 'done'].includes(s.status)" class="space-y-0.5 text-xs text-slate-600">
            <div v-for="c in s.checkRows" :key="c.stage">{{ c.title }}：{{ c.done ? `完成・${c.text}` : '—' }}</div>
            <div v-if="s.startAt" class="tabular">手術 {{ s.startAt.slice(5) }}{{ s.endAt ? ` – ${s.endAt.slice(11)}` : '（進行中）' }}</div>
            <div v-if="s.counts" :class="s.countMismatch ? 'font-semibold text-red-700' : ''">紗布 {{ s.counts.spongeBefore }}／{{ s.counts.spongeAfter }}、器械 {{ s.counts.instrumentBefore }}／{{ s.counts.instrumentAfter }}<template v-if="s.counts.mismatchReason">：計數不符 {{ s.counts.mismatchReason }}</template></div>
          </div>
          <div v-if="s.record" class="rounded bg-slate-50 px-3 py-2 text-xs text-slate-700">
            <div class="font-medium">手術紀錄（{{ s.recordByName }} {{ s.record.at.slice(5) }}）</div>
            <div>術式：{{ s.record.performed }}・失血 {{ s.record.bloodLoss }} ml・併發症 {{ s.record.complications }}・檢體 {{ s.record.specimen }}</div>
            <div class="whitespace-pre-line">術中發現：{{ s.record.findings }}</div>
          </div>
          <p v-if="s.specimenRows.length && !s.path" class="text-xs text-slate-600">檢體：{{ s.specimenRows.map((x) => x.text).join('；') }}</p>
          <p v-if="s.pathMissing" class="text-xs font-semibold text-red-700">{{ s.pathMissing }}</p>
          <PathPanel v-if="s.path" :surgery-id="s.id" />
          <p v-if="s.postopText" class="text-xs text-slate-600">術後醫囑：{{ s.postopText }}</p>
          <p v-else-if="s.postopDue" class="text-xs" :class="s.postopLate ? 'font-semibold text-red-700' : 'text-amber-800'">術後醫囑還沒開{{ s.postopLate ? '（手術完成超過 4 小時）' : '' }}</p>
          <div v-if="isDoctor" class="flex gap-2">
            <UButton v-if="s.status === 'done' && !s.record" size="sm" @click="openRec(s)">寫手術紀錄</UButton>
            <UButton v-if="s.status === 'done'" size="sm" :variant="s.postopDue ? 'primary' : 'secondary'" @click="postopFor = s.id">術後醫囑</UButton>
            <UButton v-if="v.canRequest && ['requested', 'scheduled'].includes(s.status)" size="sm" variant="ghost" class="text-red-700" @click="cancelling = s">取消手術</UButton>
          </div>
        </section>
      </template>
    </UQueryState>

    <UDialog v-model="reqOpen" :title="`申請手術：${v?.patientName ?? ''}`" @submit="submitReq">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="sm:col-span-2"><USelect v-model="form.urgency" label="時效" :options="[{ label: '擇期（手術室排日期）', value: '' }, ...(Object.keys(URGENCY_LABEL) as SurgeryUrgency[]).map((k) => ({ label: `急刀・${URGENCY_LABEL[k]}（${URGENCY_MINUTES[k] / 60} 小時內入刀房）`, value: k }))]" :error="req.fieldErrors.value.urgency" />
          <p v-if="form.urgency" class="mt-1 text-xs text-red-700">急刀從現在起算，手術室可排在開放時段外；撞到的擇期手術由手術室改期。</p></div>
        <div class="sm:col-span-2"><USelect :model-value="form.procId" label="術式" required :options="(opts?.procs ?? []).map((p) => ({ label: p.name, value: p.id }))" placeholder="選擇術式" :error="req.fieldErrors.value.procId" @update:model-value="pickProc" /></div>
        <USelect v-model="form.side" label="左右側" required :options="(Object.keys(SIDE_LABEL) as SurgerySide[]).map((k) => ({ label: SIDE_LABEL[k], value: k }))" placeholder="選擇" :error="req.fieldErrors.value.side" />
        <USelect v-model="form.anesthesia" label="麻醉方式" required :options="(Object.keys(ANESTHESIA_LABEL) as AnesthesiaType[]).map((k) => ({ label: ANESTHESIA_LABEL[k], value: k }))" :error="req.fieldErrors.value.anesthesia" />
        <UInput v-if="!form.urgency" v-model="form.requestedDate" type="date" label="預計日期" required :error="req.fieldErrors.value.requestedDate" />
        <UInput v-model="form.estMinutes" type="number" label="預估時間（分鐘）" required :error="req.fieldErrors.value.estMinutes" />
        <div class="sm:col-span-2"><UInput v-model="form.diagnosis" label="術前診斷" required :error="req.fieldErrors.value.diagnosis" /></div>
        <div class="sm:col-span-2"><UInput v-model="form.note" label="備註（選填，例：病人有抗凝血藥、術前停藥）" /></div>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="reqOpen = false">取消</UButton>
        <UButton type="submit" :loading="req.pending.value">申請</UButton>
      </template>
    </UDialog>

    <UDialog v-model="markOpen" :title="`術前準備：${marking?.label ?? ''}`" size="sm" @submit="submitMark">
      <div v-if="marking" class="space-y-3 text-sm">
        <fieldset v-if="marking.optional" class="flex gap-4">
          <label class="flex items-center gap-1.5"><input v-model="mk.mode" type="radio" value="done" class="h-4 w-4 text-brand-600" />已完成</label>
          <label class="flex items-center gap-1.5"><input v-model="mk.mode" type="radio" value="na" class="h-4 w-4 text-brand-600" />不需要</label>
        </fieldset>
        <template v-if="mk.mode === 'done' && needsRef">
          <USelect v-model="mk.refId" :label="marking.key === 'blood' ? '備血單' : '抗生素醫囑'" :options="refOptions" placeholder="選擇" :error="markAct.fieldErrors.value.refId" />
          <p v-if="!refOptions.length" class="text-xs text-amber-800">這次住院沒有{{ marking.key === 'blood' ? '備血單：請醫師開備血單（輸血分頁），或選「不需要」' : '抗生素醫囑：請醫師開立，或選「不需要」' }}。</p>
        </template>
        <template v-if="mk.mode === 'done' && npoRef">
          <USelect v-model="mk.refId" label="禁食醫囑（選填）" :options="[{ label: '不連醫囑', value: '' }, ...refOptions]" :error="markAct.fieldErrors.value.refId" />
          <p v-if="!refOptions.length" class="text-xs text-slate-500">這次住院沒有有效的禁食醫囑：可以請醫師開飲食醫囑「禁食」，或只勾已完成。</p>
        </template>
        <UInput v-if="mk.mode === 'na'" v-model="mk.notNeeded" label="不需要的原因" required :error="markAct.fieldErrors.value.notNeeded" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="markOpen = false">取消</UButton>
        <UButton type="submit" :loading="markAct.pending.value">記錄</UButton>
      </template>
    </UDialog>

    <PostopDialog v-model="postopOpen" :surgery-id="postopFor" />
    <UDialog v-model="recOpen" :title="`手術紀錄：${recording?.procName ?? ''}`" @submit="submitRec">
      <div class="space-y-3">
        <p v-if="recording?.team" class="rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">手術團隊：{{ recording.teamText }}</p>
        <UInput v-model="rec.performed" label="實際執行的術式" required :error="recAct.fieldErrors.value.performed" />
        <UTextarea v-model="rec.findings" label="術中發現" :rows="3" required :error="recAct.fieldErrors.value.findings" />
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <UInput v-model="rec.bloodLoss" type="number" label="失血量 ml" required :error="recAct.fieldErrors.value.bloodLoss" />
          <UInput v-model="rec.complications" label="併發症" />
          <UInput v-if="!recording?.specimenStructured" v-model="rec.specimen" label="檢體" />
          <p v-else class="self-end pb-2 text-xs text-slate-600">檢體：{{ recording?.specimenRows.length ? recording.specimenRows.map((x) => x.text).join('；') : '無' }}（照手術室登記）</p>
        </div>
        <p v-if="recording?.countMismatch" class="rounded bg-red-50 px-2 py-1 text-xs text-red-800">手術室紀錄紗布器械計數不符：{{ recording.counts?.mismatchReason }}</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="recOpen = false">取消</UButton>
        <UButton type="submit" :loading="recAct.pending.value">存檔</UButton>
      </template>
    </UDialog>

    <ReasonDialog
      v-model="cancelOpen"
      title="取消手術"
      :subject="cancelling ? `${cancelling.no} ${cancelling.procName}（${cancelling.sideText}）` : ''"
      label="取消原因"
      :presets="['病情改變，改保守治療', '病人或家屬不同意', '改期另申請']"
      ok-text="取消手術"
      danger
      :pending="cancel.pending.value"
      :error="cancel.fieldErrors.value.reason"
      @confirm="confirmCancel"
    />
  </div>
</template>
