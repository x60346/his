<script setup lang="ts">
// 事前審查（申報組）：每張送審單的狀態（逾時、待送審在前）；送審；記結果（核准可寫期限、不核准要理由、補件要寫補什麼）。
// 狀態、能不能送、不核准停醫囑都在服務層（preauth.ts、preauth-rules）
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import { preAuthApi, PREAUTH_DAYS, type PreAuthView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => preAuthApi.preAuthBoard(), [])
const TONE = { draft: 'gray', ready: 'yellow', submitted: 'blue', more: 'yellow', approved: 'green', rejected: 'red' } as const
const subAct = useAction(preAuthApi.submitPreAuth, { success: (p) => `已送審 ${p.no}` })
const resFor = ref<PreAuthView>()
const open = computed({ get: () => !!resFor.value, set: (x) => !x && (resFor.value = undefined) })
const f = reactive({ outcome: 'approved' as string | number | undefined, note: '', until: '' })
function openRes(p: PreAuthView) {
  Object.assign(f, { outcome: 'approved', note: '', until: '' })
  resAct.fieldErrors.value = {}
  resFor.value = p
}
const resAct = useAction(preAuthApi.recordPreAuthResult, { success: (p) => `${p.no}：${p.statusLabel}` })
async function submitRes() {
  if (resFor.value && (await resAct.run(resFor.value.id, { outcome: f.outcome as 'approved' | 'rejected' | 'more', note: f.note, ...(f.until ? { until: f.until } : {}) }))) resFor.value = undefined
}
</script>

<template>
  <UQueryState :loading="loading && !data" :ready="!!data" empty-title="沒有事前審查">
    <div v-if="data" class="space-y-2 text-sm">
      <p class="text-xs text-slate-500">需事前審查的藥開住院醫囑時自動建單、特殊材料由主刀申請；主治填好就能送審。送審超過 {{ PREAUTH_DAYS }} 天沒結果標紅。核准前不能用（病人同意自費、醫師寫緊急理由除外）。</p>
      <div v-for="p in data" :key="p.id" :class="['rounded-md border bg-white px-3 py-2', p.overdue ? 'border-red-300' : 'border-slate-200']">
        <div class="flex flex-wrap items-center gap-2">
          <UBadge :tone="TONE[p.status]">{{ p.statusLabel }}</UBadge>
          <span v-if="p.overdue" class="text-xs font-semibold text-red-700">審查 {{ p.days }} 天還沒結果</span>
          <b>{{ p.itemName }}</b><span class="text-xs text-slate-500">{{ p.no }}・{{ p.kind === 'drug' ? '藥品' : '特殊材料' }}</span>
          <span class="text-xs text-slate-600">{{ p.patientName }}（{{ p.chartNo }}・{{ p.admitNo }}）・主治 {{ p.doctorName }}</span>
          <span class="ml-auto flex gap-2">
            <UButton v-if="p.status === 'ready'" size="sm" :loading="subAct.pending.value" @click="subAct.run(p.id)">送審</UButton>
            <UButton v-if="p.status === 'submitted'" size="sm" variant="secondary" @click="openRes(p)">記錄結果</UButton>
          </span>
        </div>
        <div v-if="p.summary" class="mt-1 text-xs text-slate-700">病情：{{ p.summary }}<br />理由：{{ p.reason }}</div>
        <div v-for="(n, i) in p.notesText" :key="i" class="text-xs text-slate-500">{{ n }}</div>
        <div v-if="p.submittedAt" class="text-xs text-slate-500">送審 {{ p.submittedAt.slice(5) }}<template v-if="p.status === 'submitted'">（{{ p.days }} 天）</template></div>
        <div v-if="p.resultText" class="text-xs" :class="p.status === 'rejected' ? 'text-red-700' : p.status === 'approved' ? 'text-emerald-700' : 'text-amber-800'">結果：{{ p.resultText }}</div>
        <div v-if="p.selfPayText" class="text-xs text-slate-600">{{ p.selfPayText }}</div>
        <div v-if="p.emergencyText" class="text-xs text-amber-800">{{ p.emergencyText }}</div>
      </div>
    </div>
    <UDialog v-model="open" :title="`審查結果：${resFor?.itemName ?? ''}（${resFor?.patientName ?? ''}）`" size="sm" @submit="submitRes">
      <div class="space-y-3 text-sm">
        <USelect v-model="f.outcome" label="結果" :options="[{ label: '核准', value: 'approved' }, { label: '不核准', value: 'rejected' }, { label: '補件', value: 'more' }]" :error="resAct.fieldErrors.value.outcome" />
        <UInput v-if="f.outcome === 'approved'" v-model="f.until" type="date" label="核准期限（選填）" :error="resAct.fieldErrors.value.until" />
        <UInput v-model="f.note" :label="f.outcome === 'rejected' ? '不核准理由' : f.outcome === 'more' ? '要補哪些資料' : '備註（選填）'" :error="resAct.fieldErrors.value.note" />
        <p v-if="f.outcome === 'rejected' && resFor?.kind === 'drug'" class="text-xs text-red-700">不核准：這次住院這個藥還在用的醫囑會自動停止（病人已同意自費的不停）。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="resFor = undefined">取消</UButton>
        <UButton type="submit" :loading="resAct.pending.value">記錄</UButton>
      </template>
    </UDialog>
  </UQueryState>
</template>
