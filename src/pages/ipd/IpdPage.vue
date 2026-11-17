<script setup lang="ts">
// 住院醫囑：醫師的住院病人 → 長期／臨時醫囑、病程紀錄、出院病摘。
// 出院由醫師決定：寫好出院病摘並簽署＝准予出院，住院中心才能辦理手續。
// 長期給藥醫囑會連動護理站的給藥排程（由服務層處理），停止醫囑時未執行的排程一併刪除。
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowRightLeft, Droplet, FlaskConical, ScanLine, LogOut, Plus, Square, Pencil, Stethoscope } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UDialog, UEmpty, UQueryState, USelect, UTabs, UTextarea } from '@/components/ui'
import PatientBanner from '@/components/PatientBanner.vue'
import RiskBadges from '@/components/RiskBadges.vue'
import PatientFlagsPanel from '@/components/PatientFlagsPanel.vue'
import LinePanel from '@/components/LinePanel.vue'
import SafetyPanel from '@/components/SafetyPanel.vue'
import NutritionPanel from '@/components/NutritionPanel.vue'
import BloodPanel from '@/components/blood/BloodPanel.vue'
import SurgeryPanel from '@/components/surgery/SurgeryPanel.vue'
import CertificatePanel from '@/components/CertificatePanel.vue'
import MedicationEditor, { type MedRow } from '@/pages/opd/components/MedicationEditor.vue'
import LabReportList from '@/components/LabReportList.vue'
import ImagingReportList from '@/components/ImagingReportList.vue'
import DischargeSummaryView from '@/components/DischargeSummaryView.vue'
import AfterDischargePanel from '@/components/AfterDischargePanel.vue'
import OrderDialog from './components/OrderDialog.vue'
import ReviseOrderDialog from './components/ReviseOrderDialog.vue'
import ReasonDialog from '@/components/ReasonDialog.vue'
import PhraseHint from '@/components/PhraseHint.vue'
import { usePhrases } from '@/composables/usePhrases'
import RequestTransferDialog from './components/RequestTransferDialog.vue'
import AcceptTransferDialog from './components/AcceptTransferDialog.vue'
import RequestConsultDialog from './components/RequestConsultDialog.vue'
import AnswerConsultDialog from './components/AnswerConsultDialog.vue'
import { bloodApi, consultApi, imagingApi, labApi, type ConsultView, type IncomingConsult } from '@/services'
import type { IncomingTransfer } from '@/services/admission'
import { abxApi, admissionApi, DISCHARGE_RX_CHRONIC_DAYS, DISCHARGE_RX_DAYS, doseLevel, doseNote, ipdApi, isAbnormal, masterApi, nursingApi, opdApi, type VitalKey } from '@/services'
import type { OrderView } from '@/services/ipd'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import type { IpdOrderCategory } from '@/types'

const auth = useAuth()
const ui = useUi()

// ---------- 病人清單 ----------
const isAdmin = auth.user?.role === 'admin'
const doctorFilter = ref<string | number | undefined>(isAdmin ? '' : auth.user?.doctorId)
const { data: doctors } = useQuery(async () => (isAdmin ? masterApi.listDoctors() : []))
const { data: admitted, loading } = useQuery(() => admissionApi.listAdmissions({ status: ['admitted'] }))
const myPatients = computed(() =>
  (admitted.value ?? []).filter((a) => !doctorFilter.value || a.doctorId === doctorFilter.value).sort((a, b) => (a.bed?.bedNo ?? '').localeCompare(b.bed?.bedNo ?? '')),
)

// 從急診看板點過來帶 ?admission=…（留觀病人）
const admissionId = ref<string | undefined>(typeof useRoute().query.admission === 'string' ? String(useRoute().query.admission) : undefined)
useRevealOnNarrow(admissionId) // 窄螢幕點選後把明細捲進畫面
const adm = computed(() => admitted.value?.find((a) => a.id === admissionId.value))
// 病人出院後從清單消失，取消選取
watch(adm, (a) => {
  if (!a && admissionId.value && admitted.value) admissionId.value = undefined
})

// ---------- 轉科 ----------
// 轉入：新科醫師在清單上方看到「轉入申請」，接受後病人出現在自己的清單
const { data: incoming } = useQuery(async () => (isAdmin ? [] : admissionApi.listIncomingTransfers()))
const accepting = ref<IncomingTransfer>()
const acceptOpen = computed({ get: () => !!accepting.value, set: (v) => !v && (accepting.value = undefined) })
// 轉出：原科醫師申請、撤回；申請中、被婉拒都在病人資訊列顯示
const requestOpen = ref(false)
const transfer = computed(() => adm.value?.lastTransfer)
const cancelTransfer = useAction(admissionApi.cancelDeptTransfer, { success: '已撤回轉科申請' })
async function onCancelTransfer() {
  const a = adm.value
  if (a && (await ui.confirm({ title: '撤回轉科申請', message: `撤回「轉${a.lastTransfer?.toDeptName}」的申請？病人繼續由您負責。`, okText: '撤回' }))) cancelTransfer.run(a.id)
}

