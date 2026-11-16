<script setup lang="ts">
// 轉診（看診頁）：
//   - 轉入：病人持外院轉診單（櫃台登錄）→ 顯示轉出院所、診斷、目的；看完診開「轉診回覆單」
//   - 轉出：看完診開轉診單（病摘快照）、列印、作廢
// 能不能開、能不能回覆都由服務層判斷（referral.ts），這裡只顯示
import { computed, reactive, ref } from 'vue'
import { Printer, Send } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, USelect, UTextarea } from '@/components/ui'
import ReferralPrint from './ReferralPrint.vue'
import ReferralReplyDialog from './ReferralReplyDialog.vue'
import { REFERRAL_PURPOSES, referralApi, type ReferralOutInput, type ReferralOutView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'

const props = defineProps<{ visitId: string; encounterId?: string; completed: boolean; doctorId: string }>()
const auth = useAuth()
const mine = computed(() => auth.user?.role === 'doctor' && auth.user.doctorId === props.doctorId)
const { data: incoming } = useQuery(() => referralApi.getReferralIn(props.visitId), [() => props.visitId])
const { data: outs } = useQuery(async () => (props.encounterId ? referralApi.listReferralsOut({ encounterId: props.encounterId }) : []), [() => props.encounterId])
const md = (d: string) => d.slice(5).replace('-', '/')

const replyOpen = ref(false)

// ---------- 轉出 ----------
const formOpen = ref(false)
const form = reactive<ReferralOutInput>({ toHospital: '', toDept: '', purpose: REFERRAL_PURPOSES[0], urgent: false, summary: '' })
async function openNew() {
  if (!props.encounterId) return
  const d = await referralApi.referralOutDraft(props.encounterId).catch(() => undefined)
  if (!d) return
  Object.assign(form, d)
  formOpen.value = true
}
const issue = useAction(referralApi.issueReferral, { success: (r) => `已開立轉診單 ${r.no}` })
async function submit() {
  if (!props.encounterId) return
  const r = await issue.run(props.encounterId, { ...form })
  if (r) {
    formOpen.value = false
    printing.value = r
  }
}
const printing = ref<ReferralOutView>()
const doPrint = useAction(referralApi.printReferral)
async function print() {
  if (!printing.value) return
  const r = await doPrint.run(printing.value.id)
  if (r) {
    printing.value = r
    window.print()
  }
}
const voidOpen = ref(false)
const voidReason = ref('')
const voiding = ref<ReferralOutView>()
const voidIt = useAction(referralApi.voidReferral, { success: (r) => `已作廢 ${r.no}` })
async function onVoid() {
  if (voiding.value && (await voidIt.run(voiding.value.id, voidReason.value))) voidOpen.value = false
}
</script>

<template>
  <section class="space-y-2">
    <!-- 轉入 -->
    <div v-if="incoming" class="flex flex-wrap items-center gap-2 rounded-md border border-cyan-300 bg-cyan-50 px-3 py-2 text-sm text-cyan-950">
      <UBadge tone="cyan">外院轉診</UBadge>
      <span><b>{{ incoming.referral.fromHospital }}</b>（{{ md(incoming.referral.issuedOn) }} 開單）：{{ incoming.referral.diagnosis }}<template v-if="incoming.referral.purpose">・{{ incoming.referral.purpose }}</template></span>
      <span v-if="incoming.inheritedText" class="text-xs text-cyan-800">{{ incoming.inheritedText }}</span>
      <span class="ml-auto flex items-center gap-2">
        <UBadge v-if="incoming.referral.reply" tone="green">已回覆</UBadge>
        <span v-else-if="!incoming.referral.inheritedFrom && !completed" class="text-xs text-cyan-800">完成看診後開回覆單給原院所</span>
        <UButton v-if="incoming.canReply" size="sm" variant="secondary" @click="replyOpen = true">{{ incoming.referral.reply ? '回覆單' : '開回覆單' }}</UButton>
      </span>
    </div>

    <!-- 轉出 -->
    <div v-if="encounterId" class="flex flex-wrap items-center gap-2">
      <h4 class="text-sm font-semibold text-slate-700">轉出</h4>
      <span v-if="mine && !completed" class="text-xs text-slate-500">完成看診後可開轉診單</span>
      <UButton v-if="mine && completed && encounterId" size="sm" variant="secondary" class="ml-auto" :icon="Send" @click="openNew">開轉診單</UButton>
    </div>
    <ul v-if="outs?.length" class="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
      <li v-for="r in outs" :key="r.id" :class="['flex flex-wrap items-center gap-2 px-3 py-2', r.voided && 'text-slate-400']">
        <span class="tabular font-medium">{{ r.no }}</span>
        <span class="text-xs">{{ r.toHospital }} {{ r.toDept }}・{{ r.purpose }}</span>
        <UBadge v-if="r.urgent && !r.voided" tone="red">急</UBadge>
        <UBadge v-if="r.voided" tone="gray">已作廢</UBadge>
        <UBadge v-else-if="r.printed?.length" tone="gray">已印 {{ r.printed.length }} 次</UBadge>
        <span class="ml-auto flex gap-1.5">
          <UButton v-if="!r.voided && r.doctorId === auth.user?.doctorId" size="sm" variant="ghost" @click="(voiding = r), (voidReason = ''), (voidOpen = true)">作廢</UButton>
          <UButton v-if="!r.voided" size="sm" variant="secondary" :icon="Printer" @click="printing = r">列印</UButton>
        </span>
      </li>
    </ul>

    <UDialog v-model="formOpen" title="開立轉診單" size="lg" @submit="submit">
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <UInput v-model="form.toHospital" label="建議轉診院所" placeholder="例：展示醫學中心" required :error="issue.fieldErrors.value.toHospital" />
          <UInput v-model="form.toDept" label="科別" placeholder="例：心臟內科" required :error="issue.fieldErrors.value.toDept" />
          <USelect v-model="form.purpose" label="轉診目的" :options="REFERRAL_PURPOSES.map((p) => ({ label: p, value: p }))" :error="issue.fieldErrors.value.purpose" />
          <div class="flex items-end pb-2"><UCheckbox v-model="form.urgent">急件</UCheckbox></div>
        </div>
        <UTextarea v-model="form.summary" label="病情摘要" :rows="4" required :error="issue.fieldErrors.value.summary" />
        <p class="text-xs text-slate-500">診斷、用藥、檢驗檢查、過敏照這次病歷自動附上（開立當下的內容）。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="formOpen = false">取消</UButton>
        <UButton type="submit" :loading="issue.pending.value">開立</UButton>
      </template>
    </UDialog>
    <UDialog :model-value="!!printing" title="轉診單" size="lg" @update:model-value="(v: boolean) => !v && (printing = undefined)">
      <ReferralPrint v-if="printing" :r="printing" />
      <template #footer>
        <UButton variant="secondary" @click="printing = undefined">關閉</UButton>
        <UButton :icon="Printer" :loading="doPrint.pending.value" @click="print">列印</UButton>
      </template>
    </UDialog>
    <UDialog v-model="voidOpen" title="作廢轉診單" size="sm" @submit="onVoid">
      <p class="text-sm text-slate-600">{{ voiding?.no }} 作廢後不能再列印。</p>
      <UInput v-model="voidReason" label="作廢原因" required :error="voidIt.fieldErrors.value.reason" />
      <template #footer>
        <UButton variant="secondary" @click="voidOpen = false">取消</UButton>
        <UButton type="submit" variant="danger" :loading="voidIt.pending.value">作廢</UButton>
      </template>
    </UDialog>
    <ReferralReplyDialog v-model="replyOpen" :visit-id="visitId" />
  </section>
</template>
