<script setup lang="ts">
// 病人的知情同意書總覽：手術、麻醉、輸血、侵入性檢查。醫師說明後在這裡記錄輸血同意書（住院中一次）、
// 檢查同意書（要同意書的影像檢查排程）、侵入性處置同意書（中心靜脈導管、胃造口，放一次用一張）；手術、麻醉同意書在「手術」分頁記錄。撤回寫原因。
// 能不能記、綁哪個對象由服務層判斷（consent.ts）
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UDialog, UInput, UQueryState, USelect, UTextarea } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { consentApi, CONSENT_RELATIONS } from '@/services'
import type { LineKind } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'

const props = defineProps<{ patientId: string; patientName: string }>()
const auth = useAuth()
const isDoctor = computed(() => auth.user?.role === 'doctor')
const { data, loading } = useQuery(() => consentApi.listConsents(props.patientId), [() => props.patientId])
const { data: tg } = useQuery(() => consentApi.consentTargets(props.patientId), [() => props.patientId])

const target = ref<{ kind: 'transfusion' | 'procedure'; admissionId?: string; examId?: string; lineKind?: LineKind; label: string }>()
const open = computed({ get: () => !!target.value, set: (x) => !x && (target.value = undefined) })
const f = reactive({ title: '', explanation: '', signerName: '', relation: '本人' as string | number | undefined, reason: '' })
function openRecord(t: NonNullable<typeof target.value>, title: string) {
  Object.assign(f, { title, explanation: '', signerName: props.patientName, relation: '本人', reason: '' })
  act.fieldErrors.value = {}
  target.value = t
}
const act = useAction(consentApi.recordConsent, { success: (c) => `已記錄 ${c.kindLabel}（${c.no}）` })
async function submit() {
  const t = target.value
  if (t && (await act.run({ patientId: props.patientId, kind: t.kind, ...(t.admissionId ? { admissionId: t.admissionId } : {}), ...(t.examId ? { examId: t.examId } : {}), ...(t.lineKind ? { lineKind: t.lineKind } : {}), title: f.title, explanation: f.explanation, signerName: f.signerName, relation: String(f.relation ?? ''), reason: f.reason }))) target.value = undefined
}
const revokeId = ref<string>()
const revokeOpen = computed({ get: () => !!revokeId.value, set: (x) => !x && (revokeId.value = undefined) })
const revokeAct = useAction(consentApi.revokeConsent, { success: '已撤回' })
async function onRevoke(reason: string) {
  if (revokeId.value && (await revokeAct.run(revokeId.value, reason))) revokeId.value = undefined
}
</script>

