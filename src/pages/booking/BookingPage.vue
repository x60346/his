<script setup lang="ts">
// 掛號作業：找病人 → 選診次 → 確認身分 → 掛號；下方為當日掛號清單（可退掛）。
import { computed, ref, watch } from 'vue'
import { CreditCard, List as ListIcon, PhoneCall, Ticket, UserPlus, X } from 'lucide-vue-next'
import {
  UBadge, UButton, UCard, UCheckbox, UDialog, UEmpty, UInput, USearchSelect, USelect, UStatusBadge, UTable, UTabs, type Column,
} from '@/components/ui'
import PatientEditDialog from '@/components/PatientEditDialog.vue'
import IdentityCorrectDialog from '@/components/IdentityCorrectDialog.vue'
import SuspendNotices from '@/components/SuspendNotices.vue'
import { admissionApi, bookingApi, masterApi, patientApi, preventApi, scheduleApi, type VisitView } from '@/services'
import type { PatientInput } from '@/services/patient'
import type { SessionView } from '@/services/schedule'
import { useAction, useQuery } from '@/composables/useService'
import { followToday } from '@/composables/useClock'
import { useUi } from '@/stores/ui'
import { useAuth } from '@/stores/auth'
import { ageText, periodLabel, today, weekdayLabel } from '@/utils/date'
import { genderLabel, visitStatus } from '@/utils/labels'
import type { Patient, Period, VisitStatus } from '@/types'

const ui = useUi()
const auth = useAuth()

// ---------- 停診待通知：打電話通知病人是櫃台的工作。名單元件與系統管理共用（SuspendNotices）----------
// 護理師也會用掛號頁，但看不到通知名單（服務層限櫃台與管理員）——只有櫃台才查，不然會跳出權限錯誤
const canNotify = computed(() => auth.user?.role === 'clerk')
const { data: notices } = useQuery(async () => (canNotify.value ? scheduleApi.listSuspendNotices() : []), [canNotify])
const pendingNotices = computed(() => (notices.value ?? []).filter((n) => !n.notifiedAt))
const noticesOpen = ref(false)
/** 哪幾診停診（同一診只列一次）：例「11/14 下午診 黃柏翰」 */
const noticeSessions = computed(() => [...new Set(pendingNotices.value.map((n) => `${n.date.slice(5).replace('-', '/')} ${periodLabel[n.period]} ${n.doctorName}`))].join('、'))

// ---------- 1. 病人 ----------
const patient = ref<Patient | null>(null)
const maskId = (id: string) => `${id.slice(0, 3)}****${id.slice(-3)}`

const editOpen = ref(false)
const prefill = ref<Partial<PatientInput>>()

const readCard = useAction(() => patientApi.readNhiCard())
async function onReadCard() {
  const r = await readCard.run()
  if (!r) return
  if (r.patient) {
    patient.value = r.patient
    ui.toast.info(`讀卡成功：${r.patient.name}（病歷號 ${r.patient.chartNo}）`)
  } else {
    // 卡上的人還沒建檔 → 初診建檔，把卡片資料先帶入
    prefill.value = { name: r.card.name, gender: r.card.gender, birthDate: r.card.birthDate, idNo: r.card.idNo }
    editOpen.value = true
    ui.toast.info(`${r.card.name} 尚未建檔，請完成初診建檔`)
  }
}
function newPatient() {
  prefill.value = undefined
  editOpen.value = true
}

const { data: upcoming } = useQuery(
  async () => (patient.value ? bookingApi.listVisits({ patientId: patient.value.id, upcoming: true, status: ['registered'] }) : []),
  [patient],
)
// 住院中的病人掛門診：不禁止（住院中也可能需要會診其他科），但櫃台要知道
const { data: admittedNow } = useQuery(
  async () => (patient.value ? (await admissionApi.listAdmissions({ patientId: patient.value.id, status: ['admitted'] }))[0] ?? null : null),
  [patient],
)

// ---------- 2. 診次 ----------
const date = ref(today())
const todayStr = followToday(date) // 原本看今天的，跨日時自動換到新的一天
const deptFilter = ref<string | number>()
const sessionId = ref<string>()
const { data: depts } = useQuery(() => masterApi.listDepartments())
const { data: sessions, loading: sessionsLoading } = useQuery(() => scheduleApi.listSessions({ date: date.value }), [date])
watch(date, () => (sessionId.value = undefined))

