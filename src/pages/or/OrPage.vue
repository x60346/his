<script setup lang="ts">
// 手術室：
//   - 排程：待排程清單（有「手術排程」權限的人可以排房間與時間，同房撞期、超過開放時段由服務層擋）；各房當天的手術
//   - 查核：點一台 → 麻醉前（Sign In）→ 劃刀前暫停確認（Time Out）→ 開始手術（沒暫停確認擋）→ 離開前（Sign Out）＋紗布器械計數 → 完成
// 病人的過敏、隔離、DNR 在每一台上都看得到；所有規則在服務層（surgery.ts、surgery-rules）
import { computed, reactive, ref, watch } from 'vue'
import { AlertTriangle, CalendarClock } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UPageHeader, UQueryState, USelect } from '@/components/ui'
import PatientFlags from '@/components/PatientFlags.vue'
import { CHECK_ITEMS, OR_ROOMS, surgeryApi, type SurgeryView } from '@/services'
import type { SurgeryCheckStage } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { today } from '@/utils/date'

const auth = useAuth()
const isNurse = computed(() => auth.user?.role === 'nurse')
const date = ref(today())
const { data, loading } = useQuery(() => surgeryApi.orBoard(date.value), [date])
const board = computed(() => (data.value?.date === date.value ? data.value : undefined))
const tone = (s: SurgeryView) => (s.status === 'done' ? 'green' : s.status === 'in-progress' ? 'red' : s.status === 'sent' ? 'purple' : s.status === 'scheduled' ? 'blue' : 'yellow')

// ---------- 排程 ----------
const scheduling = ref<SurgeryView>()
const schedOpen = computed({ get: () => !!scheduling.value, set: (x) => !x && (scheduling.value = undefined) })
const sch = reactive({ room: OR_ROOMS[0] as string | number | undefined, date: today(), time: '09:00' })
function openSched(s: SurgeryView) {
  Object.assign(sch, { room: s.schedule?.room ?? OR_ROOMS[0], date: s.schedule?.start.slice(0, 10) ?? (s.requestedDate < today() ? today() : s.requestedDate), time: s.schedule?.start.slice(11) ?? '09:00' })
  schedAct.fieldErrors.value = {}
  scheduling.value = s
}
const schedAct = useAction(surgeryApi.scheduleSurgery, { success: (s) => `已排程：${s.scheduleText}` })
async function submitSched() {
  if (scheduling.value && (await schedAct.run(scheduling.value.id, { room: String(sch.room), start: `${sch.date} ${sch.time}` }))) scheduling.value = undefined
}

// ---------- 查核 ----------
const caseId = ref<string>()
const current = computed(() => board.value?.cases.find((c) => c.id === caseId.value))
const caseOpen = computed({ get: () => !!current.value, set: (x) => !x && (caseId.value = undefined) })
const ticked = reactive<Record<SurgeryCheckStage, string[]>>({ signIn: [], timeOut: [], signOut: [] })
const counts = reactive({ spongeBefore: undefined as number | undefined, spongeAfter: undefined as number | undefined, instrumentBefore: undefined as number | undefined, instrumentAfter: undefined as number | undefined, mismatchReason: '' })
watch(caseId, () => {
  Object.assign(ticked, { signIn: [], timeOut: [], signOut: [] })
  Object.assign(counts, { spongeBefore: undefined, spongeAfter: undefined, instrumentBefore: undefined, instrumentAfter: undefined, mismatchReason: '' })
  for (const a of [checkAct, startAct, finishAct]) a.fieldErrors.value = {}
})
const tick = (st: SurgeryCheckStage, item: string, on: boolean) => (ticked[st] = on ? [...new Set([...ticked[st], item])] : ticked[st].filter((x) => x !== item))
const tickAll = (st: SurgeryCheckStage) => (ticked[st] = [...CHECK_ITEMS[st].items])
const checkAct = useAction(surgeryApi.recordCheck, { success: '查核完成' })
const startAct = useAction(surgeryApi.startSurgery, { success: '已開始手術（劃刀）' })
const finishAct = useAction(surgeryApi.finishSurgery, { success: '手術完成' })
const stageOpen = (s: SurgeryView, st: SurgeryCheckStage) =>
  isNurse.value && !s.checks[st] && (st === 'signIn' ? s.status === 'sent' : st === 'timeOut' ? s.status === 'sent' && !!s.checks.signIn : s.status === 'in-progress')
