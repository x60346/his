<script setup lang="ts">
// 輸血（醫師住院醫囑、護理站病人分頁共用）：
//   - 醫師：開備血單（Hb、PLT 高於門檻要寫理由）、取消、確認輸血反應（寫處置）
//   - 護理師：已發血的那一袋床邊核對開始輸血、15 分鐘生命徵象、結束（輸入量）、輸血反應（立刻停止、通知醫師）
// 配血、發血在血庫頁；規則都在服務層（blood.ts、blood-rules）
import { computed, reactive, ref } from 'vue'
import { Droplet, Plus } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState, UTextarea } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import TransfusionStartDialog from './TransfusionStartDialog.vue'
import TransfusionVitalsFields from './TransfusionVitalsFields.vue'
import {
  BLOOD_INDICATIONS, BLOOD_MAX_UNITS, BLOOD_PRODUCT_LABEL, BLOOD_PRODUCTS, BLOOD_THRESHOLD, bloodApi, REACTION_SYMPTOMS, thresholdProblem,
  type BloodIssueRow, type BloodRequestView, type TransfusionVitalsInput,
} from '@/services'
import type { BloodProduct } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { now } from '@/utils/date'

const props = defineProps<{ admissionId: string }>()
const auth = useAuth()
const isDoctor = computed(() => auth.user?.role === 'doctor')
const isNurse = computed(() => auth.user?.role === 'nurse')
const { data, loading } = useQuery(() => bloodApi.patientBlood(props.admissionId), [() => props.admissionId])
const b = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))

const statusTone = (r: BloodRequestView) =>
  r.status === 'cancelled' ? 'gray' : r.status === 'done' ? 'green' : r.status === 'transfusing' ? 'red' : r.status === 'ready' ? 'blue' : 'yellow'
const rowTone = (x: BloodIssueRow) => (x.state === 'stopped' ? 'red' : x.state === 'transfusing' ? 'red' : x.state === 'issued' ? 'yellow' : x.state === 'done' ? 'green' : 'gray')
const vtext = (v: { temp: number; pulse: number; sbp: number; dbp: number }) => `T ${v.temp}・P ${v.pulse}・BP ${v.sbp}/${v.dbp}`
const KIND_LABEL = { pre: '輸血前', '15min': '15 分鐘', end: '結束' } as const

// ---------- 醫師：開備血單 ----------
const orderOpen = ref(false)
const form = reactive({ product: 'rbc' as BloodProduct, units: 1 as number | undefined, indication: '', urgent: false, overReason: '' })
function openOrder() {
  Object.assign(form, { product: 'rbc', units: 1, indication: '', urgent: false, overReason: '' })
  order.fieldErrors.value = {}
  orderOpen.value = true
}
/** 畫面先提示（服務層會再判斷一次）：和服務層同一個 thresholdProblem */
const overHint = computed(() => {
  const th = BLOOD_THRESHOLD[form.product]
  if (!th) return ''
  const lab = b.value?.labs.find((l) => l.code === th.code)
  return thresholdProblem(form.product, lab, now())
})
const order = useAction(bloodApi.orderBlood, { success: (r) => `已開立備血單 ${r.no}：血庫驗血型、配血後可發血` })
async function submitOrder() {
  const ok = await order.run({ admissionId: props.admissionId, product: form.product, units: Number(form.units), indication: form.indication, urgent: form.urgent, overReason: form.overReason })
  if (ok) orderOpen.value = false
}

const cancelling = ref<BloodRequestView>()
const cancelOpen = computed({ get: () => !!cancelling.value, set: (v) => !v && (cancelling.value = undefined) })
const cancel = useAction(bloodApi.cancelBloodRequest, { success: '已取消備血單；配好的血袋已釋出' })
async function confirmCancel(reason: string) {
  if (cancelling.value && (await cancel.run(cancelling.value.id, reason))) cancelling.value = undefined
}

