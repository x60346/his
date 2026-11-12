<script setup lang="ts">
// 門診看診：左邊候診清單，右邊看診工作區（SOAP、診斷、醫令、歷史病歷）。
// 草稿在頁面裡編輯；「暫存」才寫入，「完成看診」才做完整驗證並推進狀態。
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { clonePlain } from '@/utils/clone'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { CheckCircle2, ChevronsRight, Lock, Megaphone, Pencil, Save, ShieldCheck, SkipForward } from 'lucide-vue-next'
import {
  UBadge, UButton, UCard, UCheckbox, UDialog, UEmpty, UInput, UQueryState, USelect, UStatusBadge, UTabs, UTextarea,
} from '@/components/ui'
import PatientBanner from '@/components/PatientBanner.vue'
import PreventRecordDialog from '@/components/PreventRecordDialog.vue'
import DiagnosisEditor from './components/DiagnosisEditor.vue'
import MedicationEditor, { type MedRow } from './components/MedicationEditor.vue'
import ProcedureEditor from './components/ProcedureEditor.vue'
import OrderSetBar from './components/OrderSetBar.vue'
import HistoryList from './components/HistoryList.vue'
import { autoQty, doseLevel, doseNote, masterApi, nextInQueue, opdApi, patientApi, preventApi, ServiceError, type ExpandedOrderSet } from '@/services'
import type { EncounterDraft, HistoryItem, QueueItem } from '@/services/opd'
import { Cancelled, useAction, useQuery } from '@/composables/useService'
import { useToday } from '@/composables/useClock'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import { ageText, periodLabel } from '@/utils/date'
import { visitStatus } from '@/utils/labels'
import type { Encounter, PreventItem } from '@/types'

const auth = useAuth()
const ui = useUi()

// ---------- 醫師與候診清單 ----------
const isAdmin = auth.user?.role === 'admin'
const doctorId = ref<string | number | undefined>(auth.user?.doctorId ?? 'DR01')
const { data: doctors } = useQuery(async () => (isAdmin ? masterApi.listDoctors() : []))
const todayStr = useToday() // 跨日時候診清單換成新的一天
const { data: queue, loading: queueLoading } = useQuery(() => opdApi.listQueue({ date: todayStr.value, doctorId: String(doctorId.value) }), [doctorId, todayStr])
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
useRevealOnNarrow(visitId) // 窄螢幕點選後把明細捲進畫面
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
  const { subjective, objective, assessment, plan, vitals, diagnoses, medications, procedures, refillTimes, admissionRequested } = clonePlain(e)
  return {
    subjective, objective, assessment, plan, vitals, diagnoses, procedures, refillTimes, admissionRequested,
    // 總量和自動計算結果不同，代表當初是手動修改的
    // 總量和自動計算結果不同（或根本無法換算），代表是醫師手動填的
    medications: medications.map((m) => ({ ...m, _manual: m.qty !== autoQtyOf(m) })),
  }
}
/** 送出前移除畫面專用欄位 */
const strip = (d: Draft): EncounterDraft => ({ ...d, medications: d.medications.map(({ _manual: _m, _qtyStale: _s, ...m }) => m) })

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
// 「看診」一頁照 SOAP 順序排（生命徵象 → S/O → A＋診斷 → P＋醫令），「歷史病歷」另一頁。
// 以前拆成 SOAP／診斷／醫令／歷史四個分頁：寫主訴看不到上次處方、開藥看不到剛寫的評估，檢查出錯還會自動跳分頁。
const tab = ref<'visit' | 'history'>('visit')
type Section = 'so' | 'dx' | 'orders'
const sectionEls: Partial<Record<Section, HTMLElement>> = {}
const setSection = (k: Section) => (el: unknown) => {
  if (el) sectionEls[k] = el as HTMLElement
}
// 候診中（還沒叫號）只有「歷史病歷」可看：直接顯示歷史，免得畫面上只有一個沒選中的分頁、內容一片空白；叫號後切回看診
watch(
  () => [visitId.value, visit.value?.status] as const,
  ([, s]) => {
    if (s === 'registered') tab.value = 'history'
    else if (s === 'in-consult' && tab.value === 'history') tab.value = 'visit'
  },
)
/** 捲到某一段（以前是切換分頁）：檢查出錯、套用組套、複製處方之後，帶到該段，正在寫的內容不會從眼前消失 */
async function goSection(k: Section) {
  tab.value = 'visit'
  await nextTick()
  sectionEls[k]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function confirmDiscard() {
  return !dirty.value || ui.confirm({ title: '尚未儲存', message: '目前病歷有未儲存的修改，確定要離開？', okText: '放棄修改', danger: true })
}
async function selectVisit(v: QueueItem) {
  if (v.id === visitId.value) return
  if (!(await confirmDiscard())) return
  visitId.value = v.id
  tab.value = 'visit'
}
onBeforeRouteLeave(confirmDiscard)

// ---------- 過敏檢查（服務層判斷，頁面顯示） ----------
const drugKey = computed(() => draft.value.medications.map((m) => m.drugId).join(','))
const { data: warnings } = useQuery(
  async () => (visit.value && drugKey.value ? opdApi.allergyWarnings(visit.value.patientId, drugKey.value.split(',')) : []),
  [drugKey, () => visit.value?.patientId],
)

// ---------- 動作 ----------
/**
 * 叫號：這位醫師還有別人在看診中時，服務層先擋下（field = 'parallel'），這裡問醫師要不要回去完成那一位。
 * 「仍要叫號」才帶 allowParallel 重送（病人去檢查、等報告時先看下一位）；「回到第 N 號」直接選回那位病人。
 */
const start = useAction(async (id: string) => {
  try {
    return await opdApi.startConsult(id)
  } catch (e) {
    if (!(e instanceof ServiceError && e.code === 'CONFLICT' && e.field === 'parallel')) throw e
    const other = queue.value?.find((x) => x.status === 'in-consult' && x.id !== id)
    const ok = await ui.confirm({
      title: '上一位還在看診中',
      message: `${e.message}。\n\n病人去做檢查、等報告時，可以先看下一位；否則請先回去完成他，免得病歷停在草稿、批價等不到人。`,
      okText: '仍要叫號',
      cancelText: other ? `回到第 ${other.seqNo} 號` : '取消',
    })
    if (!ok) {
      if (other) await selectVisit(other)
      throw new Cancelled()
    }
    return opdApi.startConsult(id, { allowParallel: true })
  }
})
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
  // 過號後醫師要做的就是看下一位：直接選好下一位（不自動叫號——叫號仍由醫師按）
  if (await skip.run(visit.value.id)) goNext()
}