// ---------- 會診 ----------
// 待我回覆（我這科）：清單上方，急會診在前；這位病人的會診單：看回覆、會診建議轉科就一鍵帶入轉科申請
const { data: incomingConsults } = useQuery(async () => (isAdmin ? [] : consultApi.listIncomingConsults()))
const answering = ref<IncomingConsult | null>(null)
// 開了醫囑、停了醫囑，清單會重新查詢：對話框用最新那一份（摘要裡的醫囑跟著更新）
const answeringLive = computed(() => (answering.value ? incomingConsults.value?.find((x) => x.consult.id === answering.value!.consult.id) ?? answering.value : null))
const pendingConsults = computed(() => (incomingConsults.value ?? []).filter((x) => x.consult.status === 'pending').length)
const consultOpen = ref(false)
const { data: consults } = useQuery(async () => (admissionId.value && !isAdmin ? consultApi.listConsults(admissionId.value) : []), [admissionId])
const transferFromConsult = ref<ConsultView>()
function openTransfer(c?: ConsultView) {
  transferFromConsult.value = c
  requestOpen.value = true
}
const cancelConsult = useAction(consultApi.cancelConsult, { success: '已撤回會診' })
const cancelling = ref<ConsultView | null>(null)
const cancelConsultOpen = computed({ get: () => !!cancelling.value, set: (v) => !v && (cancelling.value = null) })
async function confirmCancelConsult(reason: string) {
  if (cancelling.value && (await cancelConsult.run(cancelling.value.id, reason))) cancelling.value = null
}
const noteKind = { transferOut: '轉出摘要', transferIn: '接收評估', consult: '會診申請', consultReply: '會診回覆' } as const

// ---------- 醫囑 ----------
const { data: orders, loading: ordersLoading } = useQuery(async () => (admissionId.value ? ipdApi.listOrders(admissionId.value) : []), [admissionId])
const consultUnseen = computed(() => (orders.value ?? []).filter((o) => o.consultUnseen))
// 管制性抗生素：不核准（停藥、改藥或申覆）、核准天數快到（申請續用）——上方紅條／黃條
const abxRejected = computed(() => (orders.value ?? []).filter((o) => o.abx?.status === 'rejected' && o.abxInfo))
const abxExtend = computed(() => (orders.value ?? []).filter((o) => o.abxInfo?.extend))
const abxResubmit = ref<{ order: OrderView; kind: 'appeal' | 'extend' }>()
const abxResubmitOpen = computed({ get: () => !!abxResubmit.value, set: (v) => !v && (abxResubmit.value = undefined) })
const appeal = useAction(abxApi.appealAbx, { success: (o) => `已申覆：${o.content}（回到待感染科審核）` })
const extendAbx = useAction(abxApi.requestAbxExtension, { success: (o) => `已申請續用：${o.content}（待感染科審核）` })
async function confirmAbx(note: string) {
  const x = abxResubmit.value
  if (x && (await (x.kind === 'appeal' ? appeal : extendAbx).run(x.order.id, note))) abxResubmit.value = undefined
}
const lastReject = (o: OrderView) => o.abxInfo?.steps.filter((s) => s.action === 'reject').at(-1)
const ackConsult = useAction(ipdApi.ackConsultOrders, { success: (r) => `已閱 ${r.count} 筆會診醫囑` })
const longOrders = computed(() => (orders.value ?? []).filter((o) => o.type === 'long'))
const statOrders = computed(() => (orders.value ?? []).filter((o) => o.type === 'stat'))

const categoryLabel: Record<IpdOrderCategory, { label: string; tone: 'blue' | 'cyan' | 'yellow' | 'green' }> = {
  medication: { label: '給藥', tone: 'blue' },
  procedure: { label: '檢驗處置', tone: 'cyan' },
  diet: { label: '飲食', tone: 'yellow' },
  nursing: { label: '護理', tone: 'green' },
}
const statusLabel = { active: '執行中', stopped: '已停止', done: '已完成' } as const

const orderOpen = ref(false)
const stop = useAction(ipdApi.stopOrder, { success: (o) => `已停止：${o.content}` })
async function onStop(o: OrderView) {
  const extra = o.category === 'medication' && o.type === 'long' ? '\n尚未執行的給藥排程會一併刪除。' : ''
  // 同一種藥可能有兩筆醫囑：帶上劑量、頻率、途徑與開立時間，才分得出要停的是哪一筆
  const detail = o.category === 'medication' ? `\n每次 ${o.dose} ${o.unit}・${o.freq}・${o.route}` : ''
  const message = `確定停止「${o.content}」？${detail}\n（${o.startAt.slice(5)} 開立，${o.doctorName}）${extra}`
  const q = o.pendingQuery ? `\n\n護理師的疑問「${o.pendingQuery.reason}」會一併結案（記為「已停止此醫囑」）；只改劑量、頻率的話請用「修改」。` : ''
  if (await ui.confirm({ title: '停止醫囑', message: message + q, okText: '停止', danger: true })) stop.run(o.id)
}

// ---------- 修改（長期給藥）：服務層停止舊的、開新的，從下一劑開始 ----------
const revising = ref<OrderView | null>(null)
const canRevise = (o: OrderView) => o.status === 'active' && o.category === 'medication' && o.type === 'long'

// ---------- 回覆護理師疑問：確認原醫囑無誤（寫說明）、或直接修改；要換藥就「停止」再另開 ----------
const replying = ref<OrderView | null>(null)
const replyOpen = computed({ get: () => !!replying.value, set: (v) => !v && (replying.value = null) })
const reply = useAction(ipdApi.replyOrderQuery, { success: (o) => `已回覆：${o.content}（護理師核對後恢復執行）` })
async function confirmReply(text: string) {
  if (replying.value && (await reply.run(replying.value.id, text))) replying.value = null
}

// ---------- 最新生命徵象（護理站記錄，醫師參考） ----------
const { data: vitals } = useQuery(async () => (admissionId.value ? nursingApi.listVitals(admissionId.value) : []), [admissionId])
const latestVital = computed(() => vitals.value?.[vitals.value.length - 1])
// 醫師巡房要看的欄位（血壓收縮／舒張合成一欄）；異常判斷一律用 isAbnormal
const vitalFields: { label: string; keys: VitalKey[] }[] = [
  { label: 'T', keys: ['temp'] },
  { label: 'P', keys: ['pulse'] },
  { label: 'R', keys: ['resp'] },
  { label: 'BP', keys: ['sbp', 'dbp'] },
  { label: 'SpO2', keys: ['spo2'] },
  { label: '疼痛', keys: ['pain'] },
]

