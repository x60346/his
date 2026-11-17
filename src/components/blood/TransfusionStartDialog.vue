<script setup lang="ts">
// 床邊開始輸血：① 掃病人腕帶、掃血袋條碼（每掃一次問服務層，不符當場大紅字；掃不了選原因略過）
// ② 輸血前生命徵象 ③ 另一位護理師或醫師輸入自己的帳密核對（病人、血型、血袋號、效期）→ 開始輸血。
// 真正開始時服務層會再核對一次（blood.startTransfusion）：掃描、核對、相容、效期，不相信這裡的結果
import { computed, nextTick, ref, watch } from 'vue'
import { CheckCircle2, ScanLine, XCircle } from 'lucide-vue-next'
import { UButton, UDialog, UInput, USelect } from '@/components/ui'
import WitnessDialog from '@/components/WitnessDialog.vue'
import TransfusionVitalsFields from './TransfusionVitalsFields.vue'
import { bloodApi, scanApi, SCAN_SKIP_LABEL, SCAN_SKIP_REASONS, witnessApi, type BloodIssueRow, type BloodRequestView, type BloodScanInput, type TransfusionVitalsInput } from '@/services'
import type { ScanSkipReason } from '@/types'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ request?: BloodRequestView; row?: BloodIssueRow }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ started: [] }>()

const { data: policy } = useQuery(() => scanApi.scanPolicy())
const needScan = computed(() => policy.value?.requireScan !== false)

const pCode = ref('')
const uCode = ref('')
const pRes = ref<{ ok: boolean; message: string }>()
const uRes = ref<{ ok: boolean; message: string }>()
const skipping = ref(false)
const skipReason = ref<ScanSkipReason | ''>('')
const skipNote = ref('')
const vitals = ref<TransfusionVitalsInput>({})
const witnessOpen = ref(false)
const pInput = ref<InstanceType<typeof UInput>>()
const uInput = ref<InstanceType<typeof UInput>>()
const focus = async (which: 'p' | 'u') => {
  await nextTick()
  const el = ((which === 'p' ? pInput : uInput).value?.$el as HTMLElement | undefined)?.querySelector('input')
  el?.focus()
  el?.select()
}
watch(open, (o) => {
  if (!o) return
  pCode.value = uCode.value = skipNote.value = skipReason.value = ''
  pRes.value = uRes.value = undefined
  skipping.value = false
  vitals.value = {}
  start.fieldErrors.value = {}
  focus('p')
}, { immediate: true })

const ids = () => ({ requestId: props.request?.id ?? '', unitId: props.row?.unit.id ?? '' })
const check = useAction(bloodApi.bloodScanCheck)
async function scanPatient() {
  if (!pCode.value.trim()) return
  pRes.value = (await check.run({ ...ids(), kind: 'patient', code: pCode.value })) ?? undefined
  focus(pRes.value?.ok ? 'u' : 'p')
}
async function scanUnit() {
  if (!uCode.value.trim()) return
  uRes.value = (await check.run({ ...ids(), kind: 'unit', code: uCode.value })) ?? undefined
  if (uRes.value && !uRes.value.ok) focus('u')
}
const scanOk = computed(() => !needScan.value || (skipping.value ? !!skipReason.value : !!pRes.value?.ok && !!uRes.value?.ok))
const scanInput = (): BloodScanInput | undefined =>
  !needScan.value ? undefined : skipping.value ? { skip: skipReason.value as ScanSkipReason, note: skipNote.value } : { patientCode: pCode.value, unitCode: uCode.value }

// 示範用模擬掃描
const { data: demo } = useQuery(async () => (open.value && props.request && props.row && policy.value?.demoAssist ? bloodApi.bloodScanDemo(props.request.id, props.row.unit.id) : undefined), [open, () => props.row?.unit.id, () => policy.value?.demoAssist])
const demoPick = ref('')
watch(demoPick, async (k) => {
  if (!k) return
  const o = demo.value?.options[Number(k)]
  demoPick.value = ''
  if (!o) return
  if (o.kind === 'patient') {
    pCode.value = o.code
    await scanPatient()
  } else {
    uCode.value = o.code
    await scanUnit()
  }
})

const subject = computed(() =>
  props.request && props.row
    ? `${props.request.bedNo} ${props.request.patientName}（${props.request.chartNo}）病人血型 ${props.request.typingText ?? '—'}\n血袋 ${props.row.unit.unitNo}　${props.row.unit.productLabel} ${props.row.unit.typeText}　${props.row.unit.volume} ml　效期 ${props.row.unit.expiresOn}`
    : '',
)
const approve = (cred: { username: string; password: string }) => witnessApi.approveWitness({ purpose: 'transfusion', ...ids(), ...cred })

