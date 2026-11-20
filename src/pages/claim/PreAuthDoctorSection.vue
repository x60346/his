<script setup lang="ts">
// 主治的事前審查：填寫（或補件）病情摘要與理由、病人同意改自費、緊急先用（寫理由）。
// 誰能做、什麼狀態能做由服務層判斷（preauth.ts）
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UDialog, UInput, UQueryState, UTextarea } from '@/components/ui'
import { preAuthApi, type PreAuthView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => preAuthApi.myPreAuths(), [])
const TONE = { draft: 'yellow', ready: 'gray', submitted: 'blue', more: 'yellow', approved: 'green', rejected: 'red' } as const

const mode = ref<'fill' | 'self' | 'emergency'>()
const cur = ref<PreAuthView>()
const open = computed({ get: () => !!cur.value, set: (x) => !x && (cur.value = undefined) })
const f = reactive({ summary: '', reason: '', note: '', text: '' })
function openAs(p: PreAuthView, m: 'fill' | 'self' | 'emergency') {
  Object.assign(f, { summary: p.summary ?? '', reason: p.reason ?? '', note: '', text: '' })
  for (const a of [fillAct, selfAct, emAct]) a.fieldErrors.value = {}
  mode.value = m
  cur.value = p
}
const fillAct = useAction(preAuthApi.fillPreAuth, { success: '已填寫，等申報組送審' })
const selfAct = useAction(preAuthApi.selfPayPreAuth, { success: '已記錄病人同意自費：這次照自費算，可以先用' })
const emAct = useAction(preAuthApi.emergencyPreAuth, { success: '已記錄緊急理由：可以先用（仍要送審）' })
async function submit() {
  if (!cur.value) return
  const ok = mode.value === 'fill' ? await fillAct.run(cur.value.id, { summary: f.summary, reason: f.reason, note: f.note }) : mode.value === 'self' ? await selfAct.run(cur.value.id, f.text) : await emAct.run(cur.value.id, f.text)
  if (ok) cur.value = undefined
}
const errs = computed(() => (mode.value === 'fill' ? fillAct : mode.value === 'self' ? selfAct : emAct).fieldErrors.value)
</script>

<template>
  <section class="space-y-2">
    <h2 class="font-semibold text-slate-700">事前審查</h2>
    <UQueryState :loading="loading && !data" :ready="!!data?.length" empty-title="沒有事前審查">
      <ul v-if="data" class="space-y-2 text-sm">
        <li v-for="p in data" :key="p.id" class="rounded-md border border-slate-200 bg-white px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge :tone="TONE[p.status]">{{ p.statusLabel }}</UBadge>
            <b>{{ p.itemName }}</b><span class="text-xs text-slate-500">{{ p.no }}・{{ p.patientName }}（{{ p.admitNo || '門診' }}）</span>
            <UBadge v-if="p.validUntil" tone="green">門診效期 {{ p.validFrom }} ～ {{ p.validUntil }}</UBadge>
            <UBadge v-if="p.allows && p.status !== 'approved'" tone="purple">可以先用</UBadge>
            <UBadge v-if="p.expiring" tone="yellow">快到期：{{ p.expiring }}（看診時可續約申請）</UBadge>
          </div>
          <div v-if="p.summary" class="mt-1 text-xs text-slate-700">病情：{{ p.summary }}<br />理由：{{ p.reason }}</div>
          <div v-if="p.resultText" class="text-xs" :class="p.status === 'rejected' ? 'text-red-700' : p.status === 'more' ? 'font-medium text-amber-800' : 'text-emerald-700'">審查結果：{{ p.resultText }}</div>
          <div v-if="p.selfPayText" class="text-xs text-slate-600">{{ p.selfPayText }}</div>
          <div v-if="p.emergencyText" class="text-xs text-amber-800">{{ p.emergencyText }}</div>
          <div v-if="!['approved', 'rejected'].includes(p.status)" class="mt-1 flex flex-wrap justify-end gap-2">
            <UButton v-if="['draft', 'more', 'ready'].includes(p.status)" size="sm" :variant="p.status === 'ready' ? 'secondary' : 'primary'" @click="openAs(p, 'fill')">{{ p.status === 'more' ? '補件' : p.status === 'ready' ? '修改' : '填寫' }}</UButton>
            <UButton v-if="!p.selfPay && !p.opd" size="sm" variant="secondary" @click="openAs(p, 'self')">病人同意自費</UButton>
            <UButton v-if="!p.emergency && !p.opd" size="sm" variant="ghost" class="text-red-700" @click="openAs(p, 'emergency')">緊急先用</UButton>
          </div>
        </li>
      </ul>
    </UQueryState>
    <UDialog v-model="open" :title="`${mode === 'fill' ? (cur?.status === 'more' ? '補件' : '填寫送審資料') : mode === 'self' ? '病人同意自費' : '緊急先用'}：${cur?.itemName ?? ''}`" size="md" @submit="submit">
      <div class="space-y-3 text-sm">
        <template v-if="mode === 'fill'">
          <p v-if="cur?.status === 'more'" class="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{{ cur.resultText }}</p>
          <UTextarea v-model="f.summary" label="病情摘要（診斷、相關檢查結果）" :error="errs.summary" />
          <UTextarea v-model="f.reason" label="使用理由" :error="errs.reason" />
          <UInput v-if="cur?.status === 'more'" v-model="f.note" label="補了哪些資料" :error="errs.note" />
        </template>
        <template v-else>
          <p class="text-xs text-slate-600">{{ mode === 'self' ? '這次用的照自費算（之後核准也不退）。' : '核准前先用：仍要送審，申報時沒核准會被檢核出來。' }}</p>
          <UInput v-model="f.text" :label="mode === 'self' ? '同意情形' : '緊急理由'" :placeholder="mode === 'self' ? '例：病人已簽自費同意書，了解費用' : '例：重症感染惡化，不能等兩週審查'" :error="mode === 'self' ? errs.note : errs.reason" />
        </template>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="cur = undefined">取消</UButton>
        <UButton type="submit" :variant="mode === 'emergency' ? 'danger' : 'primary'" :loading="fillAct.pending.value || selfAct.pending.value || emAct.pending.value">送出</UButton>
      </template>
    </UDialog>
  </section>
</template>