// ---------- 分頁 ----------
const tab = ref('orders')
const ds = computed(() => adm.value?.dischargeSummary)
const tabs = computed(() => [
  { key: 'orders', label: '醫囑', count: orders.value?.filter((o) => o.status === 'active').length },
  { key: 'notes', label: '病程紀錄', count: notes.value?.length },
  { key: 'labs', label: '檢驗', count: labs.value?.reports.length },
  { key: 'imaging', label: '影像', count: imgs.value ? imgs.value.reports.length + imgs.value.pending.length : undefined },
  { key: 'blood', label: '輸血', count: blood.value && blood.value.admissionId === admissionId.value ? blood.value.requests.filter((r) => !['done', 'cancelled'].includes(r.status)).length || undefined : undefined },
  { key: 'surgery', label: '手術' },
  { key: 'flags', label: '隔離與 DNR' },
  { key: 'lines', label: '管路' },
  { key: 'safety', label: '譫妄與約束' },
  { key: 'nutrition', label: '營養' },
  { key: 'discharge', label: ds.value?.signedAt ? '出院病摘・已准出院' : ds.value ? '出院病摘・草稿' : '出院病摘' },
])

// 檢驗報告：分頁數量、上方「待確認」紅條（危急值或更正過）
const { data: labs } = useQuery(async () => (adm.value ? labApi.patientLabs(adm.value.patientId) : undefined), [() => adm.value?.patientId])
const labAlerts = computed(() => (labs.value?.reports ?? []).filter((r) => r.needsAck))
const { data: blood } = useQuery(async () => (admissionId.value ? bloodApi.patientBlood(admissionId.value) : undefined), [admissionId])
const bloodReactions = computed(() => (blood.value && blood.value.admissionId === admissionId.value ? blood.value.reactionsUnacked : 0))
const { data: imgs } = useQuery(async () => (adm.value ? imagingApi.patientImaging(adm.value.patientId) : undefined), [() => adm.value?.patientId])
const imgAlerts = computed(() => (imgs.value?.reports ?? []).filter((r) => r.needsAck))

// ---------- 出院病摘 ----------
// 已簽署（准予出院）就唯讀；要改先「取消准予出院」，內容會留成草稿
const dischargeTypes = masterApi.staticCodes.dischargeTypes
const dsForm = reactive({ diagnosis: '', course: '', condition: '', followUp: '', dischargeType: '' as string | number })
// 出院帶藥：和門診開藥同一個編輯元件（劑量、頻率、天數、總量自動換算）；天數上限、劑量檢查在服務層
const dsMeds = ref<MedRow[]>([])
const dsChronic = ref(false)
const { data: drugList } = useQuery(() => masterApi.listDrugs({ includeInactive: true }))
const { data: freqList } = useQuery(() => masterApi.listFrequencies())
const drugMap = computed(() => new Map((drugList.value ?? []).map((d) => [d.id, d])))
const freqs = computed(() => freqList.value ?? [])
const medKey = computed(() => dsMeds.value.map((m) => m.drugId).join(','))
const { data: medWarnings } = useQuery(async () => (adm.value && medKey.value ? opdApi.allergyWarnings(adm.value.patientId, medKey.value.split(',')) : []), [medKey, () => adm.value?.patientId])
// 換病人、或病摘存檔／簽署／取消後，表單換成資料庫裡的內容。用字串當 key：adm 每次重新查詢都是新物件，直接看物件會一直重設、把正在打的字洗掉
watch(
  () => `${adm.value?.id}|${ds.value?.writtenAt}|${ds.value?.signedAt}`,
  () => {
    const d = ds.value
    Object.assign(dsForm, d
      ? { diagnosis: d.diagnosis, course: d.course, condition: d.condition, followUp: d.followUp, dischargeType: d.dischargeType }
      : { diagnosis: adm.value?.diagnosis ?? '', course: '', condition: '', followUp: '', dischargeType: '' })
    dsMeds.value = (d?.meds ?? []).map((m) => ({ ...m }))
    dsChronic.value = !!d?.chronicRx
  },
  { immediate: true },
)
const saveDs = useAction(ipdApi.saveDischargeSummary, { success: (d) => (d.signedAt ? '已簽署出院病摘，准予出院；住院中心可辦理手續' : '已儲存病摘草稿') })
async function onSaveDs(sign: boolean) {
  if (!adm.value) return
  // 劑量偏高：簽署時列出來請醫師確認一次（和門診同一條規則 doseLevel；服務層會再檢查）
  const high = dsMeds.value.map((m) => ({ m, d: drugMap.value.get(m.drugId) })).filter((x) => x.d && doseLevel(x.d, x.m.dose) === 'high')
  if (sign && high.length && !(await ui.confirm({ title: '出院帶藥劑量偏高', message: `${high.map((x) => `・${x.d!.name}：${doseNote(x.d!, x.m.dose)}`).join('\n')}\n\n確定劑量無誤？`, okText: '劑量無誤', danger: true }))) return
  const meds = dsMeds.value.map(({ _manual: _m, _qtyStale: _q, ...m }) => m)
  saveDs.run(adm.value.id, { ...dsForm, dischargeType: String(dsForm.dischargeType), meds, chronicRx: dsChronic.value, ...(high.length ? { confirmHighDose: true } : {}) }, sign)
}
const cancelOpen = ref(false)
const cancelReason = ref('')
const cancelDs = useAction(ipdApi.cancelDischargeOrder, { success: '已取消准予出院，病摘改回草稿' })
async function onCancelDs() {
  if (adm.value && (await cancelDs.run(adm.value.id, cancelReason.value))) cancelOpen.value = false
}
function openCancel() {
  cancelReason.value = ''
  cancelOpen.value = true
}