const acking = ref<{ r: BloodRequestView; x: BloodIssueRow }>()
const ackOpen = computed({ get: () => !!acking.value, set: (v) => !v && (acking.value = undefined) })
const ack = useAction(bloodApi.ackTransfusionReaction, { success: '已確認輸血反應' })
async function confirmAck(note: string) {
  if (acking.value && (await ack.run(acking.value.r.id, acking.value.x.unit.id, note))) acking.value = undefined
}

// ---------- 護理師：開始、15 分鐘、結束、反應 ----------
const starting = ref<{ r: BloodRequestView; x: BloodIssueRow }>()
const startOpen = computed({ get: () => !!starting.value, set: (v) => !v && (starting.value = undefined) })

type Step = 'check' | 'end' | 'reaction'
const stepping = ref<{ r: BloodRequestView; x: BloodIssueRow; step: Step }>()
const stepOpen = computed({ get: () => !!stepping.value, set: (v) => !v && (stepping.value = undefined) })
const vit = ref<TransfusionVitalsInput>({})
const volume = ref<number | undefined>()
const symptoms = ref<string[]>([])
const rxNote = ref('')
function openStep(r: BloodRequestView, x: BloodIssueRow, step: Step) {
  vit.value = {}
  volume.value = step === 'end' ? x.unit.volume : undefined
  symptoms.value = []
  rxNote.value = ''
  for (const a of [checkAct, endAct, rxAct]) a.fieldErrors.value = {}
  stepping.value = { r, x, step }
}
const checkAct = useAction(bloodApi.recordTransfusionCheck, { success: '已記錄 15 分鐘生命徵象' })
const endAct = useAction(bloodApi.endTransfusion, { success: '已結束輸血' })
const rxAct = useAction(bloodApi.reportTransfusionReaction, { success: '已停止輸血並通知醫師' })
const stepAct = computed(() => (stepping.value?.step === 'check' ? checkAct : stepping.value?.step === 'end' ? endAct : rxAct))
async function submitStep() {
  const s = stepping.value
  if (!s) return
  const ids = [s.r.id, s.x.unit.id] as const
  const ok =
    s.step === 'check' ? await checkAct.run(...ids, vit.value)
    : s.step === 'end' ? await endAct.run(...ids, { volume: Number(volume.value), vitals: vit.value })
    : await rxAct.run(...ids, { symptoms: symptoms.value, note: rxNote.value, ...(volume.value !== undefined ? { volume: volume.value } : {}), vitals: vit.value })
  if (ok) stepping.value = undefined
}
const STEP_TITLE: Record<Step, string> = { check: '輸血 15 分鐘生命徵象', end: '結束輸血', reaction: '輸血反應：停止輸血' }
const toggleSymptom = (s: string, on: boolean) => (symptoms.value = on ? [...new Set([...symptoms.value, s])] : symptoms.value.filter((x) => x !== s))
</script>

