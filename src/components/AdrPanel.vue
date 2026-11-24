<script setup lang="ts">
// 藥物不良反應（住院醫囑、護理站的病人分頁「不良反應」共用）：這次住院的通報與藥師評估結果；醫師、護理師「通報」——
// 懷疑的藥只能選這次住院給過的（給藥紀錄），寫發生時間、症狀、嚴重度（嚴重型另勾）、處置。評估在住院藥局。規則在服務層 adr.ts
import { computed, reactive, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UQueryState, USelect, UTextarea } from '@/components/ui'
import { ADR_SERIOUS, ADR_SEVERITY_LABEL, adrApi } from '@/services'
import type { AdrSeverity } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { now } from '@/utils/date'

const props = defineProps<{ admissionId: string }>()
const auth = useAuth()
const canReport = computed(() => auth.user?.role === 'doctor' || auth.user?.role === 'nurse')
const { data, loading } = useQuery(() => adrApi.patientAdrs(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))

const open = ref(false)
const f = reactive({ drugId: '' as string | number | undefined, onsetAt: '', symptoms: '', severity: '' as string | number | undefined, serious: '' as string | number | undefined, action: '' })
function openReport() {
  Object.assign(f, { drugId: v.value?.drugs[0]?.drugId ?? '', onsetAt: now().replace(' ', 'T'), symptoms: '', severity: '', serious: '', action: '' })
  rep.fieldErrors.value = {}
  open.value = true
}
const rep = useAction(adrApi.reportAdr, { success: '已通報，藥師會評估因果關係' })
async function submit() {
  const ok = await rep.run({
    admissionId: props.admissionId, drugId: String(f.drugId ?? ''), onsetAt: String(f.onsetAt).replace('T', ' ').slice(0, 16), symptoms: f.symptoms,
    severity: String(f.severity ?? '') as AdrSeverity, ...(f.serious ? { serious: f.serious as 'anaphylaxis' | 'sjs' } : {}), action: f.action,
  })
  if (ok) open.value = false
}
const sevTone = { mild: 'gray', moderate: 'yellow', severe: 'red' } as const
</script>

<template>
  <UQueryState :loading="loading && !v" :ready="!!v">
    <div v-if="v" class="space-y-3">
      <div class="flex items-center gap-2">
        <p class="flex-1 text-sm text-slate-600">懷疑是藥物引起的不良反應（皮疹、過敏、肝腎功能異常…）請通報，藥師評估因果後，很可能以上會加入過敏紀錄。</p>
        <UButton v-if="canReport" size="sm" :icon="Plus" :disabled="!v.drugs.length" @click="openReport">通報</UButton>
      </div>
      <p v-if="!v.reports.length" class="text-sm text-slate-400">這次住院沒有不良反應通報。</p>
      <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
        <li v-for="r in v.reports" :key="r.id" class="space-y-0.5 px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <b>{{ r.drugName }}</b>
            <UBadge :tone="sevTone[r.severity]">{{ r.severityLabel }}</UBadge>
            <UBadge v-if="r.seriousLabel" tone="red">{{ r.seriousLabel }}</UBadge>
            <UBadge v-if="r.assessment" :tone="r.assessment.causality === 'definite' || r.assessment.causality === 'probable' ? 'red' : 'gray'" class="ml-auto">藥師評估：{{ r.causalityLabel }}（{{ r.assessment.score }} 分）</UBadge>
            <UBadge v-else :tone="r.overdue ? 'red' : 'yellow'" class="ml-auto">{{ r.overdue ? '評估逾時' : '待藥師評估' }}</UBadge>
          </div>
          <div class="text-slate-700">{{ r.symptoms }}</div>
          <div class="tabular text-xs text-slate-500">發生 {{ r.onsetAt.slice(5).replace('-', '/') }}・處置：{{ r.action }}・{{ r.reportedByName }} {{ r.reportedAt.slice(5).replace('-', '/') }} 通報</div>
          <div v-if="r.assessment" class="text-xs text-slate-600">{{ r.assessedByName }}：{{ r.assessment.note || '—' }}<template v-if="r.assessment.allergyAdded">；<b class="text-red-700">已加入過敏 {{ r.assessment.allergyAdded }}</b></template></div>
        </li>
      </ul>
    </div>
  </UQueryState>

  <UDialog v-model="open" title="藥物不良反應通報" size="md">
    <div class="space-y-3">
      <USelect v-model="f.drugId" label="懷疑的藥（這次住院給過的）" required :options="(v?.drugs ?? []).map((d) => ({ label: `${d.name}（最近一次 ${d.lastGivenAt.slice(5).replace('-', '/')}）`, value: d.drugId }))" :error="rep.fieldErrors.value.drugId" />
      <UInput v-model="f.onsetAt" type="datetime-local" label="發生時間" required :error="rep.fieldErrors.value.onsetAt" />
      <UTextarea v-model="f.symptoms" label="症狀" required :rows="2" placeholder="例：前胸、背部紅疹伴搔癢" :error="rep.fieldErrors.value.symptoms" />
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <USelect v-model="f.severity" label="嚴重度" required :options="Object.entries(ADR_SEVERITY_LABEL).map(([k, l]) => ({ label: l, value: k }))" :error="rep.fieldErrors.value.severity" />
        <USelect v-model="f.serious" label="嚴重型（選填，24 小時內評估）" :options="[{ label: '無', value: '' }, ...ADR_SERIOUS.map((x) => ({ label: x.label, value: x.key }))]" :error="rep.fieldErrors.value.serious" />
      </div>
      <UInput v-model="f.action" label="處置" required placeholder="例：停藥、給抗組織胺、已通知主治" :error="rep.fieldErrors.value.action" />
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :loading="rep.pending.value" @click="submit">通報</UButton>
    </template>
  </UDialog>
</template>
