<script setup lang="ts">
// 診斷證明書（看診頁、住院醫囑頁、批價頁、住院結帳共用）：列出這次看診／住院開的證明書，
// 醫師：開立、收費前修改或作廢、收費後作廢重開（不另收費）；醫師與櫃台：收費後列印（印幾份＝份數）。
// 能不能開、能不能印都由服務層決定（certificate.ts），這裡只顯示。
import { computed, reactive, ref } from 'vue'
import { FileText, Printer } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, USelect, UTextarea } from '@/components/ui'
import CertificatePrint from './CertificatePrint.vue'
import { CERT_MAX_COPIES, CERT_PURPOSES, certificateApi, type CertificateView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { toRoc } from '@/utils/date'

const props = defineProps<{ encounterId?: string; admissionId?: string }>()
const auth = useAuth()
const isDoctor = computed(() => auth.user?.role === 'doctor')
const q = () => (props.encounterId ? { encounterId: props.encounterId } : { admissionId: props.admissionId })
const { data: list } = useQuery(async () => (props.encounterId || props.admissionId ? certificateApi.listCertificates(q()) : []), [() => props.encounterId, () => props.admissionId])
const { data: issuable } = useQuery(async () => (isDoctor.value && (props.encounterId || props.admissionId) ? certificateApi.certificateIssuable(q()) : undefined), [() => props.encounterId, () => props.admissionId])

// ---------- 開立／修改／作廢重開（同一個表單） ----------
type Mode = 'new' | 'edit' | 'reissue'
const formOpen = ref(false)
const mode = ref<Mode>('new')
const editing = ref<CertificateView>()
const form = reactive({ diagnoses: '', advice: '', purpose: '請假' as string | number, copies: 1, reason: '' })
const dateText = ref('')
// 草稿走 useAction：服務層不讓開（例：不是自己的病人）時要看到原因，不是按了沒反應
const draftAct = useAction(certificateApi.certificateDraft)
// 打開表單時清掉上一次送出留下的欄位錯誤
const clearErrors = () => { issue.fieldErrors.value = {}; update.fieldErrors.value = {}; reissue.fieldErrors.value = {} }
async function openNew() {
  const d = await draftAct.run(q())
  if (!d) return
  clearErrors()
  Object.assign(form, { diagnoses: d.diagnoses, advice: '', purpose: d.purpose, copies: 1, reason: '' })
  dateText.value = d.visitDate ? `應診日期 ${toRoc(d.visitDate)}` : `住院期間 ${toRoc(d.stayFrom!)} 至 ${toRoc(d.stayTo!)}`
  mode.value = 'new'
  editing.value = undefined
  formOpen.value = true
}
function openEdit(c: CertificateView, m: Mode) {
  clearErrors()
  Object.assign(form, { diagnoses: c.diagnoses, advice: c.advice, purpose: c.purpose, copies: c.copies, reason: '' })
  dateText.value = c.visitDate ? `應診日期 ${toRoc(c.visitDate)}` : `住院期間 ${toRoc(c.stayFrom!)} 至 ${toRoc(c.stayTo!)}`
  mode.value = m
  editing.value = c
  formOpen.value = true
}
const issue = useAction(certificateApi.issueCertificate, { success: (c) => `已開立 ${c.no}（${c.copies} 份）；病人批價後即可列印` })
const update = useAction(certificateApi.updateCertificate, { success: (c) => `已修改 ${c.no}` })
const reissue = useAction(certificateApi.reissueCertificate, { success: (c) => `已作廢重開為 ${c.no}（不另收費）` })
const errors = computed(() => ({ ...issue.fieldErrors.value, ...update.fieldErrors.value, ...reissue.fieldErrors.value }))
const pending = computed(() => issue.pending.value || update.pending.value || reissue.pending.value)
async function submit() {
  const input = { diagnoses: form.diagnoses, advice: form.advice, purpose: String(form.purpose), copies: Number(form.copies) }
  const r = mode.value === 'new' ? await issue.run({ ...input, ...q() }) : mode.value === 'edit' ? await update.run(editing.value!.id, input) : await reissue.run(editing.value!.id, { ...input, reason: form.reason })
  if (r) formOpen.value = false
}
// 作廢（收費前）
const voidOpen = ref(false)
const voidReason = ref('')
const voiding = ref<CertificateView>()
const voidIt = useAction(certificateApi.voidCertificate, { success: (c) => `已作廢 ${c.no}（費用一併取消）` })
async function onVoid() {
  if (voiding.value && (await voidIt.run(voiding.value.id, voidReason.value))) voidOpen.value = false
}
// 列印：先記下列印，再開預覽讓使用者按列印
const printing = ref<CertificateView>()
const doPrint = useAction(certificateApi.printCertificate)
async function openPrint(c: CertificateView) {
  const r = await doPrint.run(c.id)
  if (r) printing.value = r
}
const print = () => window.print()
const MODE_TITLE: Record<Mode, string> = { new: '開立診斷證明書', edit: '修改診斷證明書', reissue: '作廢重開診斷證明書' }
</script>

<template>
  <section class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <h4 class="text-sm font-semibold text-slate-700">診斷證明書</h4>
      <span v-if="issuable && !issuable.ok && isDoctor" class="text-xs text-slate-500">{{ issuable.reason }}</span>
      <UButton v-if="issuable?.ok" size="sm" variant="secondary" class="ml-auto" :icon="FileText" @click="openNew">開立</UButton>
    </div>
    <p v-if="!list?.length" class="text-xs text-slate-400">沒有開立</p>
    <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
      <li v-for="c in list" :key="c.id" :class="['flex flex-wrap items-center gap-2 px-3 py-2', c.voided && 'text-slate-400']">
        <span class="tabular font-medium">{{ c.no }}</span>
        <span class="text-xs">{{ c.copies }} 份・{{ c.purpose }}・{{ c.doctorName }}</span>
        <UBadge v-if="c.voided" tone="gray">已作廢{{ c.voided.replacedBy ? `（重開為 ${c.replacedByNo}）` : '' }}</UBadge>
        <UBadge v-else-if="c.replaces" tone="blue">作廢重開・不另收費</UBadge>
        <UBadge v-else-if="c.feePaid" tone="green">已收費</UBadge>
        <UBadge v-else tone="yellow">待批價收費</UBadge>
        <UBadge v-if="c.printed?.length" tone="gray">已印 {{ c.printed.length }} 次</UBadge>
        <span class="ml-auto flex gap-1.5">
          <template v-if="isDoctor && c.doctorId === auth.user?.doctorId">
            <UButton v-if="c.editable" size="sm" variant="ghost" @click="openEdit(c, 'edit')">修改</UButton>
            <UButton v-if="c.editable" size="sm" variant="ghost" @click="(voiding = c), (voidReason = ''), (voidIt.fieldErrors.value = {}), (voidOpen = true)">作廢</UButton>
            <UButton v-if="c.reissuable" size="sm" variant="ghost" @click="openEdit(c, 'reissue')">作廢重開</UButton>
          </template>
          <UButton v-if="c.printable" size="sm" variant="secondary" :icon="Printer" :loading="doPrint.pending.value" @click="openPrint(c)">列印</UButton>
        </span>
      </li>
    </ul>

    <UDialog v-model="formOpen" :title="MODE_TITLE[mode]" size="lg" @submit="submit">
      <div class="space-y-3">
        <p class="text-sm text-slate-600">{{ dateText }}<template v-if="mode === 'reissue'">　原字號 {{ editing?.no }} 會作廢，新的換字號、不另收費</template></p>
        <UTextarea v-model="form.diagnoses" label="病名" :rows="3" required :error="errors.diagnoses" />
        <UTextarea v-model="form.advice" label="醫師囑言" :rows="3" placeholder="例：宜休養三日；需專人照護一個月" required :error="errors.advice" />
        <div class="grid grid-cols-2 gap-3">
          <USelect v-model="form.purpose" label="用途" :options="CERT_PURPOSES.map((p) => ({ label: p, value: p }))" :error="errors.purpose" />
          <UInput v-model="form.copies" type="number" min="1" :max="CERT_MAX_COPIES" label="份數" :hint="mode === 'new' ? '證明書費 × 份數，跟著這次帳單收' : mode === 'reissue' ? '不能超過原本的份數' : ''" :error="errors.copies" />
        </div>
        <UInput v-if="mode === 'reissue'" v-model="form.reason" label="重開原因" placeholder="例：病名寫錯" required :error="errors.reason" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="formOpen = false">取消</UButton>
        <UButton type="submit" :loading="pending">{{ mode === 'new' ? '開立' : mode === 'edit' ? '儲存' : '作廢並重開' }}</UButton>
      </template>
    </UDialog>
    <UDialog v-model="voidOpen" title="作廢診斷證明書" size="sm" @submit="onVoid">
      <p class="text-sm text-slate-600">{{ voiding?.no }} 作廢後，證明書費一併取消。</p>
      <UInput v-model="voidReason" label="作廢原因" required :error="voidIt.fieldErrors.value.reason" />
      <template #footer>
        <UButton variant="secondary" @click="voidOpen = false">取消</UButton>
        <UButton type="submit" variant="danger" :loading="voidIt.pending.value">作廢</UButton>
      </template>
    </UDialog>
    <UDialog :model-value="!!printing" title="診斷證明書" size="lg" @update:model-value="(v: boolean) => !v && (printing = undefined)">
      <CertificatePrint v-if="printing" :c="printing" />
      <template #footer>
        <UButton variant="secondary" @click="printing = undefined">關閉</UButton>
        <UButton :icon="Printer" @click="print">列印（{{ printing?.copies }} 份）</UButton>
      </template>
    </UDialog>
  </section>
</template>
