<script setup lang="ts">
// 住院醫囑：醫師的住院病人 → 長期／臨時醫囑、病程紀錄、出院病摘。
// 出院由醫師決定：寫好出院病摘並簽署＝准予出院，住院中心才能辦理手續。
// 長期給藥醫囑會連動護理站的給藥排程（由服務層處理），停止醫囑時未執行的排程一併刪除。
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { computed, reactive, ref, watch } from 'vue'
import { ArrowRightLeft, LogOut, Plus, Square } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UDialog, UEmpty, UQueryState, USelect, UTabs, UTextarea } from '@/components/ui'
import PatientBanner from '@/components/PatientBanner.vue'
import DischargeSummaryView from '@/components/DischargeSummaryView.vue'
import OrderDialog from './components/OrderDialog.vue'
import ReasonDialog from '@/components/ReasonDialog.vue'
import PhraseHint from '@/components/PhraseHint.vue'
import { usePhrases } from '@/composables/usePhrases'
import RequestTransferDialog from './components/RequestTransferDialog.vue'
import AcceptTransferDialog from './components/AcceptTransferDialog.vue'
import type { IncomingTransfer } from '@/services/admission'
import { admissionApi, ipdApi, isAbnormal, masterApi, nursingApi, type VitalKey } from '@/services'
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

const admissionId = ref<string>()
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

// ---------- 醫囑 ----------
const { data: orders, loading: ordersLoading } = useQuery(async () => (admissionId.value ? ipdApi.listOrders(admissionId.value) : []), [admissionId])
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
  const q = o.pendingQuery ? `\n\n護理師的疑問「${o.pendingQuery.reason}」會一併結案（記為「已停止此醫囑」）；要改的話請另開正確的一筆。` : ''
  if (await ui.confirm({ title: '停止醫囑', message: message + q, okText: '停止', danger: true })) stop.run(o.id)
}

// ---------- 回覆護理師疑問：確認原醫囑無誤（寫說明）；要改就「停止」再另開 ----------
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
  { key: 'discharge', label: ds.value?.signedAt ? '出院病摘・已准出院' : ds.value ? '出院病摘・草稿' : '出院病摘' },
])

