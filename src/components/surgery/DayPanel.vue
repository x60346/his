<script setup lang="ts">
// 日間手術（手術室頁分頁）：這天的日間手術依階段排列——
//   待報到（護理師報到；ASA > 3 不能做日間）→ 術前準備、送手術室 → 手術室 → 恢復室第一期（Aldrete，在「恢復室」）
//   → 第二期：PADSS 評分、回家（陪同、衛教）；達不到由醫師轉住院（選病房床）→ 隔天電話追蹤。
// 醫師在這裡申請日間手術。所有條件都在服務層（day.ts、day-rules、surgery.markPrep／sendToOr）
import { computed, reactive, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import { admissionApi, ANESTHESIA_LABEL, dayApi, PADSS_ITEMS, PADSS_MIN, SIDE_LABEL, surgeryApi, type DayItem } from '@/services'
import type { AnesthesiaType, SurgeryPrepKey, SurgerySide } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { today } from '@/utils/date'

const date = ref(today())
const { data: board, loading } = useQuery(() => dayApi.dayBoard(date.value), [date])
const TONE: Record<string, 'yellow' | 'blue' | 'purple' | 'red' | 'green' | 'gray'> = { reserved: 'yellow', checkedIn: 'blue', inOr: 'red', pacu: 'purple', phase2: 'purple', out: 'green', converted: 'gray', cancelled: 'gray' }

// ---------- 報到、術前準備、送手術室 ----------
const checkIn = useAction(dayApi.checkInDay, { success: (x) => `已報到：${x.surgery.patientName}（${x.admitNo}）` })
const prepFor = ref<DayItem>()
const prepOpen = computed({ get: () => !!prepFor.value, set: (x) => !x && (prepFor.value = undefined) })
const prepForm = reactive<Record<string, { mode: 'done' | 'na'; reason: string }>>({})
function openPrep(x: DayItem) {
  for (const r of x.surgery.prepRows) prepForm[r.key] = { mode: r.key === 'blood' || r.key === 'abx' ? 'na' : 'done', reason: r.key === 'blood' ? '日間手術，預估失血少' : r.key === 'abx' ? '乾淨手術不需預防性抗生素' : '' }
  prepFor.value = x
}
const markAct = useAction(surgeryApi.markPrep)
const sendAct = useAction(surgeryApi.sendToOr, { success: '已送手術室' })
async function savePrep() {
  const x = prepFor.value
  if (!x) return
  for (const r of x.surgery.prepRows.filter((y) => !y.done)) {
    const v = prepForm[r.key]
    if (!(await markAct.run(x.surgery.id, r.key as SurgeryPrepKey, v.mode === 'na' ? { notNeeded: v.reason } : {}))) return
  }
  if (await sendAct.run(x.surgery.id)) prepFor.value = undefined
}

// ---------- PADSS、回家 ----------
const scoreFor = ref<string>()
const sf = reactive<Record<string, string | number | undefined>>({})
function openScore(x: DayItem) {
  for (const it of PADSS_ITEMS) sf[it.key] = ''
  scoreAct.fieldErrors.value = {}
  scoreFor.value = x.admissionId
}
const scoreAct = useAction(dayApi.recordPadss, { success: (x) => `PADSS ${x.latest?.total} 分` })
async function score() {
  if (scoreFor.value && (await scoreAct.run(scoreFor.value, Object.fromEntries(PADSS_ITEMS.map((it) => [it.key, sf[it.key] === '' ? undefined : Number(sf[it.key])]))))) scoreFor.value = undefined
}
const outFor = ref<DayItem>()
const outOpen = computed({ get: () => !!outFor.value, set: (x) => !x && (outFor.value = undefined) })
const of = reactive({ escort: '', teaching: false })
function openOut(x: DayItem) {
  Object.assign(of, { escort: '', teaching: false })
  outFor.value = x
}
const outAct = useAction(dayApi.dischargeDay, { success: '病人已回家：帳單請櫃台在住院結帳收' })
async function discharge() {
  if (outFor.value && (await outAct.run(outFor.value.admissionId, { escort: of.escort, teaching: of.teaching }))) outFor.value = undefined
}

// ---------- 醫師：轉住院、取消、申請 ----------
const convFor = ref<DayItem>()
const convOpen = computed({ get: () => !!convFor.value, set: (x) => !x && (convFor.value = undefined) })
const cf = reactive({ reason: '', bedId: '' as string | number | undefined })
const { data: beds } = useQuery(() => (convFor.value ? admissionApi.listBeds() : Promise.resolve([])), [convFor])
const bedOptions = computed(() => (beds.value ?? []).filter((b) => b.status === 'empty' && !/加護|留觀/.test(b.ward)).map((b) => ({ label: `${b.ward} ${b.bedNo}（${b.bedClass}）`, value: b.id })))
function openConv(x: DayItem) {
  Object.assign(cf, { reason: '', bedId: '' })
  convAct.fieldErrors.value = {}
  convFor.value = x
}
const convAct = useAction(dayApi.convertDay, { success: (x) => `已轉住院：${x.convertedText ?? ''}` })
async function convert() {
  if (convFor.value && (await convAct.run(convFor.value.admissionId, { reason: cf.reason, bedId: String(cf.bedId ?? '') }))) convFor.value = undefined
}
const cancelFor = ref<DayItem>()
const cancelOpen = computed({ get: () => !!cancelFor.value, set: (x) => !x && (cancelFor.value = undefined) })
const cancelReason = ref('')
const cancelAct = useAction(dayApi.cancelDaySurgery, { success: '已取消日間手術' })
async function cancel() {
  if (cancelFor.value && (await cancelAct.run(cancelFor.value.admissionId, cancelReason.value)) !== undefined) cancelFor.value = undefined
}

const reqOpen = ref(false)
const { data: opts } = useQuery(() => surgeryApi.surgeryOptions())
const rf = reactive({ keyword: '', patientId: '' as string | number | undefined, procId: '' as string | number | undefined, side: '' as string | number | undefined, anesthesia: 'local' as string | number | undefined, date: today(), estMinutes: 60 as number | string | undefined, diagnosis: '' })
const { data: found } = useQuery(() => (rf.keyword.trim().length >= 1 ? dayApi.dayPatientSearch(rf.keyword) : Promise.resolve([])), [() => rf.keyword])
function openReq() {
  Object.assign(rf, { keyword: '', patientId: '', procId: '', side: '', anesthesia: 'local', date: today(), estMinutes: 60, diagnosis: '' })
  reqAct.fieldErrors.value = {}
  reqOpen.value = true
}
const reqAct = useAction(dayApi.requestDaySurgery, { success: (s) => `已申請日間手術：${s.patientName} ${s.procName}（${s.requestedDate}）` })
async function request() {
  const ok = await reqAct.run({ patientId: String(rf.patientId ?? ''), procId: String(rf.procId ?? ''), side: String(rf.side ?? '') as SurgerySide, anesthesia: String(rf.anesthesia ?? '') as AnesthesiaType, date: rf.date, estMinutes: Number(rf.estMinutes), diagnosis: rf.diagnosis })
  if (ok) reqOpen.value = false
}

// ---------- 電話追蹤 ----------
const fuFor = ref<DayItem>()
const fuOpen = computed({ get: () => !!fuFor.value, set: (x) => !x && (fuFor.value = undefined) })
const ff = reactive({ reached: 'yes' as string | number | undefined, ok: 'yes' as string | number | undefined, note: '' })
function openFu(x: DayItem) {
  Object.assign(ff, { reached: 'yes', ok: 'yes', note: '' })
  fuAct.fieldErrors.value = {}
  fuFor.value = x
}
const fuAct = useAction(dayApi.recordDayFollowUp, { success: '已記錄電話追蹤' })
async function followUp() {
  if (fuFor.value && (await fuAct.run(fuFor.value.admissionId, { reached: ff.reached === 'yes', ...(ff.reached === 'yes' ? { ok: ff.ok === 'yes' } : {}), note: ff.note }))) fuFor.value = undefined
}
</script>

<template>
  <div class="space-y-3 text-sm">
    <div class="flex flex-wrap items-center gap-3">
      <input v-model="date" type="date" class="form-control w-44" aria-label="日期" />
      <p class="text-xs text-slate-500">當天報到、當天回家：ASA ≤ 3；回家要 PADSS ≥ {{ PADSS_MIN }}、成人陪同、出院衛教</p>
      <UButton v-if="board?.canRequest" size="sm" class="ml-auto" :icon="Plus" @click="openReq">申請日間手術</UButton>
    </div>
    <UQueryState :loading="loading && !board" :ready="!!board">
      <template v-if="board">
        <section v-if="board.followUps.length" class="rounded-md border border-amber-300 bg-amber-50/50 p-3">
          <h3 class="mb-1 font-semibold text-amber-900">回家後待電話追蹤 {{ board.followUps.length }}</h3>
          <ul class="divide-y divide-amber-100">
            <li v-for="x in board.followUps" :key="x.admissionId" class="flex flex-wrap items-center gap-2 py-1.5">
              <b>{{ x.surgery.patientName }}</b><span class="text-xs text-slate-600">{{ x.surgery.procName }}・{{ x.outText }}</span>
              <span v-if="x.followUpText" class="text-xs text-amber-800">{{ x.followUpText }}</span>
              <UButton v-if="x.canFollowUp" size="sm" class="ml-auto" @click="openFu(x)">電話追蹤</UButton>
            </li>
          </ul>
        </section>
        <p v-if="!board.items.length" class="text-xs text-slate-400">這天沒有日間手術</p>
        <section v-for="x in board.items" :key="x.admissionId" class="space-y-1.5 rounded-md border border-slate-200 bg-white p-3">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge :tone="TONE[x.stage]">{{ x.stageLabel }}</UBadge>
            <span v-if="x.surgery.scheduleText" class="tabular text-xs font-semibold text-slate-700">{{ x.surgery.scheduleText }}</span>
            <span v-else class="text-xs text-amber-800">手術室還沒排程</span>
            <b>{{ x.surgery.patientName }}</b><span class="text-xs text-slate-500">{{ x.surgery.gender }} {{ x.surgery.age }}・{{ x.surgery.chartNo }}{{ x.admitNo ? `・${x.admitNo}` : '' }}</span>
            <span class="text-slate-700">{{ x.surgery.procName }}（{{ x.surgery.sideText }}）・{{ x.surgery.anesthesiaText }}・主刀 {{ x.surgery.doctorName }}</span>
            <UBadge v-if="x.asaTooHigh" tone="red">ASA {{ x.asa }}：不適合日間</UBadge>
            <UBadge v-else-if="x.asa" tone="gray">ASA {{ x.asa }}</UBadge>
            <UBadge v-else-if="x.stage === 'reserved'" tone="yellow">麻醉未評估</UBadge>
          </div>
          <div v-if="x.stage === 'phase2'" class="text-xs" :class="x.padssUnmet.length ? 'text-amber-800' : 'text-emerald-700'">
            {{ x.latest ? `最近評分 ${x.latest.at.slice(11)} ${x.latest.byName}・` : '' }}{{ x.padssUnmet.length ? `還不能回家：${x.padssUnmet.join('；')}` : '達到回家標準（回家時填陪同與衛教）' }}
          </div>
          <table v-if="x.padss.length && x.stage !== 'out'" class="text-xs">
            <tr class="text-slate-500"><th class="pr-3 text-left font-normal">時間</th><th v-for="it in PADSS_ITEMS" :key="it.key" class="px-1 font-normal">{{ it.label }}</th><th class="px-1 font-normal">合計</th></tr>
            <tr v-for="p in x.padss" :key="p.id" class="tabular text-center"><td class="pr-3 text-left">{{ p.at.slice(11) }}</td><td v-for="it in PADSS_ITEMS" :key="it.key">{{ p[it.key] }}</td><td :class="p.total < PADSS_MIN ? 'font-semibold text-red-700' : 'font-semibold text-emerald-700'">{{ p.total }}</td></tr>
          </table>
          <form v-if="scoreFor === x.admissionId" class="grid grid-cols-2 gap-2 rounded bg-slate-50 p-2 sm:grid-cols-5" @submit.prevent="score">
            <USelect v-for="it in PADSS_ITEMS" :key="it.key" v-model="sf[it.key]" :label="it.label" :options="it.options.map((o, i) => ({ label: `${i}：${o}`, value: i }))" placeholder="選擇" :error="scoreAct.fieldErrors.value[it.key]" />
            <div class="col-span-full flex justify-end gap-2"><UButton size="sm" variant="secondary" @click="scoreFor = undefined">取消</UButton><UButton type="submit" size="sm" :loading="scoreAct.pending.value">評分</UButton></div>
          </form>
          <p v-if="x.outText" class="text-xs text-emerald-700">{{ x.outText }}</p>
          <p v-if="x.convertedText" class="text-xs text-slate-600">{{ x.convertedText }}</p>
          <p v-if="x.followUpText" class="text-xs text-slate-600">{{ x.followUpText }}</p>
          <div class="flex flex-wrap justify-end gap-2">
            <UButton v-if="x.canCheckIn" size="sm" :disabled="x.asaTooHigh" :loading="checkIn.pending.value" @click="checkIn.run(x.admissionId)">報到</UButton>
            <UButton v-if="x.stage === 'checkedIn' && x.surgery.status === 'scheduled'" size="sm" variant="secondary" @click="openPrep(x)">術前準備・送手術室</UButton>
            <UButton v-if="x.canScore && scoreFor !== x.admissionId" size="sm" variant="secondary" @click="openScore(x)">評 PADSS</UButton>
            <UButton v-if="x.canDischarge" size="sm" :disabled="!!x.padssUnmet.length" @click="openOut(x)">回家</UButton>
            <UButton v-if="x.canConvert" size="sm" variant="secondary" @click="openConv(x)">轉住院</UButton>
            <UButton v-if="x.canCancel" size="sm" variant="ghost" class="text-red-700" @click="cancelFor = x; cancelReason = ''">取消</UButton>
          </div>
        </section>
      </template>
    </UQueryState>

    <UDialog v-model="prepOpen" :title="`術前準備：${prepFor?.surgery.patientName ?? ''}`" @submit="savePrep">
      <div v-if="prepFor" class="space-y-2">
        <div v-for="r in prepFor.surgery.prepRows" :key="r.key" class="flex flex-wrap items-center gap-3">
          <span class="w-24 font-medium text-slate-700">{{ r.label }}</span>
          <template v-if="r.done"><span class="text-xs text-emerald-700">{{ r.text }}</span></template>
          <template v-else>
            <label class="flex items-center gap-1"><input v-model="prepForm[r.key].mode" type="radio" value="done" class="h-4 w-4" :disabled="r.key === 'blood' || r.key === 'abx'" />已完成</label>
            <label v-if="r.optional" class="flex items-center gap-1"><input v-model="prepForm[r.key].mode" type="radio" value="na" class="h-4 w-4" />不需要</label>
            <div v-if="prepForm[r.key].mode === 'na'" class="min-w-[14rem] flex-1"><UInput v-model="prepForm[r.key].reason" placeholder="原因" /></div>
          </template>
        </div>
        <p class="text-xs text-slate-500">備血、預防性抗生素要連醫囑的，請病房流程開立；日間手術多半不需要（寫原因）。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="prepOpen = false">取消</UButton>
        <UButton type="submit" :loading="markAct.pending.value || sendAct.pending.value">記錄並送手術室</UButton>
      </template>
    </UDialog>

    <UDialog v-model="outOpen" :title="`回家：${outFor?.surgery.patientName ?? ''}`" size="sm" @submit="discharge">
      <div class="space-y-3">
        <p class="text-xs text-slate-600">PADSS {{ outFor?.latest?.total }} 分（{{ outFor?.latest?.at.slice(11) }}）</p>
        <UInput v-model="of.escort" label="陪同回家的成人（姓名與關係）" required placeholder="例：王小明（兒子）" />
        <UCheckbox v-model="of.teaching" label="已完成出院衛教（傷口照顧、止痛藥、何時回診、異常時回急診）" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="outOpen = false">取消</UButton>
        <UButton type="submit" :loading="outAct.pending.value">回家</UButton>
      </template>
    </UDialog>

    <UDialog v-model="convOpen" :title="`轉一般住院：${convFor?.surgery.patientName ?? ''}`" size="sm" @submit="convert">
      <div class="space-y-3">
        <UInput v-model="cf.reason" label="原因" required placeholder="例：疼痛控制不佳、尿滯留、沒有人陪同" :error="convAct.fieldErrors.value.reason" />
        <USelect v-model="cf.bedId" label="病房床位" :options="bedOptions" placeholder="選擇空床" :error="convAct.fieldErrors.value.bedId" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="convOpen = false">取消</UButton>
        <UButton type="submit" :loading="convAct.pending.value">轉住院</UButton>
      </template>
    </UDialog>

    <UDialog v-model="cancelOpen" :title="`取消日間手術：${cancelFor?.surgery.patientName ?? ''}`" size="sm" @submit="cancel">
      <UInput v-model="cancelReason" label="取消原因" required :error="cancelAct.fieldErrors.value.reason" />
      <template #footer>
        <UButton variant="secondary" @click="cancelOpen = false">返回</UButton>
        <UButton type="submit" variant="danger" :loading="cancelAct.pending.value">取消手術</UButton>
      </template>
    </UDialog>

    <UDialog v-model="fuOpen" :title="`電話追蹤：${fuFor?.surgery.patientName ?? ''}`" size="sm" @submit="followUp">
      <div class="space-y-3">
        <USelect v-model="ff.reached" label="有沒有聯絡上" :options="[{ label: '聯絡上了', value: 'yes' }, { label: '沒聯絡上', value: 'no' }]" />
        <USelect v-if="ff.reached === 'yes'" v-model="ff.ok" label="狀況" :options="[{ label: '沒有問題', value: 'yes' }, { label: '有問題', value: 'no' }]" :error="fuAct.fieldErrors.value.ok" />
        <UInput v-model="ff.note" :label="ff.reached === 'no' ? '打了幾次、之後怎麼處理' : '說明（有問題必填）'" :error="fuAct.fieldErrors.value.note" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="fuOpen = false">取消</UButton>
        <UButton type="submit" :loading="fuAct.pending.value">記錄</UButton>
      </template>
    </UDialog>

    <UDialog v-model="reqOpen" title="申請日間手術" @submit="request">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="sm:col-span-2"><UInput v-model="rf.keyword" label="找病人（病歷號或姓名）" /></div>
        <div class="sm:col-span-2"><USelect v-model="rf.patientId" label="病人" required :options="(found ?? []).map((p) => ({ label: `${p.name}（${p.chartNo}）${p.busy ? '・已住院或有預約' : ''}`, value: p.id, disabled: p.busy }))" placeholder="先輸入關鍵字" :error="reqAct.fieldErrors.value.patientId" /></div>
        <div class="sm:col-span-2"><USelect v-model="rf.procId" label="術式" required :options="(opts?.procs ?? []).map((p) => ({ label: p.name, value: p.id }))" placeholder="選擇術式" :error="reqAct.fieldErrors.value.procId" /></div>
        <USelect v-model="rf.side" label="左右側" required :options="(Object.keys(SIDE_LABEL) as SurgerySide[]).map((k) => ({ label: SIDE_LABEL[k], value: k }))" placeholder="選擇" :error="reqAct.fieldErrors.value.side" />
        <USelect v-model="rf.anesthesia" label="麻醉方式" required :options="(Object.keys(ANESTHESIA_LABEL) as AnesthesiaType[]).map((k) => ({ label: ANESTHESIA_LABEL[k], value: k }))" :error="reqAct.fieldErrors.value.anesthesia" />
        <UInput v-model="rf.date" type="date" label="手術日期" required :error="reqAct.fieldErrors.value.date" />
        <UInput v-model="rf.estMinutes" type="number" label="預估時間（分鐘）" required :error="reqAct.fieldErrors.value.estMinutes" />
        <div class="sm:col-span-2"><UInput v-model="rf.diagnosis" label="術前診斷" required :error="reqAct.fieldErrors.value.diagnosis" /></div>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="reqOpen = false">取消</UButton>
        <UButton type="submit" :loading="reqAct.pending.value">申請</UButton>
      </template>
    </UDialog>
  </div>
</template>