<template>
  <div class="space-y-3 text-sm">
    <div v-if="tg && (tg.admission || tg.exams.length)" class="space-y-1 rounded-md border border-slate-200 bg-white px-3 py-2">
      <div v-if="tg.admission" class="flex flex-wrap items-center gap-2">
        <span>住院 {{ tg.admission.admitNo }}・輸血同意書：</span>
        <UBadge :tone="tg.admission.transfusion ? 'green' : 'yellow'">{{ tg.admission.transfusion ? '已簽' : '還沒有（開始輸血前要有）' }}</UBadge>
        <UButton v-if="isDoctor && !tg.admission.transfusion" size="sm" variant="secondary" @click="openRecord({ kind: 'transfusion', admissionId: tg.admission.id, label: '輸血同意書' }, '輸血（紅血球、血小板、血漿）')">記錄簽署</UButton>
      </div>
      <div v-for="l in tg.admission?.lines ?? []" :key="l.kind" class="flex flex-wrap items-center gap-2">
        <span>{{ l.label }}放置・侵入性處置同意書：</span>
        <UBadge :tone="l.has ? 'green' : 'gray'">{{ l.has ? '已簽（還沒放）' : '沒有待用的' }}</UBadge>
        <UButton v-if="isDoctor && !l.has" size="sm" variant="secondary" @click="openRecord({ kind: 'procedure', lineKind: l.kind, label: `${l.label}同意書` }, `${l.label}放置`)">記錄簽署</UButton>
      </div>
      <div v-for="e in tg.exams" :key="e.id" class="flex flex-wrap items-center gap-2">
        <span>{{ e.name }}（{{ e.start.slice(5, 16) }}）・檢查同意書：</span>
        <UBadge :tone="e.has ? 'green' : 'yellow'">{{ e.has ? '已簽' : '還沒有（報到確認前要有）' }}</UBadge>
        <UButton v-if="isDoctor && !e.has" size="sm" variant="secondary" @click="openRecord({ kind: 'procedure', examId: e.id, label: '檢查同意書' }, `${e.name}（顯影劑）`)">記錄簽署</UButton>
      </div>
      <p class="text-xs text-slate-500">手術、麻醉同意書在「住院醫囑」或「護理站」的「手術」分頁記錄。</p>
    </div>
    <UQueryState :loading="loading && !data" :ready="!!data?.length" empty-title="沒有同意書紀錄">
      <ul v-if="data" class="space-y-2">
        <li v-for="c in data" :key="c.id" :class="['rounded-md border bg-white px-3 py-2', c.revoked ? 'border-slate-200 opacity-60' : 'border-slate-200']">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge :tone="c.revoked ? 'gray' : 'green'">{{ c.revoked ? '已撤回' : '有效' }}</UBadge>
            <b>{{ c.kindLabel }}</b><span class="text-xs text-slate-500">{{ c.no }}・{{ c.title }}{{ c.surgeryNo ? `・${c.surgeryNo}` : '' }}</span>
            <span v-if="c.lineUsed" class="ml-auto text-xs text-slate-500">已放置（不能撤回）</span>
            <button v-else-if="!c.revoked" type="button" class="ml-auto text-xs text-red-600 underline" @click="revokeId = c.id">撤回</button>
          </div>
          <div class="text-xs text-slate-600">簽署 {{ c.signer.name }}（{{ c.signer.relation }}{{ c.signer.reason ? `：${c.signer.reason}` : '' }}）・說明 {{ c.explainedByName }} {{ c.signedAt.slice(5) }}・{{ c.explanation }}</div>
          <div v-if="c.revoked" class="text-xs text-slate-500">撤回 {{ c.revoked.at.slice(5) }}：{{ c.revoked.reason }}</div>
        </li>
      </ul>
    </UQueryState>
    <UDialog v-model="open" :title="`${target?.label ?? ''}：${patientName}`" size="md" @submit="submit">
      <div class="space-y-3 text-sm">
        <UInput v-model="f.title" label="同意的項目" :error="act.fieldErrors.value.title" />
        <UTextarea v-model="f.explanation" label="說明重點（風險、替代方案、不做的後果）" :error="act.fieldErrors.value.explanation" />
        <div class="grid grid-cols-2 gap-2">
          <UInput v-model="f.signerName" label="簽署人" :error="act.fieldErrors.value.signerName" />
          <USelect v-model="f.relation" label="和病人的關係" :options="CONSENT_RELATIONS.map((r) => ({ label: r, value: r }))" :error="act.fieldErrors.value.relation" />
        </div>
        <UInput v-if="f.relation !== '本人'" v-model="f.reason" label="不是本人簽的原因" :error="act.fieldErrors.value.reason" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="target = undefined">取消</UButton>
        <UButton type="submit" :loading="act.pending.value">記錄</UButton>
      </template>
    </UDialog>
    <ReasonDialog v-model="revokeOpen" title="撤回同意書" label="撤回原因" :presets="['病人決定不做', '家屬要再討論', '改其他治療方式']" ok-text="撤回" danger :pending="revokeAct.pending.value" :error="revokeAct.fieldErrors.value.reason" @confirm="onRevoke" />
  </div>
</template>
