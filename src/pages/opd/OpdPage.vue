<script setup lang="ts">
// 門診看診：左邊候診清單，右邊看診工作區（SOAP、診斷、醫令、歷史病歷）。
// 草稿在頁面裡編輯；「暫存」才寫入，「完成看診」才做完整驗證並推進狀態。
import { computed, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { CheckCircle2, Lock, Megaphone, Pencil, Save, SkipForward } from 'lucide-vue-next'
import {
  UBadge, UButton, UCard, UCheckbox, UEmpty, UInput, UQueryState, USelect, UStatusBadge, UTabs, UTextarea,
} from '@/components/ui'
import PatientBanner from '@/components/PatientBanner.vue'
import DiagnosisEditor from './components/DiagnosisEditor.vue'
import MedicationEditor, { type MedRow } from './components/MedicationEditor.vue'
import ProcedureEditor from './components/ProcedureEditor.vue'
import HistoryList from './components/HistoryList.vue'
import { autoQty, masterApi, opdApi, preventApi } from '@/services'
import type { EncounterDraft, HistoryItem, QueueItem } from '@/services/opd'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import { ageText, periodLabel, today } from '@/utils/date'
import { visitStatus } from '@/utils/labels'
import type { Encounter } from '@/types'

const auth = useAuth()
const ui = useUi()

// ---------- 醫師與候診清單 ----------
const isAdmin = auth.user?.role === 'admin'
const doctorId = ref<string | number | undefined>(auth.user?.doctorId ?? 'DR01')
const { data: doctors } = useQuery(async () => (isAdmin ? masterApi.listDoctors() : []))
const { data: queue, loading: queueLoading } = useQuery(() => opdApi.listQueue({ date: today(), doctorId: String(doctorId.value) }), [doctorId])
const counts = computed(() => {
  const q = queue.value ?? []
  return {
    waiting: q.filter((v) => v.status === 'registered').length,
    inConsult: q.filter((v) => v.status === 'in-consult').length,
    done: q.filter((v) => !['registered', 'in-consult'].includes(v.status)).length,
  }
})

// ---------- 參考資料（一次載入，畫面查表用） ----------
const { data: drugList } = useQuery(() => masterApi.listDrugs({ includeInactive: true }))
const { data: procList } = useQuery(() => masterApi.listProcedures({ includeInactive: true }))
const { data: freqList } = useQuery(() => masterApi.listFrequencies())
const drugs = computed(() => new Map((drugList.value ?? []).map((d) => [d.id, d])))
const procs = computed(() => new Map((procList.value ?? []).map((p) => [p.id, p])))
const freqs = computed(() => freqList.value ?? [])

// ---------- 目前病人與病歷 ----------
const visitId = ref<string>()
const visit = computed(() => queue.value?.find((v) => v.id === visitId.value))
const { data: encounter } = useQuery(async () => (visitId.value ? (await opdApi.getEncounterByVisit(visitId.value)) ?? null : null), [visitId])
const { data: history } = useQuery(async () => (visit.value ? opdApi.patientHistory(visit.value.patientId, visit.value.id) : []), [() => visit.value?.patientId])

type Draft = Omit<EncounterDraft, 'medications'> & { medications: MedRow[] }

const emptyDraft = (): Draft => ({
  subjective: '', objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [], medications: [], procedures: [], refillTimes: 0, admissionRequested: false,
})
const timesOf = (f: string) => freqs.value.find((x) => x.code === f)?.timesPerDay ?? 1
const autoQtyOf = (m: { drugId: string; dose: number; freq: string; days: number }) => {
  const d = drugs.value.get(m.drugId)
  return d ? autoQty(d, m.dose, timesOf(m.freq), m.days) : null
}

function toDraft(e: Encounter | null | undefined): Draft {
  if (!e) return emptyDraft()
  const { subjective, objective, assessment, plan, vitals, diagnoses, medications, procedures, refillTimes, admissionRequested } = structuredClone(e)
  return {
    subjective, objective, assessment, plan, vitals, diagnoses, procedures, refillTimes, admissionRequested,
    // 總量和自動計算結果不同，代表當初是手動修改的
    // 總量和自動計算結果不同（或根本無法換算），代表是醫師手動填的
    medications: medications.map((m) => ({ ...m, _manual: m.qty !== autoQtyOf(m) })),
  }
}
/** 送出前移除畫面專用欄位 */
const strip = (d: Draft): EncounterDraft => ({ ...d, medications: d.medications.map(({ _manual: _m, ...m }) => m) })

const draft = ref<Draft>(emptyDraft())
const baseline = ref('')
const dirty = computed(() => !!encounter.value && JSON.stringify(strip(draft.value)) !== baseline.value)
let loadedVisitId: string | undefined

// 病歷資料重新載入時：換了病人就重設；同一位病人且有未儲存的修改，就保留使用者正在打的內容
watch(encounter, (e) => {
  if (e && e.visitId === loadedVisitId && dirty.value) return
  draft.value = toDraft(e)
  baseline.value = JSON.stringify(strip(draft.value))
  loadedVisitId = e?.visitId
})

const editable = computed(() => visit.value?.status === 'in-consult' && encounter.value?.status === 'draft')
const tab = ref('soap')

async function confirmDiscard() {
  return !dirty.value || ui.confirm({ title: '尚未儲存', message: '目前病歷有未儲存的修改，確定要離開？', okText: '放棄修改', danger: true })
}
async function selectVisit(v: QueueItem) {
  if (v.id === visitId.value) return
  if (!(await confirmDiscard())) return
  visitId.value = v.id
  tab.value = 'soap'
}
onBeforeRouteLeave(confirmDiscard)

// ---------- 過敏檢查（服務層判斷，頁面顯示） ----------
const drugKey = computed(() => draft.value.medications.map((m) => m.drugId).join(','))
const { data: warnings } = useQuery(
  async () => (visit.value && drugKey.value ? opdApi.allergyWarnings(visit.value.patientId, drugKey.value.split(',')) : []),
  [drugKey, () => visit.value?.patientId],
)

// ---------- 動作 ----------
const start = useAction(opdApi.startConsult)
async function callPatient() {
  if (visit.value) await start.run(visit.value.id)
}

const saveDraft = useAction(async () => {
  const e = await opdApi.saveDraft(encounter.value!.id, strip(draft.value))
  baseline.value = JSON.stringify(strip(draft.value))
  return e
}, { success: '已暫存' })

const skip = useAction(opdApi.skipPatient, { success: (v) => `${v.patientName} 過號，退回候診` })
async function onSkip() {
  if (!visit.value || !(await confirmDiscard())) return
  await skip.run(visit.value.id)
}

const complete = useAction(async () => {
  const r = await opdApi.completeEncounter(encounter.value!.id, strip(draft.value))
  baseline.value = JSON.stringify(strip(draft.value))
  return r
}, { success: (r) => (r.admission ? '完成看診，並已建立住院預約' : '完成看診，病人可前往批價') })

async function onComplete() {
  // 本地先檢查，省一次往返；服務層仍會再驗證
  if (!draft.value.diagnoses.length) {
    tab.value = 'dx'
    return ui.toast.warning('請至少輸入一個診斷')
  }
  const w = warnings.value ?? []
  if (w.length) {
    const ok = await ui.confirm({
      title: '過敏警示',
      message: `${w.map((x) => `・${x.drugName}（病人對 ${x.allergen} 過敏）`).join('\n')}\n\n確認已評估風險，仍要開立？`,
      okText: '確認開立',
      danger: true,
    })
    if (!ok) return
  }
  await complete.run()
}

const nextWaiting = computed(() => (queue.value ?? []).find((v) => v.status === 'registered' && v.id !== visitId.value))
function goNext() {
  if (nextWaiting.value) selectVisit(nextWaiting.value)
}

// ---------- 歷史病歷：複製處方 ----------
function copyFrom(h: HistoryItem) {
  let added = 0
  for (const m of h.medications) {
    if (draft.value.medications.some((x) => x.drugId === m.drugId)) continue
    // 可換算的藥依目前頻率重算總量；無法換算的（Insulin、眼藥水）沿用上次的總量並標示為手動
    const q = autoQtyOf(m)
    draft.value.medications.push({ ...structuredClone(m), _manual: q === null, qty: q ?? m.qty })
    added++
  }
  if (!draft.value.diagnoses.length) draft.value.diagnoses = structuredClone(h.diagnoses)
  ui.toast.success(added ? `已複製 ${added} 項藥品（重複的略過）` : '處方中已有相同藥品，未新增')
  tab.value = 'orders'
}

const defaultDays = computed(() => (visit.value && ['04', '08'].includes(visit.value.caseType) ? 28 : 3))
const { data: preventItems } = useQuery(() => preventApi.listPreventItems())
const preventNames = computed(() => (visit.value?.preventItems ?? []).map((c) => preventItems.value?.find((i) => i.code === c)?.name ?? c).join('、'))
const caseTypeName = (code: string) => masterApi.staticCodes.caseTypes.find((c) => c.code === code)?.name ?? code
const bmi = computed(() => {
  const { height, weight } = draft.value.vitals
  return height && weight ? (weight / (height / 100) ** 2).toFixed(1) : '—'
})
const tabs = computed(() => [
  { key: 'soap', label: 'SOAP・生命徵象' },
  { key: 'dx', label: '診斷', count: draft.value.diagnoses.length },
  { key: 'orders', label: '醫令', count: draft.value.medications.length + draft.value.procedures.length },
  { key: 'history', label: '歷史病歷', count: history.value?.length },
])
</script>

<template>
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-[17rem_1fr]">
    <!-- 候診清單 -->
    <UCard :padded="false" class="self-start">
      <template #title>
        <div class="text-sm font-semibold text-slate-800">今日候診</div>
        <div class="text-xs text-slate-500">候診 {{ counts.waiting }}・看診中 {{ counts.inConsult }}・完成 {{ counts.done }}</div>
      </template>
      <div v-if="isAdmin" class="border-b border-slate-100 p-3">
        <USelect v-model="doctorId" label="檢視醫師（管理員）" :options="(doctors ?? []).map((d) => ({ label: d.name, value: d.id }))" />
      </div>
      <!-- 「載入中」與「沒有資料」要分開：載入中就顯示沒病人，會讓醫師誤判 -->
      <UQueryState :loading="queueLoading" :ready="!!queue?.length" empty-title="今天沒有掛號病人">
      <ul class="max-h-[calc(100vh-12rem)] divide-y divide-slate-100 overflow-y-auto">
        <li v-for="v in queue" :key="v.id">
          <button
            :class="['flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50', v.id === visitId && '!bg-brand-50']"
            @click="selectVisit(v)"
          >
            <span :class="['tabular w-8 text-center text-lg font-bold', v.status === 'registered' ? 'text-brand-600' : 'text-slate-400']">{{ v.seqNo }}</span>
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium text-slate-800">{{ v.patientName }}</span>
              <span class="block text-xs text-slate-500">{{ periodLabel[v.period] }}・{{ v.gender === 'M' ? '男' : '女' }} {{ ageText(v.birthDate) }}<template v-if="v.firstVisit">・初診</template></span>
            </span>
            <UStatusBadge :map="visitStatus" :value="v.status" />
          </button>
        </li>
      </ul>
      </UQueryState>
    </UCard>

    <!-- 看診工作區 -->
    <UCard v-if="!visit"><UEmpty title="請從左側選擇病人" description="點選候診病人後按「叫號」開始看診" /></UCard>
    <div v-else class="min-w-0 space-y-3">
      <PatientBanner :patient="visit">
        <UBadge tone="blue">{{ visit.identityName }}</UBadge>
        <UBadge>{{ visit.caseType }} {{ caseTypeName(visit.caseType) }}</UBadge>
        <UBadge v-if="visit.firstVisit" tone="purple">初診</UBadge>
        <UBadge v-if="visit.preventItems.length" tone="green">預防保健：{{ preventNames }}</UBadge>
      </PatientBanner>

      <!-- 尚未叫號 -->
      <UCard v-if="visit.status === 'registered'">
        <UEmpty :icon="Megaphone" :title="`第 ${visit.seqNo} 號 ${visit.patientName} 候診中`" description="叫號後開始記錄病歷">
          <div class="flex gap-2">
            <UButton :icon="Megaphone" :loading="start.pending.value" @click="callPatient">叫號・開始看診</UButton>
          </div>
        </UEmpty>
      </UCard>

      <!-- 已完成或已鎖定：說明狀態 -->
      <div v-else-if="!editable" class="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
        <Lock class="h-4 w-4" />
        <template v-if="visit.status === 'consulted'">
          已完成看診，等待批價。病人尚未結帳前仍可修改。
          <UButton size="sm" variant="secondary" :icon="Pencil" :loading="start.pending.value" @click="callPatient">修改醫囑</UButton>
        </template>
        <template v-else>此次就醫已批價，病歷已鎖定；如需修改，請批價櫃台先作廢收據。</template>
        <UButton v-if="nextWaiting" size="sm" class="ml-auto" @click="goNext">下一位：第 {{ nextWaiting.seqNo }} 號 {{ nextWaiting.patientName }}</UButton>
      </div>

      <UCard v-if="visit.status !== 'registered' || history?.length" :padded="false">
        <div class="px-4 pt-1"><UTabs v-model="tab" :tabs="visit.status === 'registered' ? tabs.filter((t) => t.key === 'history') : tabs" /></div>
        <div class="p-4">
          <!-- SOAP 與生命徵象 -->
          <div v-show="tab === 'soap' && visit.status !== 'registered'" class="space-y-4">
            <div class="grid grid-cols-4 gap-3 md:grid-cols-8">
              <UInput v-model="draft.vitals.height" label="身高 cm" type="number" :disabled="!editable" />
              <UInput v-model="draft.vitals.weight" label="體重 kg" type="number" :disabled="!editable" />
              <UInput v-model="draft.vitals.temp" label="體溫 °C" type="number" step="0.1" :disabled="!editable" />
              <UInput v-model="draft.vitals.pulse" label="脈搏" type="number" :disabled="!editable" />
              <UInput v-model="draft.vitals.sbp" label="收縮壓" type="number" :disabled="!editable" />
              <UInput v-model="draft.vitals.dbp" label="舒張壓" type="number" :disabled="!editable" />
              <UInput v-model="draft.vitals.spo2" label="SpO2 %" type="number" :disabled="!editable" />
              <div>
                <div class="mb-1 text-xs font-medium text-slate-600">BMI</div>
                <div class="tabular py-1.5 text-sm text-slate-800">{{ bmi }}</div>
              </div>
            </div>
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <UTextarea v-model="draft.subjective" label="S 主訴（病人主觀描述）" :rows="4" :disabled="!editable" />
              <UTextarea v-model="draft.objective" label="O 客觀檢查" :rows="4" :disabled="!editable" />
              <UTextarea v-model="draft.assessment" label="A 評估" :rows="3" :disabled="!editable" />
              <UTextarea v-model="draft.plan" label="P 計畫" :rows="3" :disabled="!editable" />
            </div>
          </div>

          <DiagnosisEditor v-if="tab === 'dx'" v-model="draft.diagnoses" :readonly="!editable" />

          <div v-if="tab === 'orders'" class="space-y-5">
            <section>
              <h3 class="mb-2 text-sm font-semibold text-slate-700">藥品</h3>
              <MedicationEditor v-model="draft.medications" :drugs="drugs" :freqs="freqs" :warnings="warnings ?? []" :default-days="defaultDays" :readonly="!editable" />
            </section>
            <section>
              <h3 class="mb-2 text-sm font-semibold text-slate-700">處置・檢驗・影像</h3>
              <ProcedureEditor v-model="draft.procedures" :procs="procs" :readonly="!editable" />
            </section>
            <section class="flex flex-wrap items-end gap-6 border-t border-slate-100 pt-4">
              <div v-if="['04', '08'].includes(visit.caseType)" class="w-48">
                <USelect v-model="draft.refillTimes" label="慢性病連續處方箋" :options="[{ label: '非連續處方', value: 0 }, { label: '可調劑 2 次', value: 2 }, { label: '可調劑 3 次', value: 3 }]" :disabled="!editable" />
              </div>
              <UCheckbox v-model="draft.admissionRequested" label="建議住院（完成看診後自動建立住院預約）" :disabled="!editable" class="pb-2" />
            </section>
          </div>

          <HistoryList v-if="tab === 'history'" :items="history ?? []" :drugs="drugs" :readonly="!editable" @copy="copyFrom" />
        </div>
      </UCard>

      <!-- 操作列：固定在畫面底部 -->
      <div v-if="editable" class="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
        <span v-if="dirty" class="text-xs text-amber-600">● 有未儲存的修改</span>
        <span v-else class="text-xs text-slate-400">已儲存</span>
        <div class="ml-auto flex gap-2">
          <UButton variant="ghost" :icon="SkipForward" :loading="skip.pending.value" @click="onSkip">過號</UButton>
          <UButton variant="secondary" :icon="Save" :disabled="!dirty" :loading="saveDraft.pending.value" @click="saveDraft.run()">暫存</UButton>
          <UButton variant="success" :icon="CheckCircle2" :loading="complete.pending.value" @click="onComplete">完成看診</UButton>
        </div>
      </div>
    </div>
  </div>
</template>