const start = useAction(bloodApi.startTransfusion, { success: '已開始輸血：15 分鐘後請量生命徵象' })
async function onWitness(token: string) {
  if (!props.request || !props.row) return
  const ok = await start.run(props.request.id, props.row.unit.id, { scan: scanInput(), witness: token, vitals: vitals.value })
  if (ok) {
    open.value = false
    emit('started')
  }
}
function submit() {
  if (!scanOk.value) return
  const v = vitals.value
  if ([v.temp, v.pulse, v.sbp, v.dbp].some((x) => x === undefined)) {
    start.fieldErrors.value = Object.fromEntries((['temp', 'pulse', 'sbp', 'dbp'] as const).filter((k) => v[k] === undefined).map((k) => [k, '必填']))
    return
  }
  witnessOpen.value = true
}
</script>

<template>
  <UDialog v-model="open" :title="`開始輸血：${request?.patientName ?? ''}`" size="lg" @submit="submit">
    <div class="space-y-3 text-sm">
      <div class="whitespace-pre-line rounded-md bg-red-50 px-3 py-2 font-medium text-red-900">{{ subject }}</div>

      <template v-if="needScan">
        <div v-if="!skipping" class="space-y-2">
          <div class="flex items-end gap-2">
            <UInput ref="pInput" v-model="pCode" class="flex-1" label="① 掃病人腕帶" autocomplete="off" @keydown.enter.prevent="scanPatient" />
            <UButton variant="secondary" :icon="ScanLine" @click="scanPatient">核對</UButton>
          </div>
          <p v-if="pRes" :class="['flex items-center gap-1.5 font-medium', pRes.ok ? 'text-emerald-700' : 'text-lg text-red-700']" role="status">
            <component :is="pRes.ok ? CheckCircle2 : XCircle" class="h-4 w-4 shrink-0" />{{ pRes.message }}
          </p>
          <div class="flex items-end gap-2">
            <UInput ref="uInput" v-model="uCode" class="flex-1" label="② 掃血袋條碼" autocomplete="off" @keydown.enter.prevent="scanUnit" />
            <UButton variant="secondary" :icon="ScanLine" @click="scanUnit">核對</UButton>
          </div>
          <p v-if="uRes" :class="['flex items-center gap-1.5 font-medium', uRes.ok ? 'text-emerald-700' : 'text-lg text-red-700']" role="status">
            <component :is="uRes.ok ? CheckCircle2 : XCircle" class="h-4 w-4 shrink-0" />{{ uRes.message }}
          </p>
          <div v-if="demo?.options.length" class="max-w-sm">
            <USelect v-model="demoPick" label="示範：模擬掃描" placeholder="選一個條碼來掃" :options="demo.options.map((o, i) => ({ label: o.label, value: String(i) }))" />
          </div>
          <button type="button" class="text-xs text-slate-500 underline" @click="skipping = true">掃描器故障、腕帶無法讀取…略過掃描</button>
        </div>
        <div v-else class="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
          <USelect v-model="skipReason" label="略過掃描的原因" required :options="SCAN_SKIP_REASONS.map((r) => ({ label: SCAN_SKIP_LABEL[r], value: r }))" placeholder="選擇原因" />
          <UInput v-model="skipNote" label="說明（選填）" />
          <p class="text-xs text-amber-800">輸血紀錄會標「未掃描」；第二人核對照樣要做。</p>
          <button type="button" class="text-xs text-slate-600 underline" @click="skipping = false">回到掃描</button>
        </div>
        <p v-if="start.fieldErrors.value.scan" class="text-sm font-medium text-red-700">{{ start.fieldErrors.value.scan }}</p>
      </template>
      <p v-else class="text-xs text-slate-500">安全設定已關閉條碼掃描；仍要第二人核對。</p>

      <TransfusionVitalsFields v-model="vitals" title="③ 輸血前生命徵象" :errors="start.fieldErrors.value" />
      <p v-if="start.fieldErrors.value.witness" class="text-sm font-medium text-red-700">{{ start.fieldErrors.value.witness }}</p>
      <p class="text-xs text-slate-500">按下後請另一位護理師或醫師在床邊核對病人、血型、血袋號、效期，輸入自己的帳號密碼。開始後 15 分鐘要量生命徵象。</p>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton type="submit" :disabled="!scanOk" :loading="start.pending.value">雙人核對，開始輸血</UButton>
    </template>
  </UDialog>
  <WitnessDialog v-model="witnessOpen" title="輸血雙人核對" who="核對人" :subject="subject" note="核對病人、血型、血袋號與效期無誤。" ok-text="核對無誤" :approve="approve" @approved="onWitness" />
</template>