// ---------- 片語：病程紀錄、出院病摘輸入「.簡碼」再按空白鍵展開（和門診同一份個人片語） ----------
const phrase = usePhrases()

// ---------- 病程紀錄 ----------
const { data: notes } = useQuery(async () => (admissionId.value ? ipdApi.listProgressNotes(admissionId.value) : []), [admissionId])
const note = reactive({ subjective: '', objective: '', assessment: '', plan: '' })
const addNote = useAction(ipdApi.addProgressNote, { success: '已新增病程紀錄' })
async function submitNote() {
  if (!admissionId.value) return
  if (await addNote.run({ admissionId: admissionId.value, ...note })) Object.assign(note, { subjective: '', objective: '', assessment: '', plan: '' })
}
</script>

<template>
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-[18rem_1fr]">
    <!-- 病人清單 -->
    <UCard :padded="false" class="self-start">
      <template #title>
        <div class="text-sm font-semibold text-slate-800">{{ isAdmin ? '住院病人' : '我的住院病人' }}</div>
        <div class="text-xs text-slate-500">共 {{ myPatients.length }} 位</div>
      </template>
      <div v-if="isAdmin" class="border-b border-slate-100 p-3">
        <USelect v-model="doctorFilter" :options="[{ label: '全部醫師', value: '' }, ...(doctors ?? []).map((d) => ({ label: d.name, value: d.id }))]" />
      </div>
      <div v-if="incomingConsults?.length" class="border-b border-rose-200 bg-rose-50 p-2">
        <div class="px-1 pb-1 text-xs font-semibold text-rose-900">會診（待回覆 {{ pendingConsults }}<template v-if="incomingConsults.length > pendingConsults">・追蹤中 {{ incomingConsults.length - pendingConsults }}</template>）</div>
        <button v-for="it in incomingConsults" :key="it.consult.id" class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-rose-100" @click="answering = it">
          <div class="flex items-center gap-2">
            <span class="tabular rounded bg-white px-1.5 text-xs font-medium text-slate-700">{{ it.summary.admission.bed?.bedNo }}</span>
            <span class="font-medium text-slate-800">{{ it.summary.admission.patientName }}</span>
            <UBadge v-if="it.consult.urgent" tone="red">急</UBadge>
            <span v-if="it.consult.status === 'answered'" class="ml-auto text-xs text-emerald-700">已回覆・可開醫囑</span>
            <span v-else class="ml-auto text-xs text-rose-800">{{ it.consult.fromDeptName }}・{{ it.consult.waitingHours }} 小時</span>
          </div>
          <div class="truncate text-xs text-slate-600">{{ it.consult.question }}</div>
        </button>
      </div>
      <div v-if="incoming?.length" class="border-b border-amber-200 bg-amber-50 p-2">
        <div class="px-1 pb-1 text-xs font-semibold text-amber-900">轉入申請（{{ incoming.length }}）</div>
        <button v-for="it in incoming" :key="it.admission.id" class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-amber-100" @click="accepting = it">
          <div class="flex items-center gap-2">
            <span class="tabular rounded bg-white px-1.5 text-xs font-medium text-slate-700">{{ it.admission.bed?.bedNo }}</span>
            <span class="font-medium text-slate-800">{{ it.admission.patientName }}</span>
            <span class="ml-auto text-xs text-amber-800">{{ it.transfer.fromDeptName }} → 本科</span>
          </div>
          <div class="truncate text-xs text-slate-600">{{ it.transfer.reason }}</div>
        </button>
      </div>
      <UQueryState :loading="loading" :ready="myPatients.length > 0" empty-title="目前沒有住院病人">
        <ul class="max-h-[calc(100vh-12rem)] divide-y divide-slate-100 overflow-y-auto">
          <li v-for="a in myPatients" :key="a.id">
            <button :class="['w-full px-3 py-2.5 text-left hover:bg-slate-50', a.id === admissionId && '!bg-brand-50']" @click="admissionId = a.id">
              <div class="flex items-center gap-2">
                <span class="tabular rounded bg-slate-100 px-1.5 text-xs font-medium text-slate-700">{{ a.bed?.bedNo }}</span>
                <span class="font-medium text-slate-800">{{ a.patientName }}</span>
                <UBadge v-if="a.lastTransfer?.status === 'pending'" tone="blue" :title="`已申請轉${a.lastTransfer.toDeptName}`">轉科中</UBadge>
                <span class="ml-auto" />
                <UBadge v-if="a.consultOrdersUnseen" tone="purple" :title="`會診醫師新開了 ${a.consultOrdersUnseen} 筆醫囑，待已閱`">會診醫囑 {{ a.consultOrdersUnseen }}</UBadge>
                <UBadge v-if="a.openQueries" tone="yellow" :title="`護理師有 ${a.openQueries} 筆醫囑疑問待回覆`">疑問 {{ a.openQueries }}</UBadge>
                <UBadge v-if="a.dischargeReady" tone="green">准出院</UBadge>
                <span class="text-xs text-slate-500">第 {{ a.days }} 天</span>
              </div>
              <div class="mt-0.5 truncate text-xs text-slate-500">{{ a.diagnosis }}<template v-if="isAdmin">・{{ a.doctorName }}</template></div>
            </button>
          </li>
        </ul>
      </UQueryState>
    </UCard>

    <UCard v-if="!adm" data-detail><UEmpty title="請從清單選擇病人" description="檢視與開立住院醫囑、病程紀錄" /></UCard>
    <div v-else data-detail class="min-w-0 space-y-3">
      <PatientBanner :patient="adm">
        <UBadge tone="blue">{{ adm.bed?.bedNo }}</UBadge>
        <span class="tabular text-sm text-slate-600">住院號 {{ adm.admitNo }}・第 {{ adm.days }} 天・{{ adm.deptName }}</span>
        <!-- 護理師評的跌倒、壓傷風險（醫師只看） -->
        <RiskBadges :levels="adm.riskLevels" />
        <UButton v-if="!isAdmin" size="sm" variant="secondary" class="ml-auto" :icon="Stethoscope" @click="consultOpen = true">會診</UButton>
        <UButton v-if="!isAdmin && transfer?.status !== 'pending' && !adm.dischargeReady" size="sm" variant="secondary" :icon="ArrowRightLeft" @click="openTransfer()">申請轉科</UButton>
      </PatientBanner>
      <div v-if="labAlerts.length" class="flex flex-wrap items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800" role="alert">
        <FlaskConical class="h-4 w-4 shrink-0" />
        <span class="min-w-0 flex-1"><b>檢驗{{ labAlerts.some((r) => r.hasCritical) ? '危急值' : '報告更正' }}待確認：</b>{{ labAlerts.map((r) => `${r.procName}（${r.values.filter((v) => v.critical || v.flag).map((v) => `${v.name} ${v.value}`).join('、') || '已更正'}）`).join('；') }}</span>
        <UButton size="sm" variant="danger" @click="tab = 'labs'">查看</UButton>
      </div>
      <div v-if="bloodReactions" class="flex flex-wrap items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800" role="alert">
        <Droplet class="h-4 w-4 shrink-0" />
        <span class="min-w-0 flex-1"><b>輸血反應待確認：</b>{{ bloodReactions }} 筆，已停止輸血，請寫處置</span>
        <UButton size="sm" variant="danger" @click="tab = 'blood'">查看</UButton>
      </div>
      <div v-if="imgAlerts.length" class="flex flex-wrap items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800" role="alert">
        <ScanLine class="h-4 w-4 shrink-0" />
        <span class="min-w-0 flex-1"><b>影像{{ imgAlerts.some((r) => r.significant) ? '重要發現' : '補充報告' }}待確認：</b>{{ imgAlerts.map((r) => `${r.procName}：${r.impression}`).join('；') }}</span>
        <UButton size="sm" variant="danger" @click="tab = 'imaging'">查看</UButton>
      </div>
      <div v-if="transfer?.status === 'pending'" class="flex flex-wrap items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-4 py-2 text-sm text-sky-900" role="status">
        <ArrowRightLeft class="h-4 w-4" />
        <span class="min-w-0 flex-1">已申請轉 <b>{{ transfer.toDeptName }}</b><template v-if="transfer.toDoctorName">（指定 {{ transfer.toDoctorName }}）</template>・{{ transfer.requestedAt.slice(5) }}・{{ transfer.reason }}。等新科醫師接受；期間仍由您負責。</span>
        <UButton v-if="!isAdmin" size="sm" variant="secondary" :loading="cancelTransfer.pending.value" @click="onCancelTransfer">撤回申請</UButton>
      </div>
      <div v-else-if="transfer?.status === 'declined'" class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900" role="status">
        轉 {{ transfer.toDeptName }} 的申請被婉拒（{{ transfer.decidedByName }} {{ transfer.decidedAt?.slice(5) }}）：{{ transfer.decisionNote }}
      </div>
      <!-- 這位病人的會診單：待回覆的可撤回；已回覆的看建議，建議轉科就一鍵帶入轉科申請 -->
      <div v-if="consults?.some((c) => c.status !== 'cancelled')" class="space-y-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm">
        <div class="text-xs font-semibold text-slate-600">會診</div>
        <div v-for="c in consults.filter((x) => x.status !== 'cancelled')" :key="c.id" class="flex flex-wrap items-start gap-2">
          <UBadge :tone="c.status === 'answered' ? 'green' : c.urgent ? 'red' : 'yellow'">{{ c.status === 'answered' ? '已回覆' : c.urgent ? '急・待回覆' : '待回覆' }}</UBadge>
          <div class="min-w-0 flex-1">
            <div class="text-slate-800">{{ c.toDeptName }}<template v-if="c.toDoctorName">（{{ c.toDoctorName }}）</template>：{{ c.question }} <span class="text-xs text-slate-400">{{ c.requestedAt.slice(5) }}</span></div>
            <div v-if="c.status === 'answered'" class="text-xs text-slate-700">
              {{ c.answeredByName }} {{ c.answeredAt?.slice(5) }}：{{ c.findings }}／<b>建議</b> {{ c.recommendation }}
              <UBadge v-if="c.suggestTransfer" tone="blue" class="ml-1">建議轉{{ c.toDeptName }}</UBadge>
            </div>
          </div>
          <UButton v-if="c.status === 'answered' && c.suggestTransfer && transfer?.status !== 'pending' && adm.deptId !== c.toDeptId" size="sm" :icon="ArrowRightLeft" @click="openTransfer(c)">依會診申請轉科</UButton>
          <UButton v-if="c.status === 'pending'" size="sm" variant="ghost" @click="cancelling = c">撤回</UButton>
        </div>
      </div>
      <div class="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm">
        <span class="text-slate-500">入院診斷</span><span class="text-slate-800">{{ adm.diagnosis }}</span>
        <template v-if="latestVital">
          <span class="text-slate-500">最新生命徵象（{{ latestVital.at.slice(5) }}）</span>
          <!-- 異常與否用護理站同一條規則 isAbnormal（以前這裡寫死體溫 ≥38、SpO2 <94，37.8°C 護理站標紅、醫師頁不標） -->
          <span class="tabular text-slate-800">
            <template v-for="(f, i) in vitalFields" :key="f.label">
              <template v-if="i">・</template>{{ f.label }}
              <template v-for="(k, j) in f.keys" :key="k"><template v-if="j">/</template><b :class="isAbnormal(k, latestVital[k]) ? 'text-red-600' : 'font-normal'">{{ latestVital[k] ?? '—' }}</b></template>
            </template>
          </span>
        </template>
      </div>

      <UCard :padded="false">
        <div class="flex items-center px-4 pt-1">
          <UTabs v-model="tab" :tabs="tabs" />
          <UButton v-if="tab === 'orders'" class="ml-auto" size="sm" :icon="Plus" @click="orderOpen = true">新增醫囑</UButton>
        </div>

        <!-- 會診醫師開了醫囑：本科醫師看過按「已閱」才消失（首頁待辦也有） -->
        <div v-for="o in abxRejected" :key="`abxr-${o.id}`" class="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900" role="alert">
          <span class="min-w-0 flex-1"><b>抗生素審核未通過：</b>{{ o.content }}（{{ o.abxInfo!.text.split('・')[0] }}）—{{ lastReject(o)?.byName }}：{{ lastReject(o)?.text }}。請停藥、改藥，或寫說明申覆。</span>
          <UButton v-if="!isAdmin" size="sm" variant="secondary" @click="abxResubmit = { order: o, kind: 'appeal' }">申覆</UButton>
          <UButton v-if="!isAdmin" size="sm" variant="danger" @click="onStop(o)">停止</UButton>
        </div>
        <div v-for="o in abxExtend" :key="`abxe-${o.id}`" class="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          <span class="min-w-0 flex-1"><b>抗生素核准天數{{ o.abxInfo!.extend === 'over' ? '已超過' : '快到了' }}：</b>{{ o.content }}，{{ o.abxInfo!.text }}。要續用請申請；不用了請停止。</span>
          <UButton v-if="!isAdmin" size="sm" variant="secondary" @click="abxResubmit = { order: o, kind: 'extend' }">申請續用</UButton>
        </div>
        <div v-if="consultUnseen.length" class="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-purple-300 bg-purple-50 px-3 py-2 text-sm text-purple-900">
          <span class="min-w-0 flex-1">會診醫師新開了 <b>{{ consultUnseen.length }}</b> 筆醫囑：{{ consultUnseen.map((o) => `${o.content}（${o.consultLabel?.replace('會診：', '')}）`).join('、') }}</span>
          <UButton size="sm" variant="secondary" :loading="ackConsult.pending.value" @click="adm && ackConsult.run(adm.id)">已閱</UButton>
        </div>
        <!-- 醫囑 -->
        <div v-if="tab === 'orders'" class="space-y-5 p-4">
          <UQueryState :loading="ordersLoading" :ready="!!orders">
            <section v-for="sec in [{ title: '長期醫囑', list: longOrders }, { title: '臨時醫囑', list: statOrders }]" :key="sec.title" class="mb-5 last:mb-0">
              <h3 class="mb-2 text-sm font-semibold text-slate-700">{{ sec.title }}</h3>
              <p v-if="!sec.list.length" class="text-sm text-slate-400">沒有{{ sec.title }}</p>
              <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
                <li v-for="o in sec.list" :key="o.id" :class="['flex flex-wrap items-center gap-3 px-3 py-2 text-sm', o.status !== 'active' && 'bg-slate-50 text-slate-400', o.pendingQuery && 'border-l-4 border-l-amber-500 bg-amber-50/50']">
                  <UBadge :tone="o.status === 'active' ? categoryLabel[o.category].tone : 'gray'">{{ categoryLabel[o.category].label }}</UBadge>
                  <div class="min-w-[14rem] flex-1">
                    <div :class="['break-keep break-words font-medium', o.status === 'active' && 'text-slate-800', o.status === 'stopped' && 'line-through']">
                      {{ o.content }}
                      <UBadge v-if="o.highAlert && o.status === 'active'" tone="purple" class="ml-1">高警訊</UBadge>
                      <UBadge v-if="o.consultLabel" :tone="o.consultUnseen ? 'purple' : 'gray'" class="ml-1">{{ o.consultLabel }}</UBadge>
                    </div>
                    <div v-if="o.abxInfo" :class="['text-xs', o.abx?.status === 'rejected' || o.abxInfo.overdue ? 'font-semibold text-red-700' : o.abx?.status === 'pending' ? 'text-amber-800' : 'text-emerald-700']" :title="o.abxInfo.reasonText">管制性抗生素・{{ o.abxInfo.text }}</div>
                    <div v-if="o.category === 'medication'" class="tabular text-xs">每次 {{ o.dose }} {{ o.unit }}<template v-if="o.doseStrength">（{{ o.doseStrength }}）</template>・{{ o.freq }}（{{ o.freqLabel }}）・{{ o.route }}<template v-if="o.timingShort">・{{ o.timingShort }}</template><span v-if="o.timingSet" class="ml-1 rounded bg-sky-100 px-1 text-sky-800">醫師指定</span></div>
                    <div v-if="o.replacesText" class="text-xs text-sky-700" :title="o.reviseReason">修改自：{{ o.replacesText }}（{{ o.reviseReason }}）</div>
                    <div v-if="o.replacedByText" class="text-xs no-underline">已修改為：{{ o.replacedByText }}</div>
                  </div>
                  <div class="tabular text-right text-xs">
                    <div>{{ o.startAt.slice(5) }} 開立</div>
                    <div v-if="o.stopAt">{{ o.stopAt.slice(5) }} 停止</div>
                  </div>
                  <span class="w-12 text-xs">{{ statusLabel[o.status] }}</span>
                  <UButton v-if="canRevise(o)" size="sm" variant="ghost" :icon="Pencil" @click="revising = o">修改</UButton>
                  <UButton v-if="o.status === 'active'" size="sm" variant="ghost" :icon="Square" @click="onStop(o)">停止</UButton>
                  <span v-else class="w-[4.25rem]" />
                  <!-- 護理師的疑問：回覆前這筆暫停執行。確認無誤就回覆；要改就停止再另開 -->
                  <div v-if="o.pendingQuery" class="flex w-full items-center gap-2 text-xs text-amber-900">
                    <span class="min-w-0 flex-1">護理師疑問（{{ o.pendingQuery.byName }} {{ o.pendingQuery.at.slice(5) }}）：{{ o.pendingQuery.reason }}・回覆前暫停執行</span>
                    <UButton size="sm" @click="replying = o">回覆：確認無誤</UButton>
                    <UButton v-if="canRevise(o)" size="sm" variant="secondary" @click="revising = o">修改醫囑</UButton>
                  </div>
                </li>
              </ul>
            </section>
          </UQueryState>
        </div>

        <!-- 出院病摘：醫師撰寫；簽署＝准予出院 -->
        <div v-else-if="tab === 'labs'" class="p-4"><LabReportList :patient-id="adm.patientId" /></div>
        <div v-else-if="tab === 'imaging'" class="p-4"><ImagingReportList :patient-id="adm.patientId" /></div>
        <BloodPanel v-else-if="tab === 'blood'" :admission-id="adm.id" />
        <SurgeryPanel v-else-if="tab === 'surgery'" :admission-id="adm.id" />
        <PatientFlagsPanel v-else-if="tab === 'flags'" :patient-id="adm.patientId" />
        <LinePanel v-else-if="tab === 'lines'" :admission-id="adm.id" />
        <SafetyPanel v-else-if="tab === 'safety'" :admission-id="adm.id" />
        <NutritionPanel v-else-if="tab === 'nutrition'" :admission-id="adm.id" />
        <div v-else-if="tab === 'discharge'" class="space-y-3 p-4">
          <!-- 診斷證明書（住院期間自動帶入）：費用進住院帳單，出院結帳後才能印 -->
          <div class="rounded-md border border-slate-200 px-3 py-2"><CertificatePanel :admission-id="adm.id" /></div>
          <!-- 出院後回診：寫病摘時直接掛進門診（簽准出院前後都可以，出院後就由門診或櫃台處理）；會診醫師按了服務層會擋 -->
          <AfterDischargePanel :admission-id="adm.id" :editable="!isAdmin && adm.status === 'admitted'" />
          <template v-if="ds?.signedAt">
            <div class="flex flex-wrap items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              <LogOut class="h-4 w-4" />已准予出院，等住院中心辦理手續。
              <UButton class="ml-auto" size="sm" variant="secondary" @click="openCancel">取消准予出院</UButton>
            </div>
            <DischargeSummaryView :summary="ds" :doctor-name="adm.summaryDoctorName" :med-texts="adm.dischargeMedTexts" :rx-status="adm.dischargeRxStatus" />
          </template>
          <template v-else>
            <p class="text-xs text-slate-500">
              寫好並「簽署並准予出院」後，住院中心才能辦理出院（轉歸以這裡為準）。可先存草稿。
              <template v-if="ds">上次儲存：{{ ds.writtenAt }}・{{ adm.summaryDoctorName }}</template>
            </p>
            <div class="grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-3">
              <UTextarea v-model="dsForm.diagnosis" label="出院診斷" :rows="2" :error="saveDs.fieldErrors.value.diagnosis" @keydown="phrase.onKey($event, (v) => (dsForm.diagnosis = v))" />
              <USelect v-model="dsForm.dischargeType" label="出院轉歸" placeholder="請選擇" :options="dischargeTypes" :error="saveDs.fieldErrors.value.dischargeType" />
            </div>
            <UTextarea v-model="dsForm.course" label="住院經過" :rows="3" placeholder="治療經過、重要檢查結果" :error="saveDs.fieldErrors.value.course" @keydown="phrase.onKey($event, (v) => (dsForm.course = v))" />
            <UTextarea v-model="dsForm.condition" label="出院時狀況" :rows="2" :error="saveDs.fieldErrors.value.condition" @keydown="phrase.onKey($event, (v) => (dsForm.condition = v))" />
            <UTextarea v-model="dsForm.followUp" label="出院後追蹤" :rows="2" placeholder="回診時間、居家注意事項、何時應立即回診" :error="saveDs.fieldErrors.value.followUp" @keydown="phrase.onKey($event, (v) => (dsForm.followUp = v))" />
            <!-- 出院帶藥：簽署時一起確認；住院藥局調劑扣帳後列入住院帳單 -->
            <section class="space-y-2 rounded-md border border-slate-200 p-3">
              <div class="flex flex-wrap items-center gap-3">
                <h4 class="text-sm font-semibold text-slate-700">出院帶藥</h4>
                <span class="text-xs text-slate-500">一般最多 {{ DISCHARGE_RX_DAYS }} 天；慢性病最多 {{ DISCHARGE_RX_CHRONIC_DAYS }} 天。沒有就不用填</span>
                <label class="ml-auto flex items-center gap-1.5 text-sm"><input v-model="dsChronic" type="checkbox" class="h-4 w-4 rounded border-slate-300 text-brand-600" />慢性病</label>
              </div>
              <MedicationEditor v-model="dsMeds" :drugs="drugMap" :freqs="freqs" :warnings="medWarnings ?? []" :default-days="DISCHARGE_RX_DAYS" no-self-pay />
              <p v-if="saveDs.fieldErrors.value.meds" class="text-xs text-red-600">{{ saveDs.fieldErrors.value.meds }}</p>
            </section>
            <PhraseHint :phrase="phrase" />
            <div class="flex justify-end gap-2">
              <UButton variant="secondary" :loading="saveDs.pending.value" @click="onSaveDs(false)">儲存草稿</UButton>
              <UButton :icon="LogOut" :loading="saveDs.pending.value" @click="onSaveDs(true)">簽署並准予出院</UButton>
            </div>
          </template>
        </div>

        <!-- 病程紀錄 -->
        <div v-else class="space-y-4 p-4">
          <div class="rounded-md border border-slate-200 bg-slate-50 p-3">
            <div class="mb-2 text-sm font-semibold text-slate-700">新增今日病程（SOAP）</div>
            <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
              <UTextarea v-model="note.subjective" label="S 主觀" :rows="2" @keydown="phrase.onKey($event, (v) => (note.subjective = v))" />
              <UTextarea v-model="note.objective" label="O 客觀" :rows="2" @keydown="phrase.onKey($event, (v) => (note.objective = v))" />
              <UTextarea v-model="note.assessment" label="A 評估" :rows="2" @keydown="phrase.onKey($event, (v) => (note.assessment = v))" />
              <UTextarea v-model="note.plan" label="P 計畫" :rows="2" @keydown="phrase.onKey($event, (v) => (note.plan = v))" />
            </div>
            <PhraseHint class="mt-1" :phrase="phrase" />
            <div class="mt-2 text-right"><UButton size="sm" :loading="addNote.pending.value" @click="submitNote">儲存病程紀錄</UButton></div>
          </div>
          <article v-for="n in notes" :key="n.id" class="rounded-md border border-slate-200 p-3 text-sm">
            <header class="mb-1.5 flex justify-between text-xs text-slate-500"><span class="tabular font-medium text-slate-700">{{ n.at }}<UBadge v-if="n.kind" tone="blue" class="ml-2">{{ noteKind[n.kind] }}</UBadge></span><span>{{ n.doctorName }}</span></header>
            <!-- 轉科、會診的紀錄：系統依動作寫入，逐項列出 -->
            <dl v-if="n.kind" class="grid gap-1">
              <div v-for="it in n.items ?? []" :key="it.label" class="flex gap-2">
                <dt class="w-16 shrink-0 text-xs font-semibold text-brand-700">{{ it.label }}</dt><dd class="text-slate-700">{{ it.text }}</dd>
              </div>
            </dl>
            <dl v-else class="grid gap-1">
              <div v-for="[k, v] in [['S', n.subjective], ['O', n.objective], ['A', n.assessment], ['P', n.plan]]" :key="k" class="flex gap-2">
                <dt class="w-4 font-bold text-brand-700">{{ k }}</dt><dd class="text-slate-700">{{ v || '—' }}</dd>
              </div>
            </dl>
          </article>
        </div>
      </UCard>
    </div>

    <ReasonDialog
      v-model="replyOpen"
      title="回覆護理師疑問：確認醫囑無誤"
      :subject="replying ? `${replying.content}${replying.dose ? `・每次 ${replying.dose} ${replying.unit}` : ''}・疑問：${replying.pendingQuery?.reason}` : ''"
      label="說明（護理師會看到；要改醫囑請按「停止」再另開）"
      :presets="['劑量無誤，依體重計算', '依病情需要，已向病人說明', '已確認過敏史，無交叉過敏']"
      ok-text="回覆"
      :pending="reply.pending.value"
      :error="reply.fieldErrors.value.reply"
      @confirm="confirmReply"
    />
    <OrderDialog v-model="orderOpen" :admission="adm" />
    <ReviseOrderDialog :order="revising" @close="revising = null" />
    <RequestTransferDialog v-model="requestOpen" :admission="adm" :from-consult="transferFromConsult" />
    <RequestConsultDialog v-model="consultOpen" :admission="adm" />
    <AnswerConsultDialog :item="answeringLive" @close="answering = null" />
    <ReasonDialog
      v-model="abxResubmitOpen"
      :title="abxResubmit?.kind === 'appeal' ? '申覆：管制性抗生素' : '申請續用：管制性抗生素'"
      :subject="abxResubmit ? `${abxResubmit.order.content}・${abxResubmit.order.abxInfo?.text}` : ''"
      :label="abxResubmit?.kind === 'appeal' ? '申覆說明（感染科會看到）' : '續用理由（感染科會看到）'"
      :presets="abxResubmit?.kind === 'appeal' ? ['病人對建議的藥過敏', '培養仍為抗藥菌', '已會診討論，維持原用藥'] : ['臨床改善中，需完成療程', '骨髓炎或心內膜炎需長療程', '培養仍陽性']"
      :ok-text="abxResubmit?.kind === 'appeal' ? '送出申覆' : '送出申請'"
      :pending="appeal.pending.value || extendAbx.pending.value"
      :error="(abxResubmit?.kind === 'appeal' ? appeal : extendAbx).fieldErrors.value.note"
      @confirm="confirmAbx"
    />
    <ReasonDialog v-model="cancelConsultOpen" title="撤回會診" :subject="cancelling ? `${cancelling.toDeptName}：${cancelling.question}` : ''" label="撤回原因" :presets="['病情已改善', '改為轉科', '開錯科別']" ok-text="撤回" :pending="cancelConsult.pending.value" :error="cancelConsult.fieldErrors.value.reason" @confirm="confirmCancelConsult" />
    <AcceptTransferDialog v-model="acceptOpen" :item="accepting" @accepted="(id) => (admissionId = id)" />
    <UDialog v-model="cancelOpen" title="取消准予出院" size="sm">
      <div class="space-y-3 text-sm">
        <p class="text-slate-600">取消後住院中心不能辦理出院，病摘內容保留為草稿，可修改後再簽署。</p>
        <UTextarea v-model="cancelReason" label="取消原因" required :rows="2" placeholder="例：病人再度發燒，需再觀察" :error="cancelDs.fieldErrors.value.reason" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="cancelOpen = false">返回</UButton>
        <UButton variant="danger" :disabled="!cancelReason.trim()" :loading="cancelDs.pending.value" @click="onCancelDs">取消准予出院</UButton>
      </template>
    </UDialog>
  </div>
</template>
