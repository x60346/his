<script setup lang="ts">
// 呼吸器與鎮靜（加護病房；住院醫囑與護理站的病人分頁共用）：
//   - 呼吸器：使用中的設定、開／改設定（改要寫原因）、停止（可一起拔管）；實測每 4 小時（護理師記在重症流程表）
//   - 鎮靜：醫師設 RASS 目標範圍；最近一次與趨勢（護理師記在重症流程表，每 4 小時）
//   - 每日脫離評估：插管接呼吸器的病人每天做 SAT（停鎮靜）→ 通過才做 SBT（自發呼吸）
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState, USelect, UTextarea } from '@/components/ui'
import { checkVentSetting, RASS_LEVELS, rassLabel, VENT_CHANGE_REASONS, VENT_FIELD, VENT_MODES, ventApi, WEAN_LABEL } from '@/services'
import type { VentMode, VentSetting, WeanResult } from '@/types'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ admissionId: string }>()
const emit = defineEmits<{ openFlowsheet: [] }>()
const { data, loading, reload } = useQuery(() => ventApi.patientVent(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const statusText = { ok: '', due: '（快到了）', overdue: '（逾時）' } as const
const vsText = { in: '在目標內', deep: '比目標深', light: '比目標淺' } as const

// ---------- 開／改呼吸器 ----------
type Form = { mode: VentMode | ''; fio2?: number; peep?: number; vt?: number; pinsp?: number; rr?: number; ps?: number; reason: string; reasonNote: string }
const f = reactive<Form>({ mode: '', reason: '', reasonNote: '' })
const ventOpen = ref(false)
function openVent() {
  const s = v.value?.order?.setting
  Object.assign(f, { mode: s?.mode ?? 'AC/VC', fio2: s?.fio2, peep: s?.peep, vt: s?.vt, pinsp: s?.pinsp, rr: s?.rr, ps: s?.ps, reason: '', reasonNote: '' })
  orderAct.fieldErrors.value = {}
  ventOpen.value = true
}
const modeMeta = computed(() => VENT_MODES.find((m) => m.mode === f.mode))
const fieldsOf = computed(() => ['fio2', 'peep', ...(modeMeta.value?.needs ?? []), ...(modeMeta.value?.optional ?? [])] as (keyof typeof VENT_FIELD)[])
const live = computed(() => (f.mode ? checkVentSetting({ ...f, mode: f.mode } as Partial<VentSetting>) : {}))
const orderAct = useAction(ventApi.orderVent, { success: (o) => `已開立：${o.text}` })
async function submitVent() {
  const reason = f.reason === '其他' ? f.reasonNote.trim() : f.reason
  const s = { mode: f.mode as VentMode, ...Object.fromEntries(fieldsOf.value.map((k) => [k, f[k] === undefined ? undefined : Number(f[k])])), ...(v.value?.order ? { changeReason: reason } : {}) } as VentSetting
  if (await orderAct.run(props.admissionId, s)) {
    ventOpen.value = false
    reload()
  }
}
// ---------- 停止 ----------
const stopOpen = ref(false)
const stopF = reactive({ reason: '', extubate: true })
const stopAct = useAction(ventApi.stopVent, { success: '已停止呼吸器' })
async function submitStop() {
  if (await stopAct.run(props.admissionId, { reason: stopF.reason, extubate: stopF.extubate })) {
    stopOpen.value = false
    reload()
  }
}
// ---------- 鎮靜目標 ----------
const rassOpts = RASS_LEVELS.map((x) => ({ label: rassLabel(x.score), value: x.score }))
const tgt = reactive({ min: -2 as number | string, max: 0 as number | string })
const tgtOpen = ref(false)
function openTarget() {
  Object.assign(tgt, { min: v.value?.rass?.target?.min ?? -2, max: v.value?.rass?.target?.max ?? 0 })
  tgtAct.fieldErrors.value = {}
  tgtOpen.value = true
}
const tgtAct = useAction(ventApi.setRassTarget, { success: '已設定鎮靜目標' })
async function submitTarget() {
  if (await tgtAct.run(props.admissionId, Number(tgt.min), Number(tgt.max))) {
    tgtOpen.value = false
    reload()
  }
}
// ---------- 脫離評估 ----------
const weanOpts = (Object.keys(WEAN_LABEL) as WeanResult[]).map((k) => ({ label: WEAN_LABEL[k], value: k }))
const wean = reactive({ sat: '' as WeanResult | '', sbt: '' as WeanResult | '', note: '' })
const weanOpen = ref(false)
function openWean() {
  Object.assign(wean, { sat: '', sbt: '', note: '' })
  weanAct.fieldErrors.value = {}
  weanOpen.value = true
}
const weanAct = useAction(ventApi.recordWean, { success: '已記錄脫離評估' })
async function submitWean() {
  if (await weanAct.run(props.admissionId, { sat: wean.sat as WeanResult, sbt: wean.sbt as WeanResult, note: wean.note })) {
    weanOpen.value = false
    reload()
  }
}
</script>

<template>
  <div class="space-y-4 p-4 text-sm">
    <UQueryState :loading="loading && !v" :ready="!!v">
      <template v-if="v">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-semibold text-slate-700">呼吸器與鎮靜</span>
          <UBadge v-if="v.intubation" tone="blue">氣管內管 {{ v.intubation.text }}・第 {{ v.intubation.day }} 天</UBadge>
          <UBadge v-else tone="gray">沒有插管</UBadge>
          <UButton v-if="v.canNurse" class="ml-auto" size="sm" variant="secondary" @click="emit('openFlowsheet')">到重症流程表記實測與 RASS</UButton>
        </div>
        <p v-if="!v.inIcu" class="rounded-md bg-slate-50 px-3 py-1.5 text-xs text-slate-600">病人目前不在加護病房：呼吸器醫囑與鎮靜目標限加護病房</p>
        <p v-if="v.dnrProblem" class="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-amber-900">{{ v.dnrProblem }}</p>

        <!-- 呼吸器 -->
        <section class="rounded-md border border-slate-200 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold text-slate-700">呼吸器</span>
            <template v-if="v.canDoctor && v.inIcu">
              <UButton class="ml-auto" size="sm" variant="secondary" @click="openVent">{{ v.order ? '改設定' : '開呼吸器' }}</UButton>
              <UButton v-if="v.order" size="sm" variant="ghost" class="text-red-700" @click="Object.assign(stopF, { reason: '', extubate: true }); stopAct.fieldErrors.value = {}; stopOpen = true">停止</UButton>
            </template>
          </div>
          <template v-if="v.order">
            <div class="tabular mt-1 text-base font-medium text-slate-800">{{ v.order.text }}</div>
            <div class="text-xs text-slate-500">{{ v.order.startAt.slice(5, 16).replace('-', '/') }} {{ v.order.doctorName }}<template v-if="v.order.changeReason">・改設定：{{ v.order.changeReason }}</template><span v-if="!v.order.acked" class="ml-1 text-amber-700">（護理師還沒核對）</span></div>
            <div v-if="v.check" :class="['mt-1 text-xs', v.check.status === 'overdue' ? 'font-semibold text-red-700' : v.check.status === 'due' ? 'text-amber-800' : 'text-slate-600']">
              實測（每 4 小時）：<template v-if="v.check.last">{{ v.check.lastAt!.slice(11) }} 尖峰壓 {{ v.check.last.ppeak }}・潮氣量 {{ v.check.last.vt }}・呼吸 {{ v.check.last.rr }}；</template>下次 {{ v.check.dueAt.slice(5).replace('-', '/') }}{{ statusText[v.check.status] }}
            </div>
          </template>
          <p v-else class="mt-1 text-slate-500">沒有使用中的呼吸器醫囑{{ v.canDoctor && v.inIcu && !v.intubation ? '（要先在「管路」登錄氣管內管）' : '' }}</p>
          <details v-if="v.history.length" class="mt-2 text-xs text-slate-600">
            <summary class="cursor-pointer text-slate-500">之前的設定 {{ v.history.length }} 筆</summary>
            <ul class="mt-1 space-y-0.5">
              <li v-for="h in v.history" :key="h.id" class="tabular">{{ h.startAt.slice(5, 16).replace('-', '/') }}–{{ h.stopAt?.slice(5, 16).replace('-', '/') ?? '' }}　{{ h.text }}<template v-if="h.changeReason">（{{ h.changeReason }}）</template></li>
            </ul>
          </details>
        </section>

        <!-- 鎮靜 -->
        <section v-if="v.rass" class="rounded-md border border-slate-200 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold text-slate-700">鎮靜（RASS）</span>
            <span class="text-slate-600">目標 {{ v.rass.target ? `${v.rass.target.min}～${v.rass.target.max}` : '未設定' }}</span>
            <UBadge v-if="v.rass.vs" :tone="v.rass.vs === 'in' ? 'green' : 'red'">{{ vsText[v.rass.vs] }}</UBadge>
            <UButton v-if="v.canDoctor" class="ml-auto" size="sm" variant="secondary" @click="openTarget">{{ v.rass.target ? '改目標' : '設目標' }}</UButton>
          </div>
          <div class="mt-1 text-xs" :class="v.rass.status === 'overdue' ? 'font-semibold text-red-700' : v.rass.status === 'due' ? 'text-amber-800' : 'text-slate-600'">
            <template v-if="v.rass.last">最近 {{ v.rass.last.at.slice(11) }} {{ v.rass.last.label }}（{{ v.rass.last.byName }}）；</template>下次 {{ v.rass.dueAt.slice(5).replace('-', '/') }}{{ statusText[v.rass.status] }}
          </div>
          <div v-if="v.rass.recent.length" class="tabular mt-1 flex flex-wrap gap-1 text-xs">
            <span v-for="r in v.rass.recent" :key="r.at" :class="['rounded px-1.5 py-0.5', v.rass.target && (r.score < v.rass.target.min || r.score > v.rass.target.max) ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-700']">{{ r.at.slice(11) }} {{ r.score > 0 ? '+' : '' }}{{ r.score }}</span>
          </div>
        </section>

        <!-- 每日脫離評估 -->
        <section v-if="v.order || v.wean.recent.length" class="rounded-md border border-slate-200 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold text-slate-700">每日脫離評估（SAT → SBT）</span>
            <UBadge v-if="v.wean.due" tone="yellow">今天還沒做</UBadge>
            <UBadge v-else-if="v.wean.today" :tone="v.wean.today.sbt === 'pass' ? 'green' : 'gray'">今天：{{ v.wean.today.text }}</UBadge>
            <UButton v-if="v.canDoctor && v.order && v.intubation" class="ml-auto" size="sm" variant="secondary" @click="openWean">記結果</UButton>
          </div>
          <ul v-if="v.wean.recent.length" class="mt-1 space-y-0.5 text-xs text-slate-600">
            <li v-for="w in v.wean.recent" :key="w.id" class="tabular">{{ w.at.slice(5, 16).replace('-', '/') }}　{{ w.text }}<template v-if="w.note">：{{ w.note }}</template>（{{ w.byName }}）</li>
          </ul>
          <p class="mt-1 text-xs text-slate-500">SAT：停鎮靜藥看會不會醒、能不能配合；通過才做 SBT（降到低支持自己呼吸 30–120 分鐘）。SBT 通過可以考慮拔管。</p>
        </section>
      </template>
    </UQueryState>

    <UDialog v-model="ventOpen" :title="v?.order ? '改呼吸器設定' : '開呼吸器醫囑'" @submit="submitVent">
      <div class="space-y-3">
        <div><USelect v-model="f.mode" label="模式" :options="VENT_MODES.map((m) => ({ label: `${m.mode}（${m.label}）`, value: m.mode }))" :error="orderAct.fieldErrors.value.mode" /></div>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-3 gap-y-2">
          <UInput v-for="k in fieldsOf" :key="k" v-model="f[k]" type="number" :label="`${VENT_FIELD[k].label}（${VENT_FIELD[k].unit}）`" :error="orderAct.fieldErrors.value[k] ?? (f[k] !== undefined ? live[k] : undefined)" :hint="`${VENT_FIELD[k].range[0]}–${VENT_FIELD[k].range[1]}`" />
        </div>
        <template v-if="v?.order">
          <p class="text-xs text-slate-500">目前：{{ v.order.text }}。改設定會停掉這一筆、開一筆新的（護理師要核對）。</p>
          <div><USelect v-model="f.reason" label="為什麼改" :options="[{ label: '請選', value: '' }, ...VENT_CHANGE_REASONS.map((r) => ({ label: r, value: r }))]" :error="orderAct.fieldErrors.value.changeReason" /></div>
          <UInput v-if="f.reason === '其他'" v-model="f.reasonNote" label="說明" />
        </template>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="ventOpen = false">取消</UButton>
        <UButton type="submit" :loading="orderAct.pending.value">{{ v?.order ? '改設定' : '開立' }}</UButton>
      </template>
    </UDialog>

    <UDialog v-model="stopOpen" title="停止呼吸器" size="sm" @submit="submitStop">
      <div class="space-y-2">
        <UTextarea v-model="stopF.reason" label="原因" :rows="2" required :error="stopAct.fieldErrors.value.reason" placeholder="例：SBT 通過，拔管改鼻導管 3 L/min" />
        <UCheckbox v-if="v?.intubation" v-model="stopF.extubate" label="一起拔管（氣管內管記移除）" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="stopOpen = false">取消</UButton>
        <UButton type="submit" variant="danger" :loading="stopAct.pending.value">停止</UButton>
      </template>
    </UDialog>

    <UDialog v-model="tgtOpen" title="鎮靜目標（RASS 範圍）" size="sm" @submit="submitTarget">
      <div class="grid grid-cols-2 gap-3">
        <div><USelect v-model="tgt.min" label="下限（最深）" :options="rassOpts" :error="tgtAct.fieldErrors.value.min" /></div>
        <div><USelect v-model="tgt.max" label="上限（最淺）" :options="rassOpts" :error="tgtAct.fieldErrors.value.max" /></div>
      </div>
      <p class="mt-2 text-xs text-slate-500">一般插管病人淺鎮靜：−2～0。護理師每 4 小時評，超出範圍會列在你的首頁。</p>
      <template #footer>
        <UButton variant="secondary" @click="tgtOpen = false">取消</UButton>
        <UButton type="submit" :loading="tgtAct.pending.value">儲存</UButton>
      </template>
    </UDialog>

    <UDialog v-model="weanOpen" title="每日脫離評估" size="sm" @submit="submitWean">
      <div class="space-y-2">
        <div class="grid grid-cols-2 gap-3">
          <div><USelect v-model="wean.sat" label="SAT（停鎮靜）" :options="[{ label: '請選', value: '' }, ...weanOpts]" :error="weanAct.fieldErrors.value.sat" /></div>
          <div><USelect v-model="wean.sbt" label="SBT（自發呼吸）" :options="[{ label: '請選', value: '' }, ...weanOpts]" :error="weanAct.fieldErrors.value.sbt" /></div>
        </div>
        <UTextarea v-model="wean.note" label="原因／說明" :rows="2" :error="weanAct.fieldErrors.value.note" placeholder="沒通過或不適合要寫：例 FiO2 仍 60%、還在用升壓劑" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="weanOpen = false">取消</UButton>
        <UButton type="submit" :loading="weanAct.pending.value">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