const complete = useAction(async (opts: { confirmHighDose?: boolean } = {}) => {
  const r = await opdApi.completeEncounter(encounter.value!.id, strip(draft.value), opts)
  baseline.value = JSON.stringify(strip(draft.value))
  return r
}, { success: (r) => (r.admission ? '完成看診，並已建立住院預約' : '完成看診，病人可前往批價') })

/** 完成看診；回傳是否真的完成（過敏、劑量確認按取消，或服務層擋下，都算沒完成——「完成並叫下一位」就不會往下叫） */
async function onComplete(): Promise<boolean> {
  // 本地先檢查，省一次往返；服務層仍會再驗證
  if (!draft.value.diagnoses.length) {
    goSection('dx')
    ui.toast.warning('請至少輸入一個診斷')
    return false
  }
  const w = warnings.value ?? []
  if (w.length) {
    const ok = await ui.confirm({
      title: '過敏警示',
      message: `${w.map((x) => `・${x.drugName}（病人對 ${x.allergen} 過敏）`).join('\n')}\n\n確認已評估風險，仍要開立？`,
      okText: '確認開立',
      danger: true,
    })
    if (!ok) return false
  }
  // 劑量：不合理的直接擋（幾乎一定是打錯）；偏高的列出來請醫師確認一次
  const doses = draft.value.medications
    .map((m) => ({ m, d: drugs.value.get(m.drugId) }))
    .filter((x): x is { m: typeof x.m; d: NonNullable<typeof x.d> } => !!x.d)
    .map((x) => ({ ...x, level: doseLevel(x.d, x.m.dose) }))
  const absurd = doses.filter((x) => x.level === 'absurd')
  if (absurd.length) {
    goSection('orders')
    ui.toast.warning(`${absurd.map((x) => `${x.d.name}：${doseNote(x.d, x.m.dose)}`).join('；')}，請確認是否打錯`)
    return false
  }
  const high = doses.filter((x) => x.level === 'high')
  if (high.length) {
    const ok = await ui.confirm({
      title: '劑量偏高',
      message: `${high.map((x) => `・${x.d.name}：${doseNote(x.d, x.m.dose)}`).join('\n')}\n\n確定劑量無誤？`,
      okText: '劑量無誤，完成看診',
      danger: true,
    })
    if (!ok) return false
  }
  return (await complete.run({ confirmHighDose: high.length > 0 })) !== undefined
}

