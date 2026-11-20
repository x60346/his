<script setup lang="ts">
// 這台手術的知情同意書：手術同意書＋（非局部麻醉）麻醉同意書。醫師說明後記錄簽署（紙本簽名：誰簽、關係、說明重點）；
// 撤回會取消術前準備的「同意書」。缺哪幾張、能不能撤回由服務層判斷（consent.ts、consent-rules）
import { computed, reactive, ref } from 'vue'
import { UButton, UDialog, UInput, USelect, UTextarea } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { consentApi, CONSENT_RELATIONS, SIDE_LABEL, surgeryApi, type SurgeryView } from '@/services'
import { useAction } from '@/composables/useService'
import { useAuth } from '@/stores/auth'

const props = defineProps<{ surgery: SurgeryView }>()
const auth = useAuth()
const s = computed(() => props.surgery)
const editable = computed(() => s.value.status === 'requested' || s.value.status === 'scheduled' || s.value.status === 'sent')

const kind = ref<string>()
const open = computed({ get: () => !!kind.value, set: (x) => !x && (kind.value = undefined) })
const f = reactive({ title: '', explanation: '', signerName: '', relation: '本人' as string | number | undefined, reason: '' })
function openRecord(k: string, label: string) {
  Object.assign(f, { title: k === 'surgery' ? s.value.procName : `${s.value.procName}（麻醉）`, explanation: '', signerName: s.value.patientName, relation: '本人', reason: '' })
  act.fieldErrors.value = {}
  kind.value = k
  kindLabel.value = label
}
const kindLabel = ref('')
const act = useAction(consentApi.recordConsent, { success: (c) => `已記錄 ${c.kindLabel}（${c.no}）` })
async function submit() {
  if (kind.value && (await act.run({ patientId: s.value.patientId, kind: kind.value as 'surgery' | 'anesthesia', surgeryId: s.value.id, title: f.title, explanation: f.explanation, signerName: f.signerName, relation: String(f.relation ?? ''), reason: f.reason }))) kind.value = undefined
}
// 更正側別（主刀、送手術室前）：照舊側別簽的手術同意書不算了，術前準備的同意書與部位標記取消
const sideOpen = ref(false)
const sf = reactive({ side: '' as string | number | undefined, reason: '' })
const isSurgeon = computed(() => auth.user?.role === 'doctor' && auth.user.doctorId === s.value.doctorId)
const sideAct = useAction(surgeryApi.changeSurgerySide, { success: '已更正側別：手術同意書要重簽、部位要重新標記' })
async function submitSide() {
  if (await sideAct.run(s.value.id, { side: sf.side as 'left' | 'right' | 'bilateral' | 'na', reason: sf.reason })) sideOpen.value = false
}
const revokeId = ref<string>()
const revokeOpen = computed({ get: () => !!revokeId.value, set: (x) => !x && (revokeId.value = undefined) })
const revokeAct = useAction(consentApi.revokeConsent, { success: '已撤回：術前準備的同意書要重新簽' })
async function onRevoke(reason: string) {
  if (revokeId.value && (await revokeAct.run(revokeId.value, reason))) revokeId.value = undefined
}
</script>

<template>
  <div v-if="s.status !== 'cancelled'" class="space-y-0.5 text-xs">
    <div v-for="c in s.consents" :key="c.id" :class="c.revoked ? 'text-slate-400 line-through' : 'text-slate-600'">
      {{ c.kindLabel }} {{ c.no }}：{{ c.title }}{{ c.sideText ? `（${c.sideText}）` : '' }}・簽署 {{ c.signerText }}・說明 {{ c.explainedByName }} {{ c.signedAt.slice(5) }}
      <span v-if="c.revoked" class="no-underline">（已撤回 {{ c.revoked }}）</span>
      <button v-else-if="editable" type="button" class="ml-1 text-red-600 underline" @click="revokeId = c.id">撤回</button>
    </div>
    <div v-for="m in s.status === 'done' ? [] : s.consentMissing" :key="m.kind" class="flex flex-wrap items-center gap-2">
      <span class="text-amber-800">還沒有{{ m.label }}（術前準備的「同意書」勾不了）</span>
      <UButton v-if="auth.user?.role === 'doctor' && editable" size="sm" variant="secondary" @click="openRecord(m.kind, m.label)">記錄簽署</UButton>
    </div>
    <div v-if="isSurgeon && (s.status === 'requested' || s.status === 'scheduled')" class="text-right"><button type="button" class="text-slate-500 underline" @click="sf.side = s.side; sf.reason = ''; sideAct.fieldErrors.value = {}; sideOpen = true">更正側別（目前{{ SIDE_LABEL[s.side] }}）</button></div>
    <UDialog v-model="sideOpen" :title="`更正側別：${s.no}`" size="sm" @submit="submitSide">
      <div class="space-y-3 text-sm">
        <USelect v-model="sf.side" label="側別" :options="Object.entries(SIDE_LABEL).map(([v, l]) => ({ label: l, value: v }))" :error="sideAct.fieldErrors.value.side" />
        <UInput v-model="sf.reason" label="更正原因" placeholder="例：影像確認是左側" :error="sideAct.fieldErrors.value.reason" />
        <p class="text-xs text-amber-800">更正後：照舊側別簽的手術同意書不算了（要重簽），術前準備的同意書、手術部位標記取消。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="sideOpen = false">取消</UButton>
        <UButton type="submit" :loading="sideAct.pending.value">更正</UButton>
      </template>
    </UDialog>
    <UDialog v-model="open" :title="`${kindLabel}：${s.patientName} ${s.no}`" size="md" @submit="submit">
      <div class="space-y-3 text-sm">
        <UInput v-model="f.title" label="同意的項目" :error="act.fieldErrors.value.title" />
        <UTextarea v-model="f.explanation" label="說明重點（風險、替代方案、不做的後果）" :error="act.fieldErrors.value.explanation" />
        <div class="grid grid-cols-2 gap-2">
          <UInput v-model="f.signerName" label="簽署人" :error="act.fieldErrors.value.signerName" />
          <USelect v-model="f.relation" label="和病人的關係" :options="CONSENT_RELATIONS.map((r) => ({ label: r, value: r }))" :error="act.fieldErrors.value.relation" />
        </div>
        <UInput v-if="f.relation !== '本人'" v-model="f.reason" label="不是本人簽的原因" placeholder="例：病人意識不清、未成年" :error="act.fieldErrors.value.reason" />
        <p class="text-xs text-slate-500">紙本同意書由簽署人簽名後歸病歷；這裡記錄由你說明、誰簽署。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="kind = undefined">取消</UButton>
        <UButton type="submit" :loading="act.pending.value">記錄</UButton>
      </template>
    </UDialog>
    <ReasonDialog v-model="revokeOpen" title="撤回同意書" label="撤回原因" :presets="['病人決定先不開刀', '家屬要再討論', '改其他治療方式']" ok-text="撤回" danger :pending="revokeAct.pending.value" :error="revokeAct.fieldErrors.value.reason" @confirm="onRevoke" />
  </div>
</template>
