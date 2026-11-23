<script setup lang="ts">
// 急診：
//   - 檢傷掛號（護理師）：找病人 → 主訴（常見主訴一鍵帶入）＋生命徵象 → 即時建議級數（和服務層同一個 suggestLevel）→ 選級數（比建議重要寫原因，不能比建議輕）
//   - 看板：待看診依級數排、等候超過目標標紅；醫師在「門診看診」的急診診次看（依級數叫號）；看完後在這裡決定去向（離院、收住院、轉院）
//   - 重新檢傷（候診中病情變化）；收住院的在看板標「待床」等了多久
//   - 留觀＝特別的住院：醫師決定留觀 → 護理師排留觀床（OB1–OB6，產生住院號、印腕帶）→ 照住院流程開醫囑、給藥、護理（住院醫囑、護理站「急診留觀區」）
//     → 急診醫師結束留觀（離院、收住院、轉院）；超過 24 小時標紅、48 小時首頁待辦
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { AlertTriangle, Siren, Stethoscope } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UPageHeader, UQueryState, USelect, UTextarea } from '@/components/ui'
import PatientFlags from '@/components/PatientFlags.vue'
import WristbandDialog from '@/components/WristbandDialog.vue'
import ErLabDialog from '@/components/ErLabDialog.vue'
import {
  admissionApi, ER_COMPLAINTS, ER_TRANSFER_HOSPITALS, erApi, masterApi, OBS_LONG_HOURS, patientApi, suggestLevel, TRIAGE_LABEL, TRIAGE_LEVELS, TRIAGE_TARGET_MIN,
  type ErBoardItem,
} from '@/services'
import type { Patient, TriageLevel, TriageVitals } from '@/types'
import { useAction, useDebounced, useQuery } from '@/composables/useService'
import { ageText, today } from '@/utils/date'
// 今天的只顯示時刻；留觀跨日的帶日期
const atText = (s: string) => (s.slice(0, 10) === today() ? s.slice(11) : s.slice(5))

const router = useRouter()
const { data: board, loading } = useQuery(() => erApi.erBoard())
const LEVEL_CLASS: Record<number, string> = { 1: 'bg-red-600 text-white', 2: 'bg-orange-500 text-white', 3: 'bg-yellow-400 text-slate-900', 4: 'bg-emerald-500 text-white', 5: 'bg-sky-500 text-white' }
const stageTone = (i: ErBoardItem) =>
  i.stage === 'waiting' ? (i.wait.overdue ? 'red' : 'yellow') : i.stage === 'seeing' ? 'blue' : i.stage === 'deciding' ? 'purple' : i.stage === 'bed' ? 'red'
    : i.stage === 'obs-bed' ? 'yellow' : i.stage === 'obs' ? (i.obs?.long ? 'red' : 'blue') : 'gray'
const OBS_BED_CLASS: Record<string, string> = { empty: 'border-emerald-300 bg-emerald-50 text-emerald-800', occupied: 'border-blue-300 bg-blue-50 text-blue-900', cleaning: 'border-slate-300 bg-slate-100 text-slate-600', reserved: 'border-amber-300 bg-amber-50 text-amber-800' }
const active = computed(() => (board.value?.items ?? []).filter((i) => !['left', 'admitted'].includes(i.stage)))
const done = computed(() => (board.value?.items ?? []).filter((i) => ['left', 'admitted'].includes(i.stage)))
// 急診檢驗（床邊採檢、看報告）
const labVisit = ref('')
const labOpen = computed({ get: () => !!labVisit.value, set: (x) => !x && (labVisit.value = '') })
const labText = (l: NonNullable<ErBoardItem['labs']>) => [l.toCollect && `待採檢 ${l.toCollect}`, l.toReceive && `待收件 ${l.toReceive}`, l.inLab && `檢驗中 ${l.inLab}`, l.reported && `已出 ${l.reported}`].filter(Boolean).join('・')