/**
 * 完成並叫下一位：一次點擊做完「完成 → 選下一位 → 叫號」（以前要點三下）。
 * 過敏、劑量的確認照樣會跳出來；沒有真的完成就停在原病人，不會往下叫。下一位依 nextInQueue（過號的人排後面）。
 */
async function onCompleteAndNext() {
  if (complete.pending.value || start.pending.value) return
  if (!(await onComplete())) return
  await callNext()
}
/** 選下一位並叫號（已完成看診的畫面上那顆按鈕也用它） */
async function callNext() {
  const n = nextWaiting.value
  if (!n) return
  await selectVisit(n)
  if (visitId.value === n.id) await start.run(n.id)
}

// Ctrl+Enter＝完成並叫下一位：只在「看診中、可編輯」時有效，其他時候按了不會有任何動作
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && editable.value && visit.value?.status === 'in-consult') {
    e.preventDefault()
    onCompleteAndNext()
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// 下一位：先叫沒過號的；過號的人回來時直接在清單上點他（規則在 nextInQueue）
const nextWaiting = computed(() => nextInQueue(queue.value ?? [], visitId.value))
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
    draft.value.medications.push({ ...clonePlain(m), _manual: q === null, qty: q ?? m.qty })
    added++
  }
  if (!draft.value.diagnoses.length) draft.value.diagnoses = clonePlain(h.diagnoses)
  ui.toast.success(added ? `已複製 ${added} 項藥品（重複的略過）` : '處方中已有相同藥品，未新增')
  goSection('orders')
}

// ---------- 套用組套：合併進目前處方，不覆蓋 ----------
// 規則和「複製處方」一致：重複的略過、診斷只在本次還沒有時帶入；主訴、計畫只填空白的欄位。
// 慢性病案件（04／08）天數用預設的 28 天；總量依「劑量 × 頻率 × 天數」重算（和手動開藥同一個 autoQty）。
function applySet(x: ExpandedOrderSet) {
  let meds = 0
  let procsAdded = 0
  for (const m of x.medications) {
    if (draft.value.medications.some((y) => y.drugId === m.drugId)) continue
    const days = defaultDays.value === 28 ? 28 : m.days
    const q = autoQtyOf({ ...m, days })
    draft.value.medications.push({ ...m, days, _manual: q === null, qty: q ?? m.qty })
    meds++
  }
  for (const p of x.procedures) {
    if (draft.value.procedures.some((y) => y.procId === p.procId)) continue
    draft.value.procedures.push({ ...p })
    procsAdded++
  }
  if (!draft.value.diagnoses.length) draft.value.diagnoses = clonePlain(x.diagnoses)
  if (!draft.value.subjective.trim() && x.subjective) draft.value.subjective = x.subjective
  if (!draft.value.plan.trim() && x.plan) draft.value.plan = x.plan
  const parts = [meds && `${meds} 種藥`, procsAdded && `${procsAdded} 項處置`].filter(Boolean).join('、') || '沒有新的項目（重複的略過）'
  const skipped = x.skipped.length ? `；${x.skipped.join('、')} 已停用，未帶入` : ''
  ;(x.skipped.length ? ui.toast.warning : ui.toast.success)(`已套用「${x.name}」：${parts}${skipped}`)
  goSection('orders')
}

const defaultDays = computed(() => (visit.value && ['04', '08'].includes(visit.value.caseType) ? 28 : 3))
const { data: preventItems } = useQuery(() => preventApi.listPreventItems())