// ---------- 出院病摘 ----------
// 已簽署（准予出院）就唯讀；要改先「取消准予出院」，內容會留成草稿
const dischargeTypes = masterApi.staticCodes.dischargeTypes
const dsForm = reactive({ diagnosis: '', course: '', condition: '', followUp: '', dischargeType: '' as string | number })
// 換病人、或病摘存檔／簽署／取消後，表單換成資料庫裡的內容。用字串當 key：adm 每次重新查詢都是新物件，直接看物件會一直重設、把正在打的字洗掉
watch(
  () => `${adm.value?.id}|${ds.value?.writtenAt}|${ds.value?.signedAt}`,
  () => {
    const d = ds.value
    Object.assign(dsForm, d
      ? { diagnosis: d.diagnosis, course: d.course, condition: d.condition, followUp: d.followUp, dischargeType: d.dischargeType }
      : { diagnosis: adm.value?.diagnosis ?? '', course: '', condition: '', followUp: '', dischargeType: '' })
  },
  { immediate: true },
)
const saveDs = useAction(ipdApi.saveDischargeSummary, { success: (d) => (d.signedAt ? '已簽署出院病摘，准予出院；住院中心可辦理手續' : '已儲存病摘草稿') })
function onSaveDs(sign: boolean) {
  if (!adm.value) return
  saveDs.run(adm.value.id, { ...dsForm, dischargeType: String(dsForm.dischargeType) }, sign)
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
                <UBadge v-if="a.openQueries" tone="yellow" class="ml-auto" :title="`護理師有 ${a.openQueries} 筆醫囑疑問待回覆`">疑問 {{ a.openQueries }}</UBadge>
                <UBadge v-if="a.dischargeReady" tone="green" :class="!a.openQueries && 'ml-auto'">准出院</UBadge>
                <span :class="['text-xs text-slate-500', !a.dischargeReady && !a.openQueries && 'ml-auto']">第 {{ a.days }} 天</span>
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
        <UButton v-if="!isAdmin && transfer?.status !== 'pending' && !adm.dischargeReady" size="sm" variant="secondary" class="ml-auto" :icon="ArrowRightLeft" @click="requestOpen = true">申請轉科</UButton>
      </PatientBanner>
      <div v-if="transfer?.status === 'pending'" class="flex flex-wrap items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-4 py-2 text-sm text-sky-900" role="status">
        <ArrowRightLeft class="h-4 w-4" />
        <span class="min-w-0 flex-1">已申請轉 <b>{{ transfer.toDeptName }}</b><template v-if="transfer.toDoctorName">（指定 {{ transfer.toDoctorName }}）</template>・{{ transfer.requestedAt.slice(5) }}・{{ transfer.reason }}。等新科醫師接受；期間仍由您負責。</span>
        <UButton v-if="!isAdmin" size="sm" variant="secondary" :loading="cancelTransfer.pending.value" @click="onCancelTransfer">撤回申請</UButton>
      </div>
      <div v-else-if="transfer?.status === 'declined'" class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900" role="status">
        轉 {{ transfer.toDeptName }} 的申請被婉拒（{{ transfer.decidedByName }} {{ transfer.decidedAt?.slice(5) }}）：{{ transfer.decisionNote }}
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

        <!-- 醫囑 -->
        <div v-if="tab === 'orders'" class="space-y-5 p-4">
          <UQueryState :loading="ordersLoading" :ready="!!orders">
            <section v-for="sec in [{ title: '長期醫囑', list: longOrders }, { title: '臨時醫囑', list: statOrders }]" :key="sec.title" class="mb-5 last:mb-0">
              <h3 class="mb-2 text-sm font-semibold text-slate-700">{{ sec.title }}</h3>
              <p v-if="!sec.list.length" class="text-sm text-slate-400">沒有{{ sec.title }}</p>
              <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
                <li v-for="o in sec.list" :key="o.id" :class="['flex flex-wrap items-center gap-3 px-3 py-2 text-sm', o.status !== 'active' && 'bg-slate-50 text-slate-400', o.pendingQuery && 'border-l-4 border-l-amber-500 bg-amber-50/50']">
                  <UBadge :tone="o.status === 'active' ? categoryLabel[o.category].tone : 'gray'">{{ categoryLabel[o.category].label }}</UBadge>
                  <div class="min-w-0 flex-1">
                    <div :class="['font-medium', o.status === 'active' && 'text-slate-800', o.status === 'stopped' && 'line-through']">
                      {{ o.content }}
                      <UBadge v-if="o.highAlert && o.status === 'active'" tone="purple" class="ml-1">高警訊</UBadge>
                    </div>
                    <div v-if="o.category === 'medication'" class="tabular text-xs">每次 {{ o.dose }} {{ o.unit }}・{{ o.freq }}（{{ o.freqLabel }}）・{{ o.route }}</div>
                  </div>
                  <div class="tabular text-right text-xs">
                    <div>{{ o.startAt.slice(5) }} 開立</div>
                    <div v-if="o.stopAt">{{ o.stopAt.slice(5) }} 停止</div>
                  </div>
                  <span class="w-12 text-xs">{{ statusLabel[o.status] }}</span>
                  <UButton v-if="o.status === 'active'" size="sm" variant="ghost" :icon="Square" @click="onStop(o)">停止</UButton>
                  <span v-else class="w-[4.25rem]" />
                  <!-- 護理師的疑問：回覆前這筆暫停執行。確認無誤就回覆；要改就停止再另開 -->
                  <div v-if="o.pendingQuery" class="flex w-full items-center gap-2 text-xs text-amber-900">
                    <span class="min-w-0 flex-1">護理師疑問（{{ o.pendingQuery.byName }} {{ o.pendingQuery.at.slice(5) }}）：{{ o.pendingQuery.reason }}・回覆前暫停執行</span>
                    <UButton size="sm" @click="replying = o">回覆：確認無誤</UButton>
                  </div>
                </li>
              </ul>
            </section>
          </UQueryState>
        </div>

        <!-- 出院病摘：醫師撰寫；簽署＝准予出院 -->
        <div v-else-if="tab === 'discharge'" class="space-y-3 p-4">
          <template v-if="ds?.signedAt">
            <div class="flex flex-wrap items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              <LogOut class="h-4 w-4" />已准予出院，等住院中心辦理手續。
              <UButton class="ml-auto" size="sm" variant="secondary" @click="openCancel">取消准予出院</UButton>
            </div>
            <DischargeSummaryView :summary="ds" :doctor-name="adm.summaryDoctorName" />
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
            <PhraseHint :phrases="phrase.phrases.value" />
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
            <PhraseHint class="mt-1" :phrases="phrase.phrases.value" />
            <div class="mt-2 text-right"><UButton size="sm" :loading="addNote.pending.value" @click="submitNote">儲存病程紀錄</UButton></div>
          </div>
          <article v-for="n in notes" :key="n.id" class="rounded-md border border-slate-200 p-3 text-sm">
            <header class="mb-1.5 flex justify-between text-xs text-slate-500"><span class="tabular font-medium text-slate-700">{{ n.at }}</span><span>{{ n.doctorName }}</span></header>
            <dl class="grid gap-1">
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
    <RequestTransferDialog v-model="requestOpen" :admission="adm" />
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