<template>
  <div class="space-y-4 p-4 text-sm">
    <UQueryState :loading="loading && !b" :ready="!!b">
      <template v-if="b">
        <p v-if="b.reactionsUnacked" class="rounded-md border border-red-300 bg-red-50 px-3 py-2 font-medium text-red-800" role="alert">
          有 {{ b.reactionsUnacked }} 筆輸血反應{{ isDoctor ? '待確認：請寫處置' : '，已通知醫師' }}
        </p>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
          <span class="flex items-center gap-1.5"><Droplet class="h-4 w-4 text-red-600" />本院血型：<b class="text-slate-800">{{ b.typingText ?? '未驗' }}</b>
            <span v-if="b.typingAt" class="tabular text-xs text-slate-500">（{{ b.typingAt.slice(0, 10) }}）</span></span>
          <span v-if="b.selfReported" class="text-xs text-slate-500">病人資料（自述）：{{ b.selfReported }} 型，不能用來配血</span>
          <span v-for="l in b.labs" :key="l.code" :class="['tabular', l.over ? 'text-slate-600' : 'font-semibold text-red-700']">{{ l.code }} {{ l.value }}<span class="text-xs font-normal text-slate-500">（{{ l.at.slice(5, 16) }}）</span></span>
          <UButton v-if="b.canOrder" size="sm" class="ml-auto" :icon="Plus" @click="openOrder">開備血單</UButton>
        </div>

        <p v-if="!b.requests.length" class="text-slate-500">這次住院沒有備血單。</p>
        <section v-for="r in b.requests" :key="r.id" :class="['space-y-2 rounded-md border p-3', r.status === 'cancelled' ? 'border-slate-200 opacity-70' : 'border-slate-300']">
          <div class="flex flex-wrap items-center gap-2">
            <b class="text-slate-800">{{ r.productLabel }} {{ r.units }} 單位</b>
            <UBadge v-if="r.urgent" tone="red">急</UBadge>
            <UBadge :tone="statusTone(r)">{{ r.statusLabel }}</UBadge>
            <span class="tabular text-xs text-slate-500">{{ r.no }}・{{ r.orderedAt.slice(5) }}・{{ r.doctorName }}</span>
            <UButton v-if="isDoctor && b.canOrder && ['typing', 'matching', 'ready'].includes(r.status)" size="sm" variant="ghost" class="ml-auto text-red-700" @click="cancelling = r">取消</UButton>
          </div>
          <div class="text-xs text-slate-600">
            適應症：{{ r.indication }}<span v-if="r.labText">・開立時 {{ r.labText }}</span>
            <span v-if="r.typingText">・血庫驗血型 <b>{{ r.typingText }}</b></span>
          </div>
          <p v-if="r.overReason" class="text-xs text-amber-800">高於輸血門檻的理由：{{ r.overReason }}</p>
          <p v-if="r.cancelled" class="text-xs text-slate-500">已取消：{{ r.cancelled.reason }}・{{ r.cancelled.byName }} {{ r.cancelled.at.slice(5) }}</p>
          <p v-if="r.status === 'typing' || r.status === 'matching'" class="text-xs text-slate-500">血庫處理中（{{ r.rows.length }}／{{ r.units }} 袋已配好）。</p>

          <ul v-if="r.rows.length" class="space-y-1.5">
            <li v-for="x in r.rows" :key="x.unit.id" :class="['rounded border px-3 py-2', x.state === 'stopped' ? 'border-red-300 bg-red-50/60' : x.state === 'transfusing' ? 'border-red-200 bg-red-50/30' : 'border-slate-200']">
              <div class="flex flex-wrap items-center gap-2">
                <span class="tabular font-medium text-slate-800">{{ x.unit.unitNo }}</span>
                <span class="text-slate-600">{{ x.unit.typeText }}・{{ x.unit.volume }} ml・效期 {{ x.unit.expiresOn }}</span>
                <UBadge :tone="rowTone(x)">{{ x.stateLabel }}</UBadge>
                <span v-if="x.todo.lateStart" class="text-xs font-semibold text-amber-800">發血已超過 30 分鐘</span>
                <span v-if="x.todo.check" :class="['text-xs font-semibold', x.todo.check === 'overdue' ? 'text-red-700' : 'text-amber-800']">{{ x.todo.check === 'overdue' ? '15 分鐘生命徵象逾時' : '該量 15 分鐘生命徵象' }}</span>
                <span v-if="x.todo.long" class="text-xs font-semibold text-red-700">已超過 4 小時</span>
                <span class="ml-auto flex gap-1.5">
                  <template v-if="isNurse">
                    <UButton v-if="x.state === 'issued'" size="sm" @click="starting = { r, x }">開始輸血</UButton>
                    <template v-if="x.state === 'transfusing'">
                      <UButton v-if="!x.issue?.transfusion?.vitals.some((v) => v.kind === '15min')" size="sm" :variant="x.todo.check ? 'primary' : 'secondary'" @click="openStep(r, x, 'check')">15 分鐘生命徵象</UButton>
                      <UButton size="sm" variant="secondary" @click="openStep(r, x, 'end')">結束輸血</UButton>
                      <UButton size="sm" variant="danger" @click="openStep(r, x, 'reaction')">輸血反應</UButton>
                    </template>
                  </template>
                  <UButton v-if="isDoctor && x.reactionUnacked" size="sm" variant="danger" @click="acking = { r, x }">確認輸血反應</UButton>
                </span>
              </div>
              <div v-if="x.issue" class="mt-1 space-y-0.5 text-xs text-slate-600">
                <div class="tabular">發血 {{ x.issue.issuedAt.slice(5) }}・{{ x.issue.issuedByName }}<span v-if="x.issue.returned">・退回 {{ x.issue.returned.at.slice(11) }}（{{ x.issue.returned.reason }}）</span></div>
                <template v-if="x.issue.transfusion">
                  <div class="tabular">開始 {{ x.issue.transfusion.startAt.slice(5) }}・{{ x.issue.nurseName }}，核對 {{ x.issue.witnessName }}
                    <span v-if="x.issue.transfusion.scan?.mode === 'skipped'" class="text-amber-800">・未掃描</span>
                    <span v-if="x.issue.transfusion.endAt">・結束 {{ x.issue.transfusion.endAt.slice(11) }}<span v-if="x.issue.transfusion.volume !== undefined">，{{ x.issue.transfusion.volume }} ml</span></span>
                  </div>
                  <div v-for="v in x.issue.transfusion.vitals" :key="v.at + v.kind" class="tabular">{{ KIND_LABEL[v.kind] }} {{ v.at.slice(11) }}：{{ vtext(v) }}</div>
                  <div v-if="x.issue.transfusion.reaction" class="rounded bg-red-100 px-2 py-1 text-red-900">
                    輸血反應 {{ x.issue.transfusion.reaction.at.slice(11) }}：{{ x.issue.transfusion.reaction.symptoms.join('、') }}<span v-if="x.issue.transfusion.reaction.note">；{{ x.issue.transfusion.reaction.note }}</span>
                    <div v-if="x.issue.transfusion.reaction.ackAt" class="text-red-800">醫師處置（{{ x.issue.ackByName }} {{ x.issue.transfusion.reaction.ackAt.slice(5) }}）：{{ x.issue.transfusion.reaction.ackNote }}</div>
                  </div>
                </template>
              </div>
            </li>
          </ul>
          <details v-if="r.released.length" class="text-xs text-slate-500">
            <summary class="cursor-pointer">已釋出 {{ r.released.length }} 袋</summary>
            <ul class="mt-1"><li v-for="x in r.released" :key="x.unitNo + x.at">{{ x.unitNo }}：{{ x.reason }}・{{ x.byName }} {{ x.at.slice(5) }}</li></ul>
          </details>
        </section>
        <p v-if="isNurse" class="text-xs text-slate-500">發血由血庫處理；血袋到病房後在這裡床邊核對開始輸血。發血後 30 分鐘內要開始、4 小時內輸完。</p>
      </template>
    </UQueryState>

    <UDialog v-model="orderOpen" :title="`開備血單：${b?.patientName ?? ''}`" @submit="submitOrder">
      <div class="space-y-3">
        <fieldset class="flex flex-wrap gap-4">
          <label v-for="p in BLOOD_PRODUCTS" :key="p" class="flex items-center gap-1.5">
            <input v-model="form.product" type="radio" name="blood-product" :value="p" class="h-4 w-4 text-brand-600" />{{ BLOOD_PRODUCT_LABEL[p] }}
          </label>
        </fieldset>
        <div class="grid grid-cols-2 gap-3">
          <UInput v-model="form.units" type="number" :label="`單位數（最多 ${BLOOD_MAX_UNITS[form.product]}）`" required :error="order.fieldErrors.value.units" />
          <div class="flex items-end pb-2"><UCheckbox v-model="form.urgent" label="急件" /></div>
        </div>
        <UInput v-model="form.indication" label="適應症" required :error="order.fieldErrors.value.indication" />
        <div class="flex flex-wrap gap-1.5">
          <button v-for="p in BLOOD_INDICATIONS[form.product]" :key="p" type="button" class="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100" @click="form.indication = p">{{ p }}</button>
        </div>
        <template v-if="overHint || order.fieldErrors.value.overReason">
          <p class="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">{{ overHint || order.fieldErrors.value.overReason }}：要寫輸血理由才能開（不擋）。</p>
          <UTextarea v-model="form.overReason" label="輸血理由" :rows="2" required :error="order.fieldErrors.value.overReason" />
        </template>
        <p class="text-xs text-slate-500">血庫會重新抽血驗血型（和本院上次驗的不同會擋下重抽）、做交叉試驗。費用：交叉試驗每袋、血品發出才計。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="orderOpen = false">取消</UButton>
        <UButton type="submit" :loading="order.pending.value">開立</UButton>
      </template>
    </UDialog>

    <UDialog v-model="stepOpen" :title="stepping ? STEP_TITLE[stepping.step] : ''" @submit="submitStep">
      <div v-if="stepping" class="space-y-3">
        <div class="rounded-md bg-slate-50 px-3 py-2 font-medium text-slate-700">{{ stepping.r.patientName }}・血袋 {{ stepping.x.unit.unitNo }} {{ stepping.x.unit.productLabel }} {{ stepping.x.unit.typeText }}</div>
        <template v-if="stepping.step === 'reaction'">
          <p class="text-sm font-semibold text-red-700">立刻停止輸血、保留血袋與管路，維持靜脈通路。送出後通知醫師。</p>
          <fieldset class="flex flex-wrap gap-x-4 gap-y-1">
            <UCheckbox v-for="s in REACTION_SYMPTOMS" :key="s" :model-value="symptoms.includes(s)" :label="s" @update:model-value="(v) => toggleSymptom(s, v)" />
          </fieldset>
          <p v-if="rxAct.fieldErrors.value.symptoms" class="text-xs text-red-600">{{ rxAct.fieldErrors.value.symptoms }}</p>
          <UInput v-model="rxNote" label="說明" :error="rxAct.fieldErrors.value.note" />
        </template>
        <UInput v-if="stepping.step !== 'check'" v-model="volume" type="number" :label="stepping.step === 'end' ? '輸入量 ml' : '已輸入量 ml（選填）'" :required="stepping.step === 'end'" :error="stepAct.fieldErrors.value.volume" />
        <TransfusionVitalsFields v-model="vit" :title="stepping.step === 'reaction' ? '生命徵象（選填）' : '生命徵象'" :errors="stepAct.fieldErrors.value" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="stepOpen = false">取消</UButton>
        <UButton type="submit" :variant="stepping?.step === 'reaction' ? 'danger' : 'primary'" :loading="stepAct.pending.value">{{ stepping?.step === 'reaction' ? '停止輸血、通知醫師' : '儲存' }}</UButton>
      </template>
    </UDialog>

    <TransfusionStartDialog v-model="startOpen" :request="starting?.r" :row="starting?.x" />
    <ReasonDialog
      v-model="cancelOpen"
      title="取消備血單"
      :subject="cancelling ? `${cancelling.no} ${cancelling.productLabel} ${cancelling.units} 單位` : ''"
      label="取消原因"
      :presets="['病情改善，不需輸血', '改開其他血品', '開錯']"
      ok-text="取消備血單"
      danger
      :pending="cancel.pending.value"
      :error="cancel.fieldErrors.value.reason"
      @confirm="confirmCancel"
    />
    <ReasonDialog
      v-model="ackOpen"
      title="確認輸血反應"
      :subject="acking ? `血袋 ${acking.x.unit.unitNo}：${acking.x.issue?.transfusion?.reaction?.symptoms.join('、')}` : ''"
      label="處置"
      :presets="['已給抗組織胺，症狀緩解，可繼續觀察', '送輸血反應檢查（血袋、病人血液與尿液）', '給退燒藥，暫停後續輸血']"
      ok-text="確認"
      :pending="ack.pending.value"
      :error="ack.fieldErrors.value.note"
      @confirm="confirmAck"
    />
  </div>
</template>