async function finish() {
  if (!current.value) return
  await finishAct.run(current.value.id, { items: ticked.signOut, spongeBefore: Number(counts.spongeBefore), spongeAfter: Number(counts.spongeAfter), instrumentBefore: Number(counts.instrumentBefore), instrumentAfter: Number(counts.instrumentAfter), mismatchReason: counts.mismatchReason })
}
const byRoom = (room: string) => (board.value?.cases ?? []).filter((c) => c.schedule?.room === room)
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="手術室" description="排程、送來的病人、三段安全查核（麻醉前、劃刀前暫停確認、離開前）">
      <input v-model="date" type="date" class="form-control w-44" aria-label="日期" />
    </UPageHeader>
    <UQueryState :loading="loading && !board" :ready="!!board">
      <template v-if="board">
        <section v-if="board.requested.length" class="rounded-md border border-amber-300 bg-amber-50/50 p-3 text-sm">
          <h3 class="mb-2 font-semibold text-amber-900">待排程 {{ board.requested.length }} 台</h3>
          <ul class="divide-y divide-amber-100">
            <li v-for="s in board.requested" :key="s.id" class="flex flex-wrap items-center gap-2 py-1.5">
              <b>{{ s.bedNo }} {{ s.patientName }}</b>
              <span>{{ s.procName }}（{{ s.sideText }}）・{{ s.anesthesiaText }}・{{ s.estMinutes }} 分</span>
              <span class="text-xs text-slate-500">預計 {{ s.requestedDate }}・主刀 {{ s.doctorName }}</span>
              <UButton v-if="board.canSchedule" size="sm" class="ml-auto" :icon="CalendarClock" @click="openSched(s)">排程</UButton>
            </li>
          </ul>
          <p v-if="!board.canSchedule" class="mt-1 text-xs text-slate-500">排程由有「手術排程」權限的人處理。</p>
        </section>

        <div class="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))]">
          <section v-for="room in board.rooms" :key="room" class="rounded-md border border-slate-200 bg-white p-3 text-sm">
            <h3 class="mb-2 font-semibold text-slate-700">{{ room }}</h3>
            <p v-if="!byRoom(room).length" class="text-xs text-slate-400">這天沒有排手術</p>
            <button v-for="s in byRoom(room)" :key="s.id" type="button" class="mb-2 block w-full rounded border border-slate-200 px-2 py-1.5 text-left hover:bg-slate-50" @click="caseId = s.id">
              <div class="flex items-center gap-1.5">
                <span class="tabular text-xs font-semibold text-slate-700">{{ s.schedule!.start.slice(11) }}–{{ s.scheduleEnd!.slice(11) }}</span>
                <UBadge :tone="tone(s)">{{ s.statusLabel }}</UBadge>
                <AlertTriangle v-if="s.countMismatch" class="h-3.5 w-3.5 text-red-600" />
              </div>
              <div class="font-medium text-slate-800">{{ s.patientName }}<span class="ml-1 text-xs font-normal text-slate-500">{{ s.bedNo }}</span></div>
              <div class="text-xs text-slate-600">{{ s.procName }}（{{ s.sideText }}）</div>
              <div v-if="s.prepMissing.length && s.status === 'scheduled'" class="text-xs text-amber-800">術前準備還差：{{ s.prepMissing.join('、') }}</div>
            </button>
          </section>
        </div>
      </template>
    </UQueryState>

    <UDialog v-model="schedOpen" :title="`排程：${scheduling?.patientName ?? ''}`" size="sm" @submit="submitSched">
      <div v-if="scheduling" class="space-y-3 text-sm">
        <p class="text-slate-600">{{ scheduling.procName }}（{{ scheduling.sideText }}）・預估 {{ scheduling.estMinutes }} 分・預計 {{ scheduling.requestedDate }}</p>
        <USelect v-model="sch.room" label="手術房" :options="OR_ROOMS" :error="schedAct.fieldErrors.value.room" />
        <div class="grid grid-cols-2 gap-3">
          <UInput v-model="sch.date" type="date" label="日期" />
          <UInput v-model="sch.time" type="time" label="開始時間" />
        </div>
        <p v-if="schedAct.fieldErrors.value.start" class="text-sm text-red-700">{{ schedAct.fieldErrors.value.start }}</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="schedOpen = false">取消</UButton>
        <UButton type="submit" :loading="schedAct.pending.value">排程</UButton>
      </template>
    </UDialog>

    <UDialog v-model="caseOpen" :title="current ? `${current.schedule?.room} ${current.patientName}：${current.procName}` : ''" size="lg">
      <div v-if="current" class="space-y-3 text-sm">
        <div class="space-y-1 rounded-md bg-slate-50 px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <b>{{ current.patientName }}</b><span class="text-slate-600">{{ current.gender }} {{ current.age }}・{{ current.chartNo }}・{{ current.bedNo }}</span>
            <UBadge :tone="tone(current)">{{ current.statusLabel }}</UBadge>
            <PatientFlags :flags="current.flags" />
          </div>
          <div>{{ current.procName }}・<b class="text-red-700">{{ current.sideText }}</b>・{{ current.anesthesiaText }}・主刀 {{ current.doctorName }}・術前診斷 {{ current.diagnosis }}</div>
          <div :class="current.allergies.length ? 'font-semibold text-red-700' : 'text-slate-500'">過敏：{{ current.allergies.length ? current.allergies.join('、') : '無已知過敏' }}</div>
          <div class="text-xs text-slate-600">術前準備：{{ current.prepRows.map((r) => `${r.label}${r.done ? '✓' : '✗'}`).join('　') }}</div>
        </div>
        <p v-if="current.status === 'scheduled'" class="text-amber-800">病房還沒送來（術前準備完成後由護理站「送手術室」）。</p>

        <section v-for="c in current.checkRows" :key="c.stage" :class="['rounded-md border p-3', c.done ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200']">
          <div class="flex items-center gap-2">
            <h4 class="font-semibold text-slate-700">{{ c.title }}</h4>
            <span v-if="c.done" class="text-xs text-emerald-700">完成・{{ c.text }}</span>
            <button v-if="stageOpen(current, c.stage as SurgeryCheckStage)" type="button" class="ml-auto text-xs text-brand-700 underline" @click="tickAll(c.stage as SurgeryCheckStage)">全部確認</button>
          </div>
          <template v-if="stageOpen(current, c.stage as SurgeryCheckStage)">
            <div class="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
              <UCheckbox v-for="it in c.items" :key="it" :model-value="ticked[c.stage as SurgeryCheckStage].includes(it)" :label="it" @update:model-value="(on) => tick(c.stage as SurgeryCheckStage, it, on)" />
            </div>
            <div v-if="c.stage === 'signOut'" class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <UInput v-model="counts.spongeBefore" type="number" label="紗布（術前）" :error="finishAct.fieldErrors.value.spongeBefore" />
              <UInput v-model="counts.spongeAfter" type="number" label="紗布（術後）" :error="finishAct.fieldErrors.value.spongeAfter" />
              <UInput v-model="counts.instrumentBefore" type="number" label="器械（術前）" :error="finishAct.fieldErrors.value.instrumentBefore" />
              <UInput v-model="counts.instrumentAfter" type="number" label="器械（術後）" :error="finishAct.fieldErrors.value.instrumentAfter" />
              <div class="col-span-2 sm:col-span-4"><UInput v-model="counts.mismatchReason" label="計數不符時：原因與處理（例：已照 X 光確認無遺留，已告知主刀）" :error="finishAct.fieldErrors.value.mismatchReason" /></div>
            </div>
            <p v-if="(c.stage === 'signOut' ? finishAct : checkAct).fieldErrors.value.items" class="mt-1 text-xs text-red-600">{{ (c.stage === 'signOut' ? finishAct : checkAct).fieldErrors.value.items }}</p>
            <div class="mt-2 text-right">
              <UButton v-if="c.stage !== 'signOut'" size="sm" :loading="checkAct.pending.value" @click="checkAct.run(current.id, c.stage as 'signIn' | 'timeOut', ticked[c.stage as SurgeryCheckStage])">完成{{ c.stage === 'signIn' ? '麻醉前查核' : '暫停確認' }}</UButton>
              <UButton v-else size="sm" :loading="finishAct.pending.value" @click="finish">完成查核，手術結束</UButton>
            </div>
          </template>
          <div v-if="c.stage === 'timeOut' && isNurse && current.status === 'sent'" class="mt-2 border-t border-slate-100 pt-2 text-right">
            <UButton size="sm" variant="danger" :disabled="!current.checks.timeOut" :loading="startAct.pending.value" @click="startAct.run(current.id)">開始手術（劃刀）</UButton>
            <p v-if="!current.checks.timeOut" class="mt-1 text-xs text-slate-500">暫停確認完成後才能開始。</p>
          </div>
        </section>
        <p v-if="current.startAt" class="tabular text-xs text-slate-600">劃刀 {{ current.startAt.slice(11) }}{{ current.endAt ? `・結束 ${current.endAt.slice(11)}` : '' }}</p>
        <p v-if="current.counts?.mismatchReason" class="rounded bg-red-50 px-2 py-1 text-xs font-semibold text-red-800">計數不符：{{ current.counts.mismatchReason }}</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="caseId = undefined">關閉</UButton>
      </template>
    </UDialog>
  </div>
</template>
