<script setup lang="ts">
// 急救（Code Blue）：護理站與住院醫囑的「急救」分頁共用。
//   - 沒在急救：「啟動急救」（確認一次）、以前的急救紀錄（ROSC 後醫師可以一鍵申請轉加護病房）
//   - 急救中：DNR 限制、腎上腺素計時、事件按鈕（DNR 擋的直接停用並說明）、時間軸、結束（ROSC、宣告死亡、依 DNR 不施行）
// 每 15 秒重新查一次（腎上腺素 3–5 分鐘的提示跟著時間走）
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { UBadge, UButton, UDialog, UInput, USelect } from '@/components/ui'
import { CODE_EVENT_LABEL, CODE_OUTCOME_LABEL, CODE_RHYTHMS, codeApi, dnrBlockText, isShockable, rhythmLabel, type CodeOutcome } from '@/services'
import type { CodeEventKind } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'

const props = defineProps<{ admissionId: string }>()
const emit = defineEmits<{ changed: [] }>()
const auth = useAuth()
const { data, reload } = useQuery(() => codeApi.patientCode(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const act = computed(() => v.value?.active)
const timer = setInterval(() => act.value && reload(), 15000)
onUnmounted(() => clearInterval(timer))
const hm = (s?: string) => s?.slice(11, 16) ?? ''
const isDoctor = computed(() => auth.user?.role === 'doctor')

// 啟動
const startOpen = ref(false)
const startAct = useAction(codeApi.startCode, { success: '已啟動急救：全院畫面上方會顯示' })
async function start() {
  if (await startAct.run(props.admissionId)) {
    startOpen.value = false
    reload()
    emit('changed')
  }
}
const leadAct = useAction(codeApi.leadCode, { success: '你是帶領醫師' })
async function lead() {
  if (act.value && (await leadAct.run(act.value.id))) reload()
}

// 事件
const f = reactive({ rhythm: '' as string, joules: 200 as number | undefined, note: '' })
watch(() => props.admissionId, () => Object.assign(f, { rhythm: '', joules: 200, note: '' }))
const evAct = useAction(codeApi.addCodeEvent)
async function add(kind: CodeEventKind) {
  if (!act.value) return
  const ok = await evAct.run(act.value.id, { kind, ...(kind === 'rhythm' ? { rhythm: f.rhythm as never } : {}), ...(kind === 'shock' ? { joules: Number(f.joules) } : {}), ...(kind === 'note' ? { note: f.note } : {}) })
  if (ok) {
    if (kind === 'note') f.note = ''
    if (kind === 'rhythm') f.rhythm = ''
    reload()
  }
}
const blockOf = (k: CodeEventKind) => dnrBlockText(k, v.value?.withhold)
const needLeader = (k: CodeEventKind) => ['shock', 'epi', 'amio', 'intubate'].includes(k) && !act.value?.leaderId

// 結束
const endAct = useAction(codeApi.endCode, { success: (c) => `急救結束：${CODE_OUTCOME_LABEL[c.outcome!]}` })
const ending = ref<CodeOutcome>()
const endOpen = computed({ get: () => !!ending.value, set: (x) => !x && (ending.value = undefined) })
async function end() {
  if (act.value && ending.value && (await endAct.run(act.value.id, { outcome: ending.value }))) {
    ending.value = undefined
    reload()
    emit('changed')
  }
}
const canDnrEnd = computed(() => !!v.value?.withhold.includes('compress') && !act.value?.events.some((e) => e.kind === 'cpr'))

// ROSC 後申請轉加護病房
const icuNote = ref('')
const icuOpen = ref(false)
const icuAct = useAction(codeApi.requestIcuAfterCode, { success: '已送出轉入加護病房申請（等加護病房主治同意）' })
async function reqIcu() {
  if (v.value?.icuAfter && (await icuAct.run(v.value.icuAfter, { note: icuNote.value }))) {
    icuOpen.value = false
    reload()
  }
}
const epiText = computed(() => {
  const e = act.value?.epi
  if (!e) return ''
  if (e.status === 'none') return '腎上腺素：還沒給'
  return `腎上腺素：上一劑 ${hm(e.last)}${e.status === 'overdue' ? '，已超過 5 分鐘' : e.status === 'due' ? '，滿 3 分鐘可以再給' : '（3–5 分鐘一次）'}`
})
const eventButtons: CodeEventKind[] = ['cpr', 'epi', 'amio', 'intubate', 'bvm']
const label = (k: CodeEventKind) => (k === 'amio' ? `Amiodarone ${act.value?.nextAmioMg ?? ''} mg` : k === 'epi' ? 'Epinephrine 1 mg' : CODE_EVENT_LABEL[k].replace('（胸外按壓）', ''))
</script>

<template>
  <div v-if="v" class="space-y-4 p-4 text-sm">
    <p v-if="v.dnr" class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900"><b>DNR</b>：{{ v.dnr.label }}（急救時擋下對應的處置）</p>

    <!-- 急救中 -->
    <section v-if="act" class="space-y-3 rounded-md border-2 border-red-500 bg-red-50/40 p-3">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-base font-bold text-red-700">急救進行中 {{ act.minutes }} 分鐘</span>
        <span class="text-xs text-slate-600">{{ hm(act.startedAt) }} {{ act.startedByName }}啟動・{{ act.leaderName ? `${act.leaderName}帶領` : '還沒有醫師帶領' }}</span>
        <UBadge v-if="act.rhythm" :tone="isShockable(act.rhythm) ? 'red' : 'purple'">{{ rhythmLabel(act.rhythm) }}</UBadge>
        <UButton v-if="isDoctor && act.leaderId !== auth.user?.id" class="ml-auto" size="sm" :loading="leadAct.pending.value" @click="lead">由我帶領</UButton>
      </div>
      <p v-if="epiText" :class="['font-semibold', act.epi?.status === 'overdue' ? 'text-red-700' : act.epi?.status === 'due' ? 'text-amber-700' : 'text-slate-600']">{{ epiText }}</p>
      <p v-if="evAct.fieldErrors.value.kind" class="rounded bg-red-100 px-2 py-1 text-red-800">{{ evAct.fieldErrors.value.kind }}</p>
      <div class="flex flex-wrap items-end gap-2">
        <UButton v-for="k in eventButtons" :key="k" size="sm" :variant="k === 'cpr' ? 'danger' : 'secondary'" :disabled="!!blockOf(k) || needLeader(k) || (k === 'cpr' && act.events.some((e) => e.kind === 'cpr')) || (k === 'amio' && !act.nextAmioMg)" :title="blockOf(k) ?? (needLeader(k) ? '要先有醫師帶領（口頭醫囑）' : '')" :loading="evAct.pending.value" @click="add(k)">{{ label(k) }}</UButton>
      </div>
      <div class="flex flex-wrap items-end gap-2">
        <div class="w-48"><USelect v-model="f.rhythm" label="心律" :options="[{ label: '請選', value: '' }, ...CODE_RHYTHMS.map((r) => ({ label: r.label, value: r.key }))]" :error="evAct.fieldErrors.value.rhythm" /></div>
        <UButton size="sm" variant="secondary" @click="add('rhythm')">記心律</UButton>
        <div class="w-28"><UInput v-model="f.joules" type="number" label="能量 J" :error="evAct.fieldErrors.value.joules" /></div>
        <UButton size="sm" variant="secondary" :disabled="!!blockOf('shock') || needLeader('shock') || !isShockable(act.rhythm)" :title="blockOf('shock') ?? (needLeader('shock') ? '要先有醫師帶領' : !isShockable(act.rhythm) ? '目前心律不可電擊（VF、pVT 才能）' : '')" @click="add('shock')">電擊</UButton>
        <div class="min-w-[12rem] flex-1"><UInput v-model="f.note" label="備註" :error="evAct.fieldErrors.value.note" placeholder="例：抽血 K 2.6，給 KCl" /></div>
        <UButton size="sm" variant="ghost" @click="add('note')">記下</UButton>
      </div>
      <ol class="tabular space-y-0.5 border-t border-red-200 pt-2">
        <li v-for="e in [...act.events].reverse()" :key="e.id"><span class="inline-block w-12 font-semibold">{{ hm(e.at) }}</span><span class="inline-block w-12 text-xs text-slate-500">+{{ e.minute }} 分</span>{{ e.text }}<span class="ml-2 text-xs text-slate-500">{{ e.byName }}</span></li>
        <li v-if="!act.events.length" class="text-slate-500">還沒有事件</li>
      </ol>
      <div class="flex flex-wrap gap-2 border-t border-red-200 pt-2">
        <UButton size="sm" @click="ending = 'rosc'">恢復自主循環 ROSC</UButton>
        <UButton v-if="isDoctor" size="sm" variant="secondary" @click="ending = 'death'">宣告死亡</UButton>
        <UButton v-if="canDnrEnd" size="sm" variant="secondary" @click="ending = 'dnr'">依 DNR 不施行急救</UButton>
      </div>
    </section>

    <section v-else class="flex flex-wrap items-center gap-2">
      <UButton v-if="v.canStart" variant="danger" @click="startOpen = true">啟動急救</UButton>
      <span class="text-xs text-slate-500">啟動後全院畫面上方顯示紅色橫幅；醫師「帶領」後才能記急救藥、電擊、插管（口頭醫囑記在帶領醫師名下，藥自動開醫囑扣帳）。</span>
      <UButton v-if="v.icuAfter" class="ml-auto" size="sm" @click="icuNote = ''; icuOpen = true">急救後申請轉加護病房</UButton>
    </section>

    <!-- 以前的急救 -->
    <section v-for="c in v.history" :key="c.id" class="rounded-md border border-slate-200 p-3">
      <div class="flex flex-wrap items-center gap-2">
        <b class="text-slate-700">{{ c.startedAt.slice(5, 16).replace('-', '/') }} 急救 {{ c.minutes }} 分鐘</b>
        <UBadge :tone="c.outcome === 'rosc' ? 'green' : c.outcome === 'death' ? 'red' : 'gray'">{{ CODE_OUTCOME_LABEL[c.outcome!] }}</UBadge>
        <span class="text-xs text-slate-500">{{ c.leaderName ? `${c.leaderName}帶領` : '' }}・{{ c.endedByName }}結束</span>
        <UBadge v-if="c.icuRequestStatus" tone="blue">轉加護病房：{{ { pending: '待同意', accepted: '候床中', declined: '不同意', cancelled: '已取消', placed: '已轉入' }[c.icuRequestStatus] }}</UBadge>
      </div>
      <ol class="tabular mt-1 space-y-0.5 text-xs text-slate-700">
        <li v-for="e in c.events" :key="e.id"><span class="inline-block w-10 font-semibold">{{ hm(e.at) }}</span><span class="inline-block w-12 text-slate-500">+{{ e.minute }} 分</span>{{ e.text }}<span class="ml-2 text-slate-500">{{ e.byName }}</span></li>
      </ol>
    </section>

    <UDialog v-model="startOpen" title="啟動急救？" size="sm" @submit="start">
      <p class="text-sm text-slate-700">全院畫面上方會顯示紅色橫幅，直到記錄結束（ROSC、宣告死亡或依 DNR 不施行）。</p>
      <p v-if="v.dnr" class="mt-1 text-sm text-amber-800">DNR：{{ v.dnr.label }}</p>
      <template #footer>
        <UButton variant="secondary" @click="startOpen = false">取消</UButton>
        <UButton type="submit" variant="danger" :loading="startAct.pending.value">啟動</UButton>
      </template>
    </UDialog>
    <UDialog v-model="endOpen" :title="`結束急救：${ending ? CODE_OUTCOME_LABEL[ending] : ''}`" size="sm" @submit="end">
      <p class="text-sm text-slate-700">結束時間記為現在。<template v-if="ending !== 'dnr' && act?.events.some((e) => e.kind === 'cpr')">會帶入一次心肺復甦術處置費。</template></p>
      <template #footer>
        <UButton variant="secondary" @click="endOpen = false">取消</UButton>
        <UButton type="submit" :variant="ending === 'death' ? 'danger' : 'primary'" :loading="endAct.pending.value">確定</UButton>
      </template>
    </UDialog>
    <UDialog v-model="icuOpen" title="急救後申請轉加護病房" size="sm" @submit="reqIcu">
      <p class="text-sm text-slate-600">類別「其他」，原因自動帶入這次急救的摘要（心律、CPR 時間、電擊、腎上腺素）。</p>
      <div class="mt-2"><UInput v-model="icuNote" label="補充（選填）" placeholder="例：血壓靠輸液維持，意識未恢復" /></div>
      <template #footer>
        <UButton variant="secondary" @click="icuOpen = false">取消</UButton>
        <UButton type="submit" :loading="icuAct.pending.value">送出申請</UButton>
      </template>
    </UDialog>
  </div>
</template>