// ---------- 檢傷掛號 ----------
const triOpen = ref(false)
const keyword = ref('')
const kw = useDebounced(keyword, 250)
const { data: found } = useQuery(async () => (triOpen.value && String(kw.value ?? '').trim() ? patientApi.searchPatients(String(kw.value)) : []), [kw, triOpen])
const patient = ref<Patient>()
const tri = reactive({ complaint: '', reason: '', level: undefined as TriageLevel | undefined })
const vitals = reactive<TriageVitals>({})
function openTri() {
  keyword.value = ''
  patient.value = undefined
  Object.assign(tri, { complaint: '', reason: '', level: undefined })
  for (const k of Object.keys(vitals) as (keyof TriageVitals)[]) delete vitals[k]
  register.fieldErrors.value = {}
  triOpen.value = true
}
/** 即時建議：和服務層同一個 suggestLevel（送出時服務層會再判斷一次） */
const sug = computed(() => suggestLevel(tri.complaint, vitals))
watch(() => sug.value.level, (l) => {
  if (!tri.level || tri.level > l) tri.level = l
})
const setV = (k: keyof TriageVitals, v: unknown) => (vitals[k] = v === '' || v === undefined || v === null ? undefined : Number(v))
const register = useAction(erApi.triageAndRegister, { success: (v) => `已檢傷掛號：${v.patientName}，檢傷 ${v.er?.level} 級` })
async function submitTri() {
  if (!patient.value || !tri.level) return
  const ok = await register.run({ patientId: patient.value.id, complaint: tri.complaint, vitals: { ...vitals }, level: tri.level, reason: tri.reason })
  if (ok) triOpen.value = false
}
const VITAL_FIELDS: { key: keyof TriageVitals; label: string; step?: string }[] = [
  { key: 'temp', label: '體溫 °C', step: '0.1' }, { key: 'pulse', label: '脈搏' }, { key: 'resp', label: '呼吸' }, { key: 'sbp', label: '收縮壓' }, { key: 'dbp', label: '舒張壓' }, { key: 'spo2', label: '血氧 %' }, { key: 'gcs', label: 'GCS（選填）' },
]

// ---------- 重新檢傷 ----------
const re = ref<ErBoardItem>()
const reOpen = computed({ get: () => !!re.value, set: (x) => !x && (re.value = undefined) })
const reForm = reactive({ level: undefined as TriageLevel | undefined, reason: '' })
function openRe(i: ErBoardItem) {
  Object.assign(reForm, { level: i.level, reason: '' })
  reAct.fieldErrors.value = {}
  re.value = i
}
const reAct = useAction(erApi.retriage, { success: (i) => `已重新檢傷：${i.patientName} ${i.level} 級` })
async function submitRe() {
  if (re.value && reForm.level && (await reAct.run(re.value.visitId, { level: reForm.level, reason: reForm.reason }))) re.value = undefined
}

// ---------- 去向 ----------
const dis = ref<ErBoardItem>()
const disOpen = computed({ get: () => !!dis.value, set: (x) => !x && (dis.value = undefined) })
const disForm = reactive({ kind: 'home' as 'home' | 'admit' | 'transfer' | 'obs', note: '', hospital: '', deptId: '' as string | number | undefined, doctorId: '' as string | number | undefined, diagnosis: '' })
function openDis(i: ErBoardItem) {
  Object.assign(disForm, { kind: 'home', note: '', hospital: '', deptId: '', doctorId: '', diagnosis: '' })
  disAct.fieldErrors.value = {}
  dis.value = i
}
const { data: depts } = useQuery(() => masterApi.listDepartments())
const { data: doctors } = useQuery(() => masterApi.listDoctors())
const inpatientDepts = computed(() => (depts.value ?? []).filter((d) => !['RAD', 'INF', 'ER'].includes(d.code)).map((d) => ({ label: d.name, value: d.id })))
const deptDoctors = computed(() => (doctors.value ?? []).filter((d) => d.deptId === disForm.deptId).map((d) => ({ label: d.name, value: d.id })))
const disAct = useAction(erApi.setDisposition, { success: (i) => `已決定去向：${i.dispositionText}` })
async function submitDis() {
  if (!dis.value) return
  const ok = await disAct.run(dis.value.visitId, { kind: disForm.kind, note: disForm.note, hospital: disForm.hospital, deptId: String(disForm.deptId ?? ''), doctorId: String(disForm.doctorId ?? ''), diagnosis: disForm.diagnosis })
  if (ok) dis.value = undefined
}

