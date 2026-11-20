<script setup lang="ts">
// 門診處方裡需健保事前審查的藥（例：骨鬆注射筆）：顯示這個病人的送審狀態——核准在效期內才能健保開；
// 沒申請的可以在這裡申請並填病情摘要與理由（之後申報組送審）。核准前要開就勾「自費」。
// 能不能健保開、效期由服務層判斷（preauth.ts opdPreAuthStates；完成看診時 preauth-work.requireOpdDrugPreAuth 再擋一次）
import { computed, reactive, ref } from 'vue'
import { UButton, UDialog, UTextarea } from '@/components/ui'
import { preAuthApi, type PreAuthView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import type { MedicationOrder } from '@/types'

const props = defineProps<{ encounterId?: string; medications: MedicationOrder[]; editable: boolean }>()
const key = computed(() => props.medications.map((m) => m.drugId).join(','))
const { data } = useQuery(async () => (props.encounterId && key.value ? preAuthApi.opdPreAuthStates(props.encounterId, key.value.split(',')) : []), [key, () => props.encounterId])
const selfPayOf = (drugId: string) => props.medications.filter((m) => m.drugId === drugId).every((m) => m.selfPay)

const cur = ref<PreAuthView>()
const open = computed({ get: () => !!cur.value, set: (x) => !x && (cur.value = undefined) })
const f = reactive({ summary: '', reason: '', note: '' })
function openFill(p: PreAuthView) {
  Object.assign(f, { summary: p.summary ?? '', reason: p.reason ?? '', note: '' })
  fillAct.fieldErrors.value = {}
  cur.value = p
}
const reqAct = useAction(preAuthApi.requestOpdDrugPreAuth, { success: (p) => `已建立送審單 ${p.no}：請填病情摘要與理由` })
async function request(drugId: string) {
  const p = await reqAct.run(props.encounterId!, drugId)
  if (p) openFill(p)
}
const fillAct = useAction(preAuthApi.fillPreAuth, { success: '已填寫，等申報組送審；核准後效期內回診就能健保開' })
async function submit() {
  if (cur.value && (await fillAct.run(cur.value.id, { summary: f.summary, reason: f.reason, note: f.note }))) cur.value = undefined
}
</script>

<template>
  <div v-if="data?.length" class="space-y-1">
    <div v-for="s in data" :key="s.drugId" :class="['flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-xs', s.valid ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-300 bg-amber-50 text-amber-900']">
      <b>{{ s.drugName }}</b>
      <template v-if="s.valid">健保事前審查核准（{{ s.preAuth!.no }}，效期到 {{ s.preAuth!.validUntil }}<template v-if="s.preAuth!.qty">，核准 {{ s.preAuth!.qty.approved }} {{ s.preAuth!.qty.unit }}、已開 {{ s.preAuth!.qty.used }}、<b>還剩 {{ s.preAuth!.qty.left }}</b></template><template v-if="s.preAuth!.times">，核准 {{ s.preAuth!.times.approved }} 次、<b>還剩 {{ s.preAuth!.times.left }} 次</b></template>）：可以健保開<span v-if="s.preAuth!.monthlyQty">，每月最多 {{ s.preAuth!.monthlyQty }}</span><span v-if="s.preAuth!.interval">，每次間隔 {{ s.preAuth!.interval }} 天<template v-if="s.lastNhi">（上次 {{ s.lastNhi }}）</template></span><span v-if="s.preAuth?.expiring" class="font-medium text-amber-800">・快到期：{{ s.preAuth.expiring }}</span><span v-if="s.wait" class="font-semibold text-red-700">・還要 {{ s.wait }} 天才能健保開</span><span v-if="(s.preAuth!.qty && !s.preAuth!.qty.left) || (s.preAuth!.times && !s.preAuth!.times.left)" class="font-semibold text-red-700">・核准量或次數已用完，請重新申請或自費</span></template>
      <template v-else>
        需健保事前審查：{{ s.preAuth ? `${s.preAuth.no} ${s.preAuth.statusLabel}` : '還沒申請' }}<template v-if="s.preAuth?.status === 'more'">（{{ s.preAuth.resultText }}）</template>
        <span :class="selfPayOf(s.drugId) ? 'text-slate-600' : 'font-semibold text-red-700'">{{ selfPayOf(s.drugId) ? '・這次自費開' : '・核准前只能自費開（勾「自費」）' }}</span>
      </template>
      <span v-if="editable" class="ml-auto flex gap-1">
        <UButton v-if="!s.preAuth" size="sm" variant="secondary" :loading="reqAct.pending.value" @click="request(s.drugId)">申請事前審查</UButton>
        <UButton v-else-if="s.valid && s.preAuth.expiring" size="sm" variant="secondary" :loading="reqAct.pending.value" @click="request(s.drugId)">續約申請</UButton>
        <UButton v-else-if="['draft', 'more', 'ready'].includes(s.preAuth.status)" size="sm" variant="secondary" @click="openFill(s.preAuth)">{{ s.preAuth.status === 'more' ? '補件' : s.preAuth.status === 'ready' ? '修改送審資料' : '填寫送審資料' }}</UButton>
      </span>
    </div>
    <UDialog v-model="open" :title="`${cur?.status === 'more' ? '補件' : '填寫送審資料'}：${cur?.itemName ?? ''}（門診）`" size="md" @submit="submit">
      <div class="space-y-3 text-sm">
        <p v-if="cur?.status === 'more'" class="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{{ cur.resultText }}</p>
        <UTextarea v-model="f.summary" label="病情摘要（診斷、相關檢查結果）" placeholder="例：停經後骨質疏鬆，骨密度 T 值 −3.2，已有兩處脊椎壓迫性骨折" :error="fillAct.fieldErrors.value.summary" />
        <UTextarea v-model="f.reason" label="使用理由" placeholder="例：使用雙磷酸鹽一年後仍新發骨折，符合給付規定" :error="fillAct.fieldErrors.value.reason" />
        <UTextarea v-if="cur?.status === 'more'" v-model="f.note" label="補了哪些資料" :error="fillAct.fieldErrors.value.note" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="cur = undefined">取消</UButton>
        <UButton type="submit" :loading="fillAct.pending.value">送出</UButton>
      </template>
    </UDialog>
  </div>
</template>