// ---------- 預防保健：在看診頁直接登錄（以前要換到預防保健頁重找病人，血壓身高體重還要再打一次）----------
// 登錄框與預防保健頁共用（PreventRecordDialog），規則只有一份；本次已量的生命徵象預先帶入，仍可修改
// ---------- 看診中新增過敏：病人當場說「我對盤尼西林過敏」，不必離開看診頁 ----------
// 只能新增（服務層 addAllergy）；新增後過敏警示查詢會隨資料版本重查，處方中相關的藥立即標紅
const allergyOpen = ref(false)
const allergen = ref<string | number>('')
const addAllergy = useAction(patientApi.addAllergy, { success: (p) => `已記錄：${p.name} 對 ${p.allergies.at(-1)} 過敏` })
// 已記錄的不再列出（選了也只會被擋）
const allergyChoices = computed(() => masterApi.staticCodes.allergyOptions.filter((a) => !visit.value?.allergies.includes(a)))
function openAllergy() {
  allergen.value = ''
  addAllergy.fieldErrors.value = {}
  allergyOpen.value = true
}
async function submitAllergy() {
  if (!visit.value || !allergen.value) return
  if (await addAllergy.run(visit.value.patientId, String(allergen.value))) allergyOpen.value = false
}

const { data: preventStatus } = useQuery(
  async () => (visit.value?.preventItems.length ? preventApi.visitPreventStatus(visit.value.id) : []),
  [() => visit.value?.id],
)
const preventOpen = ref(false)
const preventItem = ref<PreventItem>()
const preventPrefill = computed<Record<string, string>>(() => {
  const v = draft.value.vitals
  const out: Record<string, string> = {}
  if (v.sbp && v.dbp) out['血壓'] = `${v.sbp}/${v.dbp}`
  if (v.height) out['身高'] = String(v.height)
  if (v.weight) out['體重'] = String(v.weight)
  return out
})
function openPrevent(item: PreventItem) {
  preventItem.value = item
  preventOpen.value = true
}
const preventNames = computed(() => (visit.value?.preventItems ?? []).map((c) => preventItems.value?.find((i) => i.code === c)?.name ?? c).join('、'))
const caseTypeName = (code: string) => masterApi.staticCodes.caseTypes.find((c) => c.code === code)?.name ?? code
const bmi = computed(() => {
  const { height, weight } = draft.value.vitals
  return height && weight ? (weight / (height / 100) ** 2).toFixed(1) : '—'
})
const tabs = computed(() => [
  { key: 'visit', label: '看診' },
  { key: 'history', label: '歷史病歷', count: history.value?.length },
])
// 段落捷徑（固定在看診頁上方）：頁面變長了，點一下就捲到該段，並看得到診斷、醫令的數量
const sectionLinks = computed(() => [
  { key: 'so' as Section, label: 'S／O' },
  { key: 'dx' as Section, label: '診斷', count: draft.value.diagnoses.length },
  { key: 'orders' as Section, label: '醫令', count: draft.value.medications.length + draft.value.procedures.length },
])
// 前次就診摘要：寫主訴時就看得到上次的診斷與處方（以前要切到歷史分頁）
const lastVisit = computed(() => history.value?.[0])
const lastOpen = ref(true)
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
            <UBadge v-if="v.status === 'registered' && v.skippedAt" tone="yellow">過號</UBadge>
            <UStatusBadge v-else :map="visitStatus" :value="v.status" />
            <!-- 同時有兩位以上看診中：提醒醫師還有人沒結束（去檢查、等報告的病人，或忘了按完成的） -->
            <UBadge v-if="v.status === 'in-consult' && counts.inConsult > 1" tone="yellow">同時看診</UBadge>
          </button>
        </li>
      </ul>
      </UQueryState>
    </UCard>

    <!-- 看診工作區 -->
    <UCard v-if="!visit" data-detail><UEmpty title="請從清單選擇病人" description="點選候診病人後按「叫號」開始看診" /></UCard>
    <div v-else data-detail class="min-w-0 space-y-3">
      <PatientBanner :patient="visit">
        <UBadge tone="blue">{{ visit.identityName }}</UBadge>
        <UBadge>{{ visit.caseType }} {{ caseTypeName(visit.caseType) }}</UBadge>
        <UBadge v-if="visit.firstVisit" tone="purple">初診</UBadge>
        <!-- 預防保健：每一項一顆按鈕，點了就在這裡登錄；登錄過的顯示結果 -->
        <template v-if="preventStatus?.length">
          <template v-for="s in preventStatus" :key="s.item.code">
            <UBadge v-if="s.done" tone="green">✓ {{ s.item.name }}（{{ s.result }}）</UBadge>
            <button v-else type="button" class="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-emerald-700" @click="openPrevent(s.item)">
              <ShieldCheck class="h-3.5 w-3.5" />{{ s.item.name }}・登錄
            </button>
          </template>
        </template>
        <UBadge v-else-if="visit.preventItems.length" tone="green">預防保健：{{ preventNames }}</UBadge>
        <template #allergy-actions>
          <button type="button" class="ml-1 rounded border border-current px-1 text-xs font-medium opacity-80 hover:opacity-100" title="病人當場告知的過敏，直接記錄（只能新增；移除請到病患資料）" @click="openAllergy">＋過敏</button>
        </template>
      </PatientBanner>
      <UDialog v-model="allergyOpen" title="新增過敏" size="sm" @submit="submitAllergy">
        <div class="space-y-3 text-sm">
          <p class="text-slate-600">{{ visit.patientName }} 目前記錄：{{ visit.allergies.length ? visit.allergies.join('、') : '無已知過敏' }}</p>
          <USelect v-model="allergen" label="過敏原" required placeholder="請選擇" :options="allergyChoices" :error="addAllergy.fieldErrors.value.allergen" />
          <p class="text-xs text-slate-500">新增後，本次處方中相關的藥會立即標示過敏警示。移除過敏請到「病患資料」。</p>
        </div>
        <template #footer>
          <UButton variant="secondary" @click="allergyOpen = false">取消</UButton>
          <UButton type="submit" variant="danger" :disabled="!allergen" :loading="addAllergy.pending.value">新增過敏</UButton>
        </template>
      </UDialog>
      <PreventRecordDialog v-model="preventOpen" :item="preventItem" :patient="visit" :visit-id="visit.id" :prefill="preventPrefill" />

      <!-- 尚未叫號 -->
      <UCard v-if="visit.status === 'registered'">
        <UEmpty :icon="Megaphone" :title="`第 ${visit.seqNo} 號 ${visit.patientName} ${visit.skippedAt ? '已過號' : '候診中'}`" description="叫號後開始記錄病歷">
          <div class="flex gap-2">
            <UButton :icon="Megaphone" :loading="start.pending.value" @click="callPatient">叫號・開始看診</UButton>
          </div>
        </UEmpty>
      </UCard>

      <!-- 已完成或已鎖定：說明狀態。看診中的一定有草稿病歷，不可編輯只會是「病歷還在載入」——以前這一瞬間會閃出「已批價，病歷已鎖定」 -->
      <div v-else-if="!editable && visit.status !== 'in-consult'"class="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
        <Lock class="h-4 w-4" />
        <template v-if="visit.status === 'consulted'">
          已完成看診，等待批價。病人尚未結帳前仍可修改。
          <UButton size="sm" variant="secondary" :icon="Pencil" :loading="start.pending.value" @click="callPatient">修改醫囑</UButton>
        </template>
        <template v-else>此次就醫已批價，病歷已鎖定；如需修改，請批價櫃台先作廢收據。</template>
        <UButton v-if="nextWaiting" size="sm" class="ml-auto" :icon="Megaphone" :loading="start.pending.value" @click="callNext">叫號：第 {{ nextWaiting.seqNo }} 號 {{ nextWaiting.patientName }}</UButton>
      </div>

      <UCard v-if="visit.status !== 'registered' || history?.length" :padded="false">
        <div class="px-4 pt-1"><UTabs v-model="tab" :tabs="visit.status === 'registered' ? tabs.filter((t) => t.key === 'history') : tabs" /></div>
        <!-- 段落捷徑：固定在上方，點一下捲到該段 -->
        <div v-if="tab === 'visit' && visit.status !== 'registered'" class="sticky top-0 z-[5] flex gap-1.5 border-b border-slate-100 bg-white/95 px-4 py-1.5 backdrop-blur">
          <button v-for="s in sectionLinks" :key="s.key" type="button" class="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs text-slate-600 hover:border-brand-300 hover:text-brand-700" @click="goSection(s.key)">
            {{ s.label }}<span v-if="s.count !== undefined" class="tabular ml-1 font-medium text-slate-800">{{ s.count }}</span>
          </button>
        </div>
        <div class="p-4">
          <!-- 看診：照 SOAP 的順序一頁寫完（以前拆成四個分頁） -->
          <div v-show="tab === 'visit' && visit.status !== 'registered'" class="space-y-5">
            <!-- 前次就診摘要：寫主訴時就看得到上次的診斷與處方 -->
            <div v-if="lastVisit" class="rounded-md border border-slate-200 bg-slate-50 text-sm">
              <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left" @click="lastOpen = !lastOpen">
                <span class="font-medium text-slate-700">前次就診</span>
                <span class="tabular text-xs text-slate-500">{{ lastVisit.date }}・{{ lastVisit.deptName }} {{ lastVisit.doctorName }}</span>
                <span class="ml-auto text-xs text-slate-400">{{ lastOpen ? '收合' : '展開' }}</span>
              </button>
              <div v-if="lastOpen" class="space-y-1 border-t border-slate-200 px-3 py-2">
                <div><span class="text-xs text-slate-500">診斷</span> {{ lastVisit.diagnoses.map((d) => `${d.icd} ${d.name}`).join('、') || '—' }}</div>
                <div class="flex items-start gap-2">
                  <span class="text-xs text-slate-500">處方</span>
                  <span class="min-w-0 flex-1">{{ lastVisit.medicationNames.join('、') || '無' }}</span>
                  <UButton v-if="editable && lastVisit.medications.length" size="sm" variant="secondary" @click="copyFrom(lastVisit)">複製處方</UButton>
                </div>
              </div>
            </div>

            <!-- 欄數依區塊實際寬度（auto-fill）：看診區在候診清單旁邊，視窗寬不代表這裡寬（以前 md:grid-cols-8 在 1024 寬只剩 43px 一格） -->
            <div class="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-3">
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
            <!-- S／O：欄數依區塊實際寬度（不用 md: 看視窗） -->
            <section :ref="setSection('so')" class="scroll-mt-12 grid grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] gap-3">
              <UTextarea v-model="draft.subjective" label="S 主訴（病人主觀描述）" :rows="4" :disabled="!editable" />
              <UTextarea v-model="draft.objective" label="O 客觀檢查" :rows="4" :disabled="!editable" />
            </section>

            <!-- A：評估與診斷放在一起 -->
            <section :ref="setSection('dx')" class="scroll-mt-12 space-y-2 border-t border-slate-100 pt-4">
              <UTextarea v-model="draft.assessment" label="A 評估" :rows="2" :disabled="!editable" />
              <h3 class="text-sm font-semibold text-slate-700">診斷</h3>
              <DiagnosisEditor v-model="draft.diagnoses" :readonly="!editable" />
            </section>

            <!-- P：計畫與醫令放在一起 -->
            <section :ref="setSection('orders')" class="scroll-mt-12 space-y-5 border-t border-slate-100 pt-4">
            <UTextarea v-model="draft.plan" label="P 計畫" :rows="2" :disabled="!editable" />
            <OrderSetBar v-if="editable" :draft="draft" @apply="applySet" />
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
            </section>
          </div>

          <HistoryList v-if="tab === 'history'" :items="history ?? []" :drugs="drugs" :readonly="!editable" @copy="copyFrom" />
        </div>
      </UCard>

      <!-- 操作列：固定在畫面底部 -->
      <div v-if="editable" class="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
        <span v-if="dirty" class="text-xs text-amber-600">● 有未儲存的修改</span>
        <span v-else class="text-xs text-slate-400">已儲存</span>
        <div class="ml-auto flex flex-wrap justify-end gap-2">
          <UButton variant="ghost" :icon="SkipForward" :loading="skip.pending.value" @click="onSkip">過號</UButton>
          <UButton variant="secondary" :icon="Save" :disabled="!dirty" :loading="saveDraft.pending.value" @click="saveDraft.run()">暫存</UButton>
          <UButton variant="secondary" :icon="CheckCircle2" :loading="complete.pending.value" @click="onComplete">完成看診</UButton>
          <UButton variant="success" :icon="ChevronsRight" :loading="complete.pending.value || start.pending.value" :title="nextWaiting ? `完成後叫第 ${nextWaiting.seqNo} 號 ${nextWaiting.patientName}（Ctrl+Enter）` : '沒有下一位候診者，只完成看診（Ctrl+Enter）'" @click="onCompleteAndNext">
            完成並叫下一位<span class="ml-1 hidden text-xs opacity-75 sm:inline">Ctrl+Enter</span>
          </UButton>
        </div>
      </div>
    </div>
  </div>
</template>