// ---------- 留觀：排床（護理師）、清潔完成、腕帶 ----------
const bedFor = ref<ErBoardItem>()
const bedOpen = computed({ get: () => !!bedFor.value, set: (x) => !x && (bedFor.value = undefined) })
const bedPick = ref('')
const emptyObsBeds = computed(() => (board.value?.obsBeds ?? []).filter((b) => b.status === 'empty'))
function openBed(i: ErBoardItem) {
  bedPick.value = emptyObsBeds.value[0]?.id ?? ''
  bedFor.value = i
}
const wristbandFor = ref<string>()
const wristbandOpen = ref(false)
const assign = useAction(erApi.assignObsBed, { success: (a) => `${a.patientName} 已排 ${a.bed?.bedNo}，住院號 ${a.admitNo}` })
async function submitBed() {
  if (!bedFor.value?.admissionId || !bedPick.value) return
  const a = await assign.run(bedFor.value.admissionId, bedPick.value)
  if (a) {
    bedFor.value = undefined
    wristbandFor.value = a.id
    wristbandOpen.value = true
  }
}
const clean = useAction(erApi.cleanObsBed, { success: (b) => `${b.bedNo} 清潔完成` })

// ---------- 結束留觀（急診醫師） ----------
const endFor = ref<ErBoardItem>()
const endOpen = computed({ get: () => !!endFor.value, set: (x) => !x && (endFor.value = undefined) })
const endForm = reactive({ kind: 'home' as 'home' | 'admit' | 'transfer', note: '', hospital: '', deptId: '' as string | number | undefined, doctorId: '' as string | number | undefined, diagnosis: '', bedId: '' as string | number | undefined, confirm: false })
function openEnd(i: ErBoardItem) {
  Object.assign(endForm, { kind: 'home', note: '', hospital: '', deptId: '', doctorId: '', diagnosis: '', bedId: '', confirm: false })
  endAct.fieldErrors.value = {}
  endFor.value = i
}
const endDoctors = computed(() => (doctors.value ?? []).filter((d) => d.deptId === endForm.deptId).map((d) => ({ label: d.name, value: d.id })))
// 收住院一併轉床：病房的空床（依隔離排不了的不列）；不選＝留在留觀床，住院中心「待轉床」
const admitting = computed(() => !!endFor.value && endForm.kind === 'admit')
const { data: allBeds } = useQuery(async () => (admitting.value ? admissionApi.listBeds() : []), [admitting])
const { data: endBlocks } = useQuery(async () => (admitting.value && endFor.value?.admissionId ? admissionApi.bedBlocks(endFor.value.admissionId, { afterObs: true }) : ({} as Record<string, string>)), [admitting, () => endFor.value?.admissionId])
const wardBedOptions = computed(() => [
  { label: '先留在留觀床（住院中心再轉床）', value: '' },
  ...(allBeds.value ?? []).filter((b) => b.status === 'empty' && b.ward !== masterApi.staticCodes.obsWard && !endBlocks.value?.[b.id]).map((b) => ({ label: `${b.ward} ${b.bedNo}（${b.bedClass}）`, value: b.id })),
])
const endAct = useAction(erApi.endObservation, { success: (i) => `${i.patientName}：${i.obs?.endText ?? '已結束留觀'}` })
async function submitEnd() {
  if (!endFor.value?.admissionId) return
  const ok = await endAct.run(endFor.value.admissionId, {
    kind: endForm.kind, note: endForm.note, hospital: endForm.hospital, deptId: String(endForm.deptId ?? ''), doctorId: String(endForm.doctorId ?? ''), diagnosis: endForm.diagnosis,
    ...(endForm.bedId ? { bedId: String(endForm.bedId) } : {}), confirmUnfinished: endForm.confirm,
  })
  if (ok) endFor.value = undefined
}
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="急診" description="檢傷掛號、急診看板（依檢傷級數）、去向（離院、留觀、收住院、轉院）">
      <UButton v-if="board?.canTriage" :icon="Siren" @click="openTri">檢傷掛號</UButton>
      <UButton v-if="board?.canDispose" variant="secondary" :icon="Stethoscope" @click="router.push({ name: 'opd' })">到門診看診（急診診次）</UButton>
    </UPageHeader>
    <UQueryState :loading="loading && !board" :ready="!!board">
      <template v-if="board">
        <p class="text-xs text-slate-500">目標等候時間：{{ TRIAGE_LEVELS.map((l) => `${l} 級 ${TRIAGE_TARGET_MIN[l] ? `${TRIAGE_TARGET_MIN[l]} 分` : '立即'}`).join('・') }}。醫師在「門診看診」看急診病人（依級數叫號），看完回到這裡決定去向。</p>
        <div class="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs">
          <span class="font-medium text-slate-700">急診留觀區</span>
          <span v-for="b in board.obsBeds" :key="b.id" :class="['inline-flex items-center gap-1 rounded border-2 px-2 py-0.5', OBS_BED_CLASS[b.status]]">
            <b>{{ b.bedNo }}</b>{{ b.patientName ?? b.statusLabel }}
            <button v-if="b.status === 'cleaning' && board.canTriage" type="button" class="ml-1 text-brand-700 underline" :disabled="clean.pending.value" @click="clean.run(b.id)">清潔完成</button>
          </span>
          <span class="text-slate-500">留觀超過 {{ OBS_LONG_HOURS }} 小時標紅</span>
        </div>
        <p v-if="!active.length" class="rounded-md border border-slate-200 bg-white px-3 py-6 text-center text-sm text-slate-400">急診目前沒有病人</p>
        <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white text-sm">
          <li v-for="i in active" :key="i.visitId" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <span :class="['tabular inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold', LEVEL_CLASS[i.level]]" :title="i.levelLabel">{{ i.level }}</span>
            <div class="min-w-0 flex-[1_1_10rem]">
              <div class="flex flex-wrap items-center gap-2">
                <b class="text-slate-800">{{ i.patientName }}</b>
                <span class="text-xs text-slate-500">{{ i.gender }} {{ i.age }}・{{ i.chartNo }}</span>
                <AlertTriangle v-if="i.allergies.length" class="h-3.5 w-3.5 text-red-600" :title="`過敏：${i.allergies.join('、')}`" />
                <PatientFlags :flags="i.flags" compact />
                <span class="text-slate-700">{{ i.complaint }}</span>
              </div>
              <div class="tabular text-xs text-slate-500">{{ i.vitalsText }}・到院 {{ atText(i.arrivedAt) }}・檢傷 {{ i.triagedByName }}<span v-if="i.reason" class="text-amber-800">・調整：{{ i.reason }}</span></div>
              <div v-if="i.labs" class="flex flex-wrap items-center gap-1 text-xs"><span :class="i.labs.toCollect ? 'font-semibold text-amber-800' : 'text-slate-600'">檢驗：{{ labText(i.labs) }}</span><UBadge v-if="i.labs.fresh" tone="blue">新報告 {{ i.labs.fresh }}</UBadge></div>
              <div v-if="i.dispositionText" class="text-xs text-slate-600">去向：{{ i.dispositionText }}<template v-if="i.obs?.endText">；{{ i.obs.endText }}</template></div>
            </div>
            <UBadge :tone="stageTone(i)">{{ i.stageLabel }}<template v-if="i.stage === 'bed'">・等 {{ i.bedWaitMinutes }} 分</template><template v-if="i.stage === 'obs'">・{{ i.obs?.bedNo }}</template></UBadge>
            <span v-if="i.stage === 'obs' && i.obs" :class="['tabular whitespace-nowrap text-xs', i.obs.long ? 'font-semibold text-red-700' : 'text-slate-500']" :title="i.obs.overdue ? '超過 48 小時：請決定去向' : undefined">留觀 {{ i.obs.hours }} 小時</span>
            <span v-if="i.stage === 'waiting' || i.stage === 'seeing'" :class="['tabular whitespace-nowrap text-xs', i.wait.overdue ? 'font-semibold text-red-700' : 'text-slate-500']">
              {{ i.stage === 'waiting' ? '等' : '等了' }} {{ i.wait.minutes }} 分／目標 {{ i.wait.target || '立即' }}{{ i.wait.target ? ' 分' : '' }}
            </span>
            <span class="flex gap-1.5">
              <UButton v-if="i.labs" size="sm" :variant="(board.canTriage && i.labs.toCollect) || (board.canDispose && i.labs.fresh) ? 'primary' : 'secondary'" @click="labVisit = i.visitId">檢驗</UButton>
              <UButton v-if="board.canTriage && i.stage === 'waiting'" size="sm" variant="secondary" @click="openRe(i)">重新檢傷</UButton>
              <UButton v-if="board.canDispose && i.stage === 'deciding'" size="sm" @click="openDis(i)">決定去向</UButton>
              <UButton v-if="board.canTriage && i.stage === 'obs-bed'" size="sm" @click="openBed(i)">排留觀床</UButton>
              <UButton v-if="board.canTriage && i.stage === 'obs'" size="sm" variant="secondary" @click="router.push({ name: 'nursing', query: { ward: masterApi.staticCodes.obsWard, admission: i.admissionId } })">護理站</UButton>
              <UButton v-if="board.canDispose && i.stage === 'obs'" size="sm" variant="secondary" @click="router.push({ name: 'ipd', query: { admission: i.admissionId } })">留觀醫囑</UButton>
              <UButton v-if="board.canDispose && i.stage === 'obs'" size="sm" @click="openEnd(i)">結束留觀</UButton>
            </span>
          </li>
        </ul>
        <details v-if="done.length" class="rounded-md border border-slate-200 bg-white p-3 text-sm">
          <summary class="cursor-pointer text-slate-600">最近 24 小時已離開急診 {{ done.length }} 位</summary>
          <ul class="mt-2 divide-y divide-slate-100">
            <li v-for="i in done" :key="i.visitId" class="py-1 text-xs text-slate-600">
              <span :class="['mr-1 inline-block w-5 rounded text-center font-bold', LEVEL_CLASS[i.level]]">{{ i.level }}</span>{{ i.arrivedAt.slice(5) }} {{ i.patientName }}・{{ i.complaint }}・{{ i.stageLabel }}<span v-if="i.dispositionText">（{{ i.dispositionText }}）</span>
            </li>
          </ul>
        </details>
      </template>
    </UQueryState>

    <UDialog v-model="triOpen" title="急診檢傷掛號" size="lg" @submit="submitTri">
      <div class="space-y-3 text-sm">
        <div v-if="!patient" class="space-y-1">
          <UInput v-model="keyword" label="找病人（病歷號、姓名、身分證、電話）" autocomplete="off" />
          <ul v-if="found?.length" class="max-h-40 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200">
            <li v-for="p in found" :key="p.id"><button type="button" class="w-full px-2 py-1 text-left hover:bg-slate-50" @click="patient = p">{{ p.chartNo }} {{ p.name }}・{{ p.gender === 'M' ? '男' : '女' }} {{ ageText(p.birthDate) }}</button></li>
          </ul>
          <p class="text-xs text-slate-500">沒有資料的新病人請先到「病患資料」建檔。</p>
        </div>
        <div v-else class="flex items-center gap-2 rounded bg-slate-50 px-3 py-2">
          <b>{{ patient.name }}</b><span class="text-slate-600">{{ patient.chartNo }}・{{ patient.gender === 'M' ? '男' : '女' }} {{ ageText(patient.birthDate) }}</span>
          <span v-if="patient.allergies.length" class="font-semibold text-red-700">過敏：{{ patient.allergies.join('、') }}</span>
          <button type="button" class="ml-auto text-xs text-brand-700 underline" @click="patient = undefined">換人</button>
        </div>
        <template v-if="patient">
          <UInput v-model="tri.complaint" label="主訴" required :error="register.fieldErrors.value.complaint" />
          <div class="flex flex-wrap gap-1.5">
            <button v-for="c in ER_COMPLAINTS" :key="c.text" type="button" class="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100" @click="tri.complaint = c.text">{{ c.text }}</button>
          </div>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <UInput v-for="f in VITAL_FIELDS" :key="f.key" :model-value="vitals[f.key]" type="number" :step="f.step" :label="f.label" :error="register.fieldErrors.value[f.key]" @update:model-value="(v) => setV(f.key, v)" />
          </div>
          <div class="rounded-md border border-slate-200 p-3">
            <div class="mb-2 text-slate-700">建議 <b>{{ sug.level }} 級（{{ TRIAGE_LABEL[sug.level] }}）</b><span class="text-xs text-slate-500">：依{{ sug.why }}</span></div>
            <div class="flex flex-wrap gap-2">
              <button v-for="l in TRIAGE_LEVELS" :key="l" type="button" :disabled="l > sug.level"
                :class="['rounded-md border px-3 py-1.5 text-sm', tri.level === l ? `${LEVEL_CLASS[l]} border-transparent` : 'border-slate-300', l > sug.level && 'cursor-not-allowed opacity-40']" @click="tri.level = l">
                {{ l }} 級 {{ TRIAGE_LABEL[l] }}
              </button>
            </div>
            <p v-if="register.fieldErrors.value.level" class="mt-1 text-xs text-red-600">{{ register.fieldErrors.value.level }}</p>
            <UTextarea v-if="tri.level && tri.level < sug.level" v-model="tri.reason" class="mt-2" label="調升原因（比建議嚴重）" :rows="2" required :error="register.fieldErrors.value.reason" />
            <p class="mt-1 text-xs text-slate-500">不能比建議輕；看起來比數字嚴重（例：冒冷汗、臉色蒼白）可以調升，要寫原因。</p>
          </div>
        </template>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="triOpen = false">取消</UButton>
        <UButton type="submit" :disabled="!patient || !tri.level" :loading="register.pending.value">檢傷掛號</UButton>
      </template>
    </UDialog>

    <UDialog v-model="reOpen" :title="`重新檢傷：${re?.patientName ?? ''}`" size="sm" @submit="submitRe">
      <div v-if="re" class="space-y-3 text-sm">
        <p class="text-slate-600">目前 {{ re.level }} 級・{{ re.complaint }}</p>
        <div class="flex flex-wrap gap-2">
          <button v-for="l in TRIAGE_LEVELS" :key="l" type="button" :class="['rounded-md border px-3 py-1 text-sm', reForm.level === l ? `${LEVEL_CLASS[l]} border-transparent` : 'border-slate-300']" @click="reForm.level = l">{{ l }} 級</button>
        </div>
        <p v-if="reAct.fieldErrors.value.level" class="text-xs text-red-600">{{ reAct.fieldErrors.value.level }}</p>
        <UTextarea v-model="reForm.reason" label="原因" :rows="2" required :error="reAct.fieldErrors.value.reason" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="reOpen = false">取消</UButton>
        <UButton type="submit" :loading="reAct.pending.value">重新檢傷</UButton>
      </template>
    </UDialog>

    <UDialog v-model="bedOpen" :title="`排留觀床：${bedFor?.patientName ?? ''}`" size="sm" @submit="submitBed">
      <div class="space-y-2 text-sm">
        <p v-if="!emptyObsBeds.length" class="rounded bg-amber-50 px-2 py-1 text-amber-800">留觀床都滿了（或在清潔中）：清潔完成後再排。</p>
        <div v-else class="flex flex-wrap gap-2">
          <label v-for="b in emptyObsBeds" :key="b.id" :class="['cursor-pointer rounded-md border-2 px-3 py-1.5', bedPick === b.id ? 'border-brand-500 bg-brand-50' : 'border-slate-200']">
            <input v-model="bedPick" type="radio" :value="b.id" class="sr-only" />{{ b.bedNo }}
          </label>
        </div>
        <p class="text-xs text-slate-500">排床後產生住院號、印腕帶（給藥要掃）。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="bedOpen = false">取消</UButton>
        <UButton type="submit" :disabled="!bedPick" :loading="assign.pending.value">排床</UButton>
      </template>
    </UDialog>

    <UDialog v-model="endOpen" :title="`結束留觀：${endFor?.patientName ?? ''}`" @submit="submitEnd">
      <div v-if="endFor" class="space-y-3 text-sm">
        <p class="text-slate-600">{{ endFor.obs?.bedNo }}・已留觀 {{ endFor.obs?.hours }} 小時</p>
        <fieldset class="flex gap-4">
          <label class="flex items-center gap-1.5"><input v-model="endForm.kind" type="radio" value="home" class="h-4 w-4 text-brand-600" />離院</label>
          <label class="flex items-center gap-1.5"><input v-model="endForm.kind" type="radio" value="admit" class="h-4 w-4 text-brand-600" />收住院</label>
          <label class="flex items-center gap-1.5"><input v-model="endForm.kind" type="radio" value="transfer" class="h-4 w-4 text-brand-600" />轉院</label>
        </fieldset>
        <template v-if="endForm.kind === 'admit'">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <USelect v-model="endForm.deptId" label="住院科別" required :options="inpatientDepts" placeholder="選擇科別" :error="endAct.fieldErrors.value.deptId" @update:model-value="endForm.doctorId = ''" />
            <USelect v-model="endForm.doctorId" label="主治醫師" required :options="endDoctors" placeholder="選擇醫師" :error="endAct.fieldErrors.value.doctorId" />
          </div>
          <UInput v-model="endForm.diagnosis" label="入院診斷" required :error="endAct.fieldErrors.value.diagnosis" />
          <USelect v-model="endForm.bedId" label="一併轉到病房的床" :options="wardBedOptions" />
          <p class="text-xs text-slate-500">同一筆住院直接轉成一般住院：住院號、腕帶不變，留觀時開的醫囑延續（新主治可以停）。急診與留觀的費用併入住院帳單。</p>
        </template>
        <template v-else>
          <template v-if="endForm.kind === 'transfer'">
            <UInput v-model="endForm.hospital" label="轉往醫院" required :error="endAct.fieldErrors.value.hospital" />
            <div class="flex flex-wrap gap-1.5"><button v-for="h in ER_TRANSFER_HOSPITALS" :key="h" type="button" class="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100" @click="endForm.hospital = h">{{ h }}</button></div>
          </template>
          <p class="text-xs text-slate-500">醫囑停止、留觀床改清潔中；急診與留觀期間的藥、檢驗處置一起到批價結帳。</p>
        </template>
        <UInput v-model="endForm.note" :label="endForm.kind === 'transfer' ? '轉院原因' : '備註（選填）'" :required="endForm.kind === 'transfer'" :error="endAct.fieldErrors.value.note" />
        <label v-if="endAct.fieldErrors.value.confirmUnfinished" class="flex items-start gap-2 rounded bg-amber-50 px-2 py-1.5 text-amber-900">
          <input v-model="endForm.confirm" type="checkbox" class="mt-0.5 h-4 w-4" />{{ endAct.fieldErrors.value.confirmUnfinished }}（勾選後再按確定：逾時沒給的藥標「暫停」保留紀錄）
        </label>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="endOpen = false">取消</UButton>
        <UButton type="submit" :loading="endAct.pending.value">確定</UButton>
      </template>
    </UDialog>

    <WristbandDialog v-model="wristbandOpen" :admission-id="wristbandFor" />
    <ErLabDialog v-model="labOpen" :visit-id="labVisit" />

    <UDialog v-model="disOpen" :title="`決定去向：${dis?.patientName ?? ''}`" @submit="submitDis">
      <div v-if="dis" class="space-y-3 text-sm">
        <fieldset class="flex gap-4">
          <label class="flex items-center gap-1.5"><input v-model="disForm.kind" type="radio" value="home" class="h-4 w-4 text-brand-600" />離院</label>
          <label class="flex items-center gap-1.5"><input v-model="disForm.kind" type="radio" value="obs" class="h-4 w-4 text-brand-600" />留觀</label>
          <label class="flex items-center gap-1.5"><input v-model="disForm.kind" type="radio" value="admit" class="h-4 w-4 text-brand-600" />收住院</label>
          <label class="flex items-center gap-1.5"><input v-model="disForm.kind" type="radio" value="transfer" class="h-4 w-4 text-brand-600" />轉院</label>
        </fieldset>
        <template v-if="disForm.kind === 'admit'">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <USelect v-model="disForm.deptId" label="住院科別" required :options="inpatientDepts" placeholder="選擇科別" :error="disAct.fieldErrors.value.deptId" @update:model-value="disForm.doctorId = ''" />
            <USelect v-model="disForm.doctorId" label="主治醫師" required :options="deptDoctors" placeholder="選擇醫師" :error="disAct.fieldErrors.value.doctorId" />
          </div>
          <UInput v-model="disForm.diagnosis" label="入院診斷" required :error="disAct.fieldErrors.value.diagnosis" />
          <p class="text-xs text-slate-500">建立今天的住院預約（標「急診」）；住院中心有床就報到，沒床在看板標「待床」。急診的費用併入住院帳單（「急診」一段），不在批價結。</p>
        </template>
        <template v-if="disForm.kind === 'obs'">
          <UInput v-model="disForm.diagnosis" label="留觀診斷（選填，空白用看診的主診斷）" />
          <p class="text-xs text-slate-500">由你擔任留觀醫師；護理師排留觀床（OB1–OB6）後開始，在「住院醫囑」開醫囑、護理站「急診留觀區」給藥與記錄。結束時再決定離院、收住院（不重新報到）或轉院；費用在結束後一起算。</p>
        </template>
        <template v-if="disForm.kind === 'transfer'">
          <UInput v-model="disForm.hospital" label="轉往醫院" required :error="disAct.fieldErrors.value.hospital" />
          <div class="flex flex-wrap gap-1.5"><button v-for="h in ER_TRANSFER_HOSPITALS" :key="h" type="button" class="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100" @click="disForm.hospital = h">{{ h }}</button></div>
        </template>
        <UInput v-model="disForm.note" :label="disForm.kind === 'transfer' ? '轉院原因' : '備註（選填）'" :required="disForm.kind === 'transfer'" :error="disAct.fieldErrors.value.note" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="disOpen = false">取消</UButton>
        <UButton type="submit" :loading="disAct.pending.value">確定</UButton>
      </template>
    </UDialog>
  </div>
</template>
