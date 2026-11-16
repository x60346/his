<script setup lang="ts">
// 給藥條碼核對：先掃病人腕帶、再掃藥品（不是給藥的醫囑只掃腕帶）。兩個都對才能「確認，繼續給藥」。
// 欄位就是一般輸入框：條碼掃描槍等於「打字＋Enter」，接真的掃描槍也能用。每掃一次就問服務層（scan.scanCheck），
// 不符當場大紅字講清楚錯在哪，並記下這次「差點給錯」。掃不了可以略過（選原因）——給藥紀錄會標「未掃描」。
// 真正給藥時服務層會再核對一次（scan-work.settleScan），這裡的結果只是讓人一步步確認
import { computed, nextTick, ref, watch } from 'vue'
import { CheckCircle2, ScanLine, XCircle } from 'lucide-vue-next'
import { UButton, UDialog, UInput, USelect } from '@/components/ui'
import { SCAN_SKIP_LABEL, SCAN_SKIP_REASONS, scanApi, type ScanInput } from '@/services'
import type { ScanSkipReason } from '@/types'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{
  /** 要給的這一劑：病人、醫囑、畫面上顯示的說明 */
  target?: { admissionId: string; orderId: string; patientLabel: string; content: string; needDrug: boolean }
  demoAssist?: boolean
}>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ done: [scan: ScanInput] }>()

const pCode = ref('')
const dCode = ref('')
const pRes = ref<{ ok: boolean; message: string }>()
const dRes = ref<{ ok: boolean; message: string }>()
const skipping = ref(false)
const skipReason = ref<ScanSkipReason | ''>('')
const skipNote = ref('')
const pInput = ref<InstanceType<typeof UInput>>()
const dInput = ref<InstanceType<typeof UInput>>()
const focus = async (which: 'p' | 'd') => {
  await nextTick()
  const el = ((which === 'p' ? pInput : dInput).value?.$el as HTMLElement | undefined)?.querySelector('input')
  el?.focus()
  el?.select()
}
watch(open, (o) => {
  if (!o) return
  pCode.value = dCode.value = skipNote.value = skipReason.value = ''
  pRes.value = dRes.value = undefined
  skipping.value = false
  focus('p')
})

const check = useAction(scanApi.scanCheck)
async function scanPatient() {
  if (!props.target || !pCode.value.trim()) return
  pRes.value = (await check.run({ admissionId: props.target.admissionId, orderId: props.target.orderId, kind: 'patient', code: pCode.value })) ?? undefined
  if (pRes.value?.ok && props.target.needDrug) focus('d')
  else if (pRes.value && !pRes.value.ok) focus('p')
}
async function scanDrug() {
  if (!props.target || !dCode.value.trim()) return
  dRes.value = (await check.run({ admissionId: props.target.admissionId, orderId: props.target.orderId, kind: 'drug', code: dCode.value })) ?? undefined
  if (dRes.value && !dRes.value.ok) focus('d')
}
const allOk = computed(() => !!pRes.value?.ok && (!props.target?.needDrug || !!dRes.value?.ok))
function proceed() {
  if (!allOk.value) return
  open.value = false
  emit('done', { patientCode: pCode.value, drugCode: dCode.value })
}
function proceedSkip() {
  if (!skipReason.value) return
  open.value = false
  emit('done', { skip: skipReason.value, note: skipNote.value })
}

// 示範用模擬掃描：選一個就當作掃描槍掃了它
const { data: demo } = useQuery(async () => (open.value && props.demoAssist && props.target ? scanApi.scanDemoCodes(props.target.admissionId, props.target.orderId) : undefined), [open, () => props.target?.orderId])
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
    dCode.value = o.code
    await scanDrug()
  }
})
</script>

<template>
  <UDialog v-model="open" title="給藥前核對：掃描條碼" size="md">
    <div v-if="target" class="space-y-3 text-sm">
      <div class="rounded-md bg-slate-50 px-3 py-2">
        <div class="font-medium text-slate-800">{{ target.content }}</div>
        <div class="text-xs text-slate-500">病人：{{ target.patientLabel }}</div>
      </div>

      <template v-if="!skipping">
        <form @submit.prevent="scanPatient">
          <UInput ref="pInput" v-model="pCode" label="1. 掃描病人腕帶" placeholder="掃描或輸入腕帶條碼，按 Enter" autocomplete="off" />
          <p v-if="pRes" :class="['mt-1 flex items-start gap-1.5', pRes.ok ? 'text-emerald-700' : 'text-base font-bold text-red-700']" :role="pRes.ok ? 'status' : 'alert'">
            <component :is="pRes.ok ? CheckCircle2 : XCircle" class="mt-0.5 h-4 w-4 shrink-0" />{{ pRes.message }}
          </p>
        </form>
        <form v-if="target.needDrug" @submit.prevent="scanDrug">
          <UInput ref="dInput" v-model="dCode" label="2. 掃描藥品條碼" placeholder="掃描或輸入藥品條碼，按 Enter" autocomplete="off" :disabled="!pRes?.ok" />
          <p v-if="dRes" :class="['mt-1 flex items-start gap-1.5', dRes.ok ? 'text-emerald-700' : 'text-base font-bold text-red-700']" :role="dRes.ok ? 'status' : 'alert'">
            <component :is="dRes.ok ? CheckCircle2 : XCircle" class="mt-0.5 h-4 w-4 shrink-0" />{{ dRes.message }}
          </p>
        </form>
        <div v-if="demoAssist && demo?.options.length" class="rounded-md border border-dashed border-slate-300 px-3 py-2">
          <USelect v-model="demoPick" label="示範：模擬掃描（展示用，沒有掃描槍時選一個當作掃了它）" placeholder="選擇要「掃」的條碼" :options="demo.options.map((o, i) => ({ value: String(i), label: `${o.kind === 'patient' ? '腕帶' : '藥品'}：${o.label}` }))" />
        </div>
        <button type="button" class="text-xs text-slate-500 underline hover:text-slate-700" @click="skipping = true">掃描不了？略過掃描</button>
      </template>

      <template v-else>
        <p class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">略過掃描要靠人工核對：再看一次腕帶上的姓名與出生日期、藥袋上的藥名與劑量。給藥紀錄會標「未掃描」，護理站的掃描統計會列出來。</p>
        <USelect v-model="skipReason" label="略過原因" placeholder="請選擇" :options="SCAN_SKIP_REASONS.map((r) => ({ value: r, label: SCAN_SKIP_LABEL[r] }))" />
        <UInput v-model="skipNote" label="說明（選填）" placeholder="例：掃描器沒電，充電中" />
        <button type="button" class="text-xs text-slate-500 underline hover:text-slate-700" @click="skipping = false">回到掃描</button>
      </template>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton v-if="!skipping" variant="success" :icon="ScanLine" :disabled="!allOk" @click="proceed">確認，繼續給藥</UButton>
      <UButton v-else variant="danger" :disabled="!skipReason" @click="proceedSkip">略過掃描，繼續給藥</UButton>
    </template>
  </UDialog>
</template>