const periods: Period[] = ['AM', 'PM', 'NIGHT']
const sessionsByPeriod = computed(() =>
  periods
    .map((p) => ({ period: p, list: (sessions.value ?? []).filter((s) => s.period === p && (!deptFilter.value || s.deptId === deptFilter.value)) }))
    .filter((g) => g.list.length),
)
const selectedSession = computed(() => sessions.value?.find((s) => s.id === sessionId.value))
// 點診次卡：選來掛號，下方清單也跟著換成這一診（以前兩者沒連動，要再從清單的下拉選一次）
function pickSession(s: SessionView) {
  if (!s.bookable) return
  sessionId.value = s.id
  listSession.value = s.id
}
// 「名單」：看這一診有誰、誰退掛——不能掛的診（已截止、額滿、停診）也要能看
const listEl = ref<HTMLElement>()
function showList(s: SessionView) {
  listSession.value = s.id
  statusTab.value = 'all'
  listEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ---------- 3. 身分、案件、預防保健 ----------
const identityCode = ref<string | number>('01')
const caseType = ref<string | number>('01')
const preventItems = ref<string[]>([])
const { data: identities } = useQuery(() => masterApi.listIdentities())
const caseTypeOptions = masterApi.staticCodes.caseTypes.map((c) => ({ label: `${c.code} ${c.name}`, value: c.code }))

// 換病人時，身分、案件分類、預防保健都回到預設——以前案件分類沒重設，上一位選 04 慢性病，下一位就沿用
watch(patient, (p) => {
  identityCode.value = p?.defaultIdentity ?? '01'
  caseType.value = '01'
  preventItems.value = []
})
// 上次是慢性病（04／08）時提示，不自動帶入（由櫃台確認這次是不是回診拿慢性病藥）
const { data: lastCase } = useQuery(async () => (patient.value ? bookingApi.lastCaseType(patient.value.id) : null), [patient])
const lastCaseHint = computed(() => {
  const l = lastCase.value
  if (!l || !['04', '08'].includes(l.caseType) || caseType.value === l.caseType) return ''
  return `上次（${l.date.slice(5).replace('-', '/')}）為 ${l.caseType} ${masterApi.staticCodes.caseTypes.find((c) => c.code === l.caseType)?.name ?? ''}`
})

// 資格由服務層判斷，頁面只負責顯示與勾選
const { data: eligibility } = useQuery(async () => (patient.value ? preventApi.eligibilityFor(patient.value.id) : []), [patient])
const eligibleItems = computed(() => (eligibility.value ?? []).filter((e) => e.eligible))

function togglePrevent(code: string, on: boolean) {
  preventItems.value = on ? [...preventItems.value, code] : preventItems.value.filter((c) => c !== code)
}

// ---------- 預估應收（掛號不收費；讓櫃台答得出「今天要多少錢」）----------
// 只含掛號當下就確定的項目；計算與批價共用 billing.fixedCharges，所以和批價時的數字一致
const { data: estimate } = useQuery(
  () => bookingApi.estimateFee(String(identityCode.value), String(caseType.value), preventItems.value.length > 0),
  [identityCode, caseType, () => preventItems.value.length],
)
const feeText = (e: { lines: { kind: string; amount: number }[] }) =>
  e.lines.map((l) => `${{ reg: '掛號費', consult: '診察費', 'copay-basic': '基本部分負擔' }[l.kind] ?? l.kind} ${l.amount}`).join('＋')

// ---------- 掛號 ----------
const lastResult = ref<VisitView>()
// 掛號完成卡片上的預估：用實際掛進去的身分與案件分類（可能已轉成 A3）
const { data: lastEstimate } = useQuery(async () => (lastResult.value ? bookingApi.estimateFee(lastResult.value.identityCode, lastResult.value.caseType) : undefined), [lastResult])
const register = useAction(bookingApi.register, { success: (v) => `掛號完成：${v.patientName} ${v.deptName} 第 ${v.seqNo} 號` })
const canRegister = computed(() => !!patient.value && !!selectedSession.value)

// ---------- 改期：病人來電要換時間。退舊掛新在服務層同一筆交易完成（新診次掛不上就全部不動）----------
const rescheduling = ref<VisitView>()
const reschedule = useAction(bookingApi.rescheduleVisit, { success: (v) => `已改期：${v.patientName} ${v.date} ${v.deptName} 第 ${v.seqNo} 號` })
function startReschedule(u: VisitView) {
  rescheduling.value = u
  // 沿用原本的身分、案件分類、預防保健（仍可修改）；新的診次在步驟 2 選
  identityCode.value = u.identityCode
  caseType.value = u.caseType === 'A3' ? '01' : u.caseType // A3 是「只做預防保健」自動轉的，改回 01 由系統重新判斷
  preventItems.value = [...u.preventItems]
  sessionId.value = undefined
}
watch(patient, () => (rescheduling.value = undefined))

async function submit() {
  if (!patient.value || !sessionId.value) return
  if (rescheduling.value) {
    const v = await reschedule.run(rescheduling.value.id, { sessionId: sessionId.value, identityCode: String(identityCode.value), caseType: String(caseType.value), preventItems: preventItems.value })
    if (v) {
      lastResult.value = v
      rescheduling.value = undefined
      patient.value = null
    }
    return
  }
  const v = await register.run({
    patientId: patient.value.id,
    sessionId: sessionId.value,
    identityCode: String(identityCode.value),
    caseType: String(caseType.value),
    preventItems: preventItems.value,
  })
  if (v) {
    lastResult.value = v
    // 掛完清掉病人，準備服務下一位；診次保留（櫃台常連續掛同一診）
    patient.value = null
  }
}

// ---------- 當日掛號清單 ----------
const statusTab = ref('all')
const listSession = ref<string | number>('')
const { data: visits, loading: visitsLoading } = useQuery(() => bookingApi.listVisits({ date: date.value }), [date])
watch(date, () => (listSession.value = '')) // 換日期後，原本篩選的診次已不存在

const tabDefs: { key: string; label: string; match: VisitStatus[] }[] = [
  { key: 'all', label: '全部', match: [] },
  { key: 'registered', label: '候診', match: ['registered'] },
  { key: 'in-consult', label: '看診中', match: ['in-consult'] },
  { key: 'consulted', label: '待批價', match: ['consulted'] },
  { key: 'done', label: '已完成', match: ['charged', 'dispensed'] },
  { key: 'cancelled', label: '退掛', match: ['cancelled'] },
]
const sessionFiltered = computed(() => (visits.value ?? []).filter((v) => !listSession.value || v.sessionId === listSession.value))
const tabs = computed(() => tabDefs.map((t) => ({ key: t.key, label: t.label, count: sessionFiltered.value.filter((v) => !t.match.length || t.match.includes(v.status)).length })))
const filtered = computed(() => {
  const match = tabDefs.find((t) => t.key === statusTab.value)!.match
  return sessionFiltered.value.filter((v) => !match.length || match.includes(v.status))
})
const listSessionOptions = computed(() => (sessions.value ?? []).map((s) => ({ label: `${periodLabel[s.period]} ${s.roomNo} ${s.deptName} ${s.doctorName}`, value: s.id })))

const columns: Column<VisitView>[] = [
  { key: 'seqNo', label: '號', align: 'center', width: '50px' },
  { key: 'session', label: '診別', format: (v) => `${periodLabel[v.period]} ${v.roomNo}` },
  { key: 'doctor', label: '科別／醫師', format: (v) => `${v.deptName} ${v.doctorName}` },
  { key: 'chartNo', label: '病歷號' },
  { key: 'patientName', label: '姓名' },
  { key: 'identityName', label: '身分' },
  { key: 'status', label: '狀態' },
  { key: 'createdAt', label: '掛號時間', format: (v) => v.createdAt.slice(11) },
  { key: 'actions', label: '', align: 'right' },
]

const cancel = useAction(bookingApi.cancelVisit, { success: (v) => `已退掛：${v.patientName}` })
async function onCancel(v: VisitView) {
  const ok = await ui.confirm({ title: '退掛', message: `確定將 ${v.patientName}（${v.deptName} 第 ${v.seqNo} 號）退掛？`, okText: '退掛', danger: true })
  if (ok && (await cancel.run(v.id)) && rescheduling.value?.id === v.id) rescheduling.value = undefined
}

// 更正就醫身分：病人看完卡片才發現選錯，是最常更正的時機；收費前都可以改（規則在服務層）
const identityVisit = ref<VisitView>()
const identityOpen = ref(false)
function openIdentity(v: VisitView) {
  identityVisit.value = v
  identityOpen.value = true
}
</script>

<template>
  <div class="space-y-4">
    <!-- 停診待通知：有人還沒通知時才出現；名單與系統管理用同一個元件 -->
    <div v-if="pendingNotices.length" class="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
      <PhoneCall class="h-4 w-4 shrink-0" />
      <span class="min-w-0 flex-1">
        停診待通知 <b class="tabular">{{ pendingNotices.length }}</b> 位
        <span class="text-xs text-amber-800">（{{ noticeSessions }}）</span>
      </span>
      <UButton size="sm" variant="secondary" @click="noticesOpen = true">開啟名單</UButton>
    </div>
    <UDialog v-model="noticesOpen" title="停診通知" size="lg"><SuspendNotices /></UDialog>
    <!--
      元素依 1 → 2 → 3 的順序排在同一層：手機依序往下堆疊，步驟就是 1、2、3。
      桌機用 col-start / row-start 排成左右兩欄（左：1、3、看診號；右：2）。
      以前左欄包成一個區塊（1 和 3 在裡面），手機上就變成 1 → 3 → 2。
    -->
    <div class="grid grid-cols-1 gap-4 xl:grid-cols-[22rem_1fr] xl:grid-rows-[auto_auto_1fr]">
        <UCard title="1. 病人" class="xl:col-start-1 xl:row-start-1">
          <template #actions>
            <UButton size="sm" variant="secondary" :icon="CreditCard" :loading="readCard.pending.value" @click="onReadCard">讀健保卡</UButton>
            <UButton size="sm" variant="secondary" :icon="UserPlus" @click="newPatient">初診</UButton>
          </template>
          <USearchSelect
            placeholder="病歷號、姓名、身分證、電話"
            :search="(kw) => patientApi.searchPatients(kw, 15)"
            :item-key="(p) => p.id"
            :item-label="(p) => `${p.chartNo}　${p.name}`"
            :item-sub="(p) => `${genderLabel[p.gender]}・${ageText(p.birthDate)}・${maskId(p.idNo)}`"
            @select="(p) => (patient = p)"
          />
          <div v-if="patient" class="mt-3 rounded-md border border-brand-200 bg-brand-50/50 p-3 text-sm">
            <div class="flex items-start justify-between">
              <div>
                <span class="text-base font-semibold text-slate-800">{{ patient.name }}</span>
                <span class="ml-2 text-slate-500">{{ genderLabel[patient.gender] }}・{{ ageText(patient.birthDate) }}</span>
              </div>
              <button class="text-slate-400 hover:text-slate-600" aria-label="清除病人" @click="patient = null"><X class="h-4 w-4" /></button>
            </div>
            <div class="mt-1 text-slate-600">病歷號 {{ patient.chartNo }}・{{ maskId(patient.idNo) }}</div>
            <div v-if="patient.allergies.length" class="mt-1 font-medium text-red-600">過敏：{{ patient.allergies.join('、') }}</div>
            <div v-if="admittedNow && admittedNow.patientId === patient.id" class="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900" role="status">
              目前住院中：{{ admittedNow.bed?.ward }} {{ admittedNow.bed?.bedNo }}（第 {{ admittedNow.days }} 天，{{ admittedNow.doctorName }}）。如需掛門診請確認。
            </div>
            <div v-if="upcoming?.length" class="mt-2 border-t border-brand-100 pt-2 text-xs text-slate-600">
              <div class="mb-0.5 font-medium">已有預約：</div>
              <!-- 病人來電取消或換時間：直接在這裡處理，不必到下方清單換日期再找人 -->
              <div v-for="u in upcoming" :key="u.id" :class="['flex items-center gap-2 py-0.5', rescheduling?.id === u.id && 'font-medium text-amber-800']">
                <span class="min-w-0 flex-1">{{ u.date.slice(5).replace('-', '/') }}（{{ weekdayLabel(u.date) }}）{{ periodLabel[u.period] }} {{ u.deptName }} {{ u.doctorName }} 第 {{ u.seqNo }} 號</span>
                <button type="button" class="shrink-0 text-brand-600 hover:underline" @click="startReschedule(u)">改期</button>
                <button type="button" class="shrink-0 text-red-600 hover:underline" @click="onCancel(u)">退掛</button>
              </div>
            </div>
          </div>
          <p v-else class="mt-3 text-xs text-slate-400">搜尋病人，或按「讀健保卡」。未建檔的新病人請按「初診」。</p>
        </UCard>

        <UCard title="2. 選擇診次" class="xl:col-start-2 xl:row-span-3 xl:row-start-1">
          <template #actions>
            <div class="w-36"><USelect v-model="deptFilter" :options="(depts ?? []).map((d) => ({ label: d.name, value: d.id }))" placeholder="全部科別" /></div>
            <div class="w-40"><UInput v-model="date" type="date" :min="todayStr" /></div>
          </template>
          <UEmpty v-if="!sessionsLoading && !sessionsByPeriod.length" title="這天沒有門診" description="請選擇其他日期或科別" />
          <div v-for="g in sessionsByPeriod" :key="g.period" class="mb-4 last:mb-0">
            <div class="mb-2 text-xs font-semibold text-slate-500">{{ periodLabel[g.period] }}</div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-3">
              <!-- 卡片是兩個按鈕：主區「選來掛號」（不能掛時停用）、右側「名單」（一律可按，看這一診有誰）。按鈕裡不能再放按鈕，所以外框用 div -->
              <div
                v-for="s in g.list"
                :key="s.id"
                :class="[
                  'flex items-stretch rounded-md border text-sm transition',
                  !s.bookable ? 'border-slate-200 bg-slate-50'
                  : s.id === sessionId ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500/30'
                  : 'border-slate-200 bg-white hover:border-brand-300',
                ]"
              >
                <button type="button" :disabled="!s.bookable" :class="['min-w-0 flex-1 px-3 py-2 text-left', !s.bookable && 'cursor-not-allowed opacity-60']" @click="pickSession(s)">
                  <div class="flex items-center justify-between gap-2">
                    <span class="font-medium text-slate-800">{{ s.deptName }}・{{ s.doctorName }}</span>
                    <UBadge v-if="s.suspended" tone="red">停診</UBadge>
                    <UBadge v-else-if="s.closed">已截止</UBadge>
                    <UBadge v-else-if="s.full" tone="red">額滿</UBadge>
                  </div>
                  <div class="mt-0.5 flex justify-between gap-2 text-xs text-slate-500">
                    <span>{{ s.roomNo }} 診<template v-if="s.originalDoctorName">・代診（原{{ s.originalDoctorName }}）</template></span>
                    <span class="tabular">已掛 {{ s.booked }} / {{ s.limit }}・候診 {{ s.waiting }}</span>
                  </div>
                </button>
                <button
                  type="button"
                  :class="['flex shrink-0 flex-col items-center justify-center gap-0.5 border-l px-2 text-xs hover:bg-brand-50 hover:text-brand-700', listSession === s.id ? 'border-brand-200 bg-brand-50 font-medium text-brand-700' : 'border-slate-200 text-slate-500']"
                  :aria-label="`${s.deptName} ${s.doctorName} ${s.roomNo} 診的掛號名單`"
                  @click="showList(s)"
                >
                  <ListIcon class="h-4 w-4" />名單
                </button>
              </div>
            </div>
          </div>
        </UCard>

        <UCard :title="rescheduling ? '3. 確認改期' : '3. 確認掛號'" class="xl:col-start-1 xl:row-start-2">
          <div class="space-y-3">
            <div v-if="rescheduling" class="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <span class="min-w-0 flex-1">改期中：原 {{ rescheduling.date.slice(5).replace('-', '/') }} {{ periodLabel[rescheduling.period] }} {{ rescheduling.doctorName }} 第 {{ rescheduling.seqNo }} 號<br /><span class="text-xs">請在步驟 2 選新的診次</span></span>
              <button type="button" class="shrink-0 text-amber-700 hover:text-amber-900" aria-label="取消改期" @click="rescheduling = undefined"><X class="h-4 w-4" /></button>
            </div>
            <div class="rounded-md bg-slate-50 px-3 py-2 text-sm">
              <template v-if="selectedSession">
                {{ selectedSession.date }}（{{ weekdayLabel(selectedSession.date) }}）{{ periodLabel[selectedSession.period] }}<br />
                <span class="font-medium">{{ selectedSession.deptName }} {{ selectedSession.doctorName }}</span>・{{ selectedSession.roomNo }} 診
              </template>
              <span v-else class="text-slate-400">尚未選擇診次</span>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <USelect v-model="identityCode" label="就醫身分" :options="(identities ?? []).map((i) => ({ label: i.name, value: i.code }))" />
              <USelect v-model="caseType" label="案件分類" :options="caseTypeOptions" />
            </div>
            <p v-if="lastCaseHint" class="-mt-1 flex items-center gap-2 text-xs text-amber-700">
              {{ lastCaseHint }}
              <button type="button" class="text-brand-600 underline-offset-2 hover:underline" @click="caseType = lastCase!.caseType">改用 {{ lastCase!.caseType }}</button>
            </p>
            <div v-if="eligibleItems.length">
              <div class="mb-1 text-xs font-medium text-slate-600">可加做預防保健（資格由系統判斷）</div>
              <div class="space-y-1 rounded-md border border-emerald-200 bg-emerald-50/50 px-3 py-2">
                <UCheckbox
                  v-for="e in eligibleItems"
                  :key="e.itemCode"
                  :model-value="preventItems.includes(e.itemCode)"
                  @update:model-value="(v) => togglePrevent(e.itemCode, v)"
                >
                  {{ e.itemName }} <span class="text-xs text-slate-500">（{{ e.reason }}）</span>
                </UCheckbox>
              </div>
              <p v-if="preventItems.length && caseType === '01'" class="mt-1 text-xs text-slate-500">僅做預防保健時，系統會以 A3 案件申報（免基本部分負擔）。</p>
            </div>
            <div v-if="estimate" class="rounded-md border border-slate-200 px-3 py-2 text-sm">
              <div class="flex items-baseline justify-between gap-2">
                <span class="text-slate-600">預估應收</span>
                <span class="tabular text-lg font-semibold text-slate-800">{{ estimate.total }} 元</span>
              </div>
              <div class="tabular text-xs text-slate-500">{{ feeText(estimate) }}<template v-if="estimate.copayNote">（{{ estimate.copayNote }}）</template></div>
              <!-- 自費身分沒有「部分負擔」，藥費全額自付 -->
              <div class="mt-0.5 text-xs text-slate-400">{{ estimate.copayNote === '自費身分' ? '藥費等項目' : '藥品部分負擔、自費項目' }}看診後才確定；看診後至批價櫃台結帳</div>
            </div>
            <UButton block :icon="Ticket" :disabled="!canRegister || (!!rescheduling && sessionId === rescheduling.sessionId)" :loading="register.pending.value || reschedule.pending.value" @click="submit">{{ rescheduling ? '改期到此診' : '掛號' }}</UButton>
          </div>
        </UCard>

        <div v-if="lastResult" class="self-start xl:col-start-1 xl:row-start-3 flex items-center gap-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <div class="text-center">
            <div class="text-xs text-emerald-700">看診號</div>
            <div class="tabular text-4xl font-bold text-emerald-700">{{ lastResult.seqNo }}</div>
          </div>
          <div class="text-sm text-slate-700">
            <div class="font-semibold">{{ lastResult.patientName }}（{{ lastResult.chartNo }}）</div>
            <div>{{ lastResult.date }} {{ periodLabel[lastResult.period] }}</div>
            <div>{{ lastResult.deptName }} {{ lastResult.doctorName }}・{{ lastResult.roomNo }} 診</div>
            <div v-if="lastEstimate" class="mt-1 text-xs text-slate-600">預估應收 <b class="tabular">{{ lastEstimate.total }}</b> 元起（看診後批價結帳）</div>
          </div>
        </div>
    </div>

    <!-- 當日掛號清單 -->
    <div ref="listEl" class="scroll-mt-4">
    <UCard :title="`${date} 掛號清單`" :padded="false">
      <template #actions>
        <div class="w-64"><USelect v-model="listSession" :options="listSessionOptions" placeholder="全部診次" /></div>
      </template>
      <div class="px-4"><UTabs v-model="statusTab" :tabs="tabs" /></div>
      <UTable :columns="columns" :rows="filtered" :row-key="(v) => v.id" :loading="visitsLoading" dense empty-text="沒有符合的掛號">
        <template #cell-status="{ row }"><UStatusBadge :map="visitStatus" :value="row.status" /></template>
        <template #cell-actions="{ row }">
          <UButton v-if="['registered', 'in-consult', 'consulted'].includes(row.status)" size="sm" variant="ghost" @click="openIdentity(row)">更正身分</UButton>
          <UButton v-if="row.status === 'registered'" size="sm" variant="ghost" @click="onCancel(row)">退掛</UButton>
        </template>
      </UTable>
    </UCard>
    </div>

    <PatientEditDialog v-model="editOpen" :prefill="prefill" @saved="(p) => (patient = p)" />
    <IdentityCorrectDialog v-model="identityOpen" :visit-id="identityVisit?.id" :identity-code="identityVisit?.identityCode" :subject="identityVisit && `${identityVisit.patientName}（${identityVisit.deptName} 第 ${identityVisit.seqNo} 號）・目前身分 ${identityVisit.identityName}`" />
  </div>
</template>
