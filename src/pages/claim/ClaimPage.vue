<script setup lang="ts">
// 健保申報（權限「健保申報」）：門診（含急診）、住院（含日間手術）每月一份——每一筆的點數與送件前檢核、
// 有問題的先改資料或註記排除、月份結束後送出（鎖定）、匯出 CSV；送出後才改的列在下一個月「補報」。
// 點數、檢核、能不能送都由服務層算（claim.ts、claim-rules）
import { computed, ref, watch } from 'vue'
import { Download, Send } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UPageHeader, UQueryState, USelect, UTabs } from '@/components/ui'
import ClaimCutPanel from './ClaimCutPanel.vue'
import PreAuthPanel from './PreAuthPanel.vue'
import { CLAIM_CATEGORIES, CLAIM_CATEGORY_LABEL, claimApi, DRG_PAY_RULE_LABEL } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import { downloadFile } from '@/utils/download'

const kind = ref<'opd' | 'ipd' | 'cuts' | 'preauth'>('opd')
const month = ref<string>()
watch(kind, () => (month.value = undefined))
const { data, loading } = useQuery(async () => (kind.value === 'cuts' || kind.value === 'preauth' ? undefined : claimApi.claimBoard(kind.value, month.value)), [kind, month])
const b = computed(() => (data.value && data.value.kind === kind.value ? data.value : undefined))
const onlyProblems = ref(false)
const rows = computed(() => (b.value?.rows ?? []).filter((r) => !onlyProblems.value || r.problems.length))
const fmt = (n: number) => n.toLocaleString('zh-TW')

const ui = useUi()
const submitAct = useAction(claimApi.submitClaim, { success: (x) => `已送出 ${x.month}：${x.totals.count} 筆、申請 ${fmt(x.totals.claim)} 點` })
async function submit() {
  if (!b.value) return
  if (!(await ui.confirm({ title: `送出 ${b.value.month} 申報`, message: `${b.value.totals.count} 筆、申請 ${fmt(b.value.totals.claim)} 點。送出後這個月鎖定，之後的更正列在下個月補報。`, okText: '送出' }))) return
  await submitAct.run(b.value.kind, b.value.month)
}
async function exportCsv() {
  if (!b.value) return
  const r = await claimApi.claimCsvOf(b.value.kind, b.value.month)
  downloadFile('﻿' + r.csv, 'text/csv;charset=utf-8', r.filename)
}

// 註記排除
const exFor = ref<{ refId: string; label: string }>()
const exOpen = computed({ get: () => !!exFor.value, set: (x) => !x && (exFor.value = undefined) })
const reason = ref('')
const exAct = useAction(claimApi.excludeClaim, { success: '已註記排除' })
const unAct = useAction(claimApi.unexcludeClaim, { success: '已取消排除' })
async function submitEx() {
  if (b.value && exFor.value && (await exAct.run(b.value.kind, b.value.month, exFor.value.refId, reason.value))) exFor.value = undefined
}
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="健保申報" description="每月門診、住院申報：檢核、註記排除、送出鎖定、匯出；核減與申復">
      <USelect v-if="b" :model-value="b.month" class="w-40" aria-label="月份" :options="b.months.map((m) => ({ label: `${m.month}${m.submitted ? '（已送）' : ''}`, value: m.month }))" @update:model-value="(v) => (month = String(v))" />
    </UPageHeader>
    <UTabs v-model="kind" :tabs="[{ key: 'opd', label: '門診（含急診）' }, { key: 'ipd', label: '住院（含日間手術）' }, { key: 'cuts', label: '核減與申復' }, { key: 'preauth', label: '事前審查' }]" />
    <ClaimCutPanel v-if="kind === 'cuts'" />
    <PreAuthPanel v-else-if="kind === 'preauth'" />
    <UQueryState v-else :loading="loading && !b" :ready="!!b">
      <template v-if="b">
        <section class="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 bg-white p-3 text-sm">
          <div><div class="text-xs text-slate-500">{{ b.month }} 申報</div><div class="tabular text-2xl font-semibold text-slate-800">{{ fmt(b.totals.claim) }} 點</div></div>
          <div class="text-xs text-slate-600">
            {{ b.totals.count }} 筆・健保點數 {{ fmt(b.totals.points) }}・部分負擔 {{ fmt(b.totals.copay) }}<template v-if="b.totals.supplement">・補報 {{ b.totals.supplement }} 筆</template><template v-if="b.totals.excluded">・排除 {{ b.totals.excluded }} 筆</template>
            <div v-if="b.totals.drg" class="mt-0.5">DRG {{ b.totals.drg.count }} 筆，盈虧合計 <b :class="b.totals.drg.diff < 0 ? 'text-red-700' : 'text-emerald-700'">{{ b.totals.drg.diff >= 0 ? '+' : '' }}{{ fmt(b.totals.drg.diff) }}</b> 點<template v-if="b.totals.drg.exempt">・不適用 DRG {{ b.totals.drg.exempt }} 筆</template><template v-if="b.totals.drg.cmi !== null">・CMI {{ b.totals.drg.cmi.toFixed(2) }}</template></div>
            <div class="mt-0.5 flex flex-wrap gap-2">
              <span v-for="c in b.totals.byCase" :key="c.caseType" class="rounded bg-slate-100 px-1.5">{{ c.label }}：{{ c.count }} 筆 {{ fmt(c.claim) }} 點</span>
            </div>
          </div>
          <div class="ml-auto flex flex-wrap items-center gap-2">
            <UBadge v-if="b.submitted" tone="green">已送出・{{ b.submitted.at.slice(5) }} {{ b.submitted.byName }}</UBadge>
            <UBadge v-else-if="b.totals.problems" tone="red">檢核有問題 {{ b.totals.problems }} 筆</UBadge>
            <UButton size="sm" variant="secondary" :icon="Download" @click="exportCsv">匯出 CSV</UButton>
            <UButton v-if="!b.submitted" size="sm" :icon="Send" :disabled="!b.canSubmit" :title="b.whyNot" :loading="submitAct.pending.value" @click="submit">送出</UButton>
          </div>
          <p v-if="!b.submitted && b.whyNot" class="w-full text-xs text-amber-800">{{ b.whyNot }}</p>
        </section>

        <label v-if="!b.submitted && b.totals.problems" class="flex items-center gap-2 text-sm text-slate-600"><input v-model="onlyProblems" type="checkbox" /> 只看檢核有問題的</label>
        <div class="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table class="w-full text-sm">
            <thead class="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th class="px-2 py-1.5 text-left">{{ b.kind === 'ipd' ? '出院日' : '就醫日' }}</th><th class="px-2 text-left">案件</th><th class="px-2 text-left">病人</th><th class="px-2 text-left">醫師</th><th class="px-2 text-left">主診斷</th>
                <th v-if="b.kind === 'ipd'" class="px-2 text-right">天數</th>
                <th class="px-2 text-right">健保點數</th><th class="px-2 text-right">部分負擔</th><th class="px-2 text-right">申請點數</th><th class="px-2" />
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <template v-for="r in rows" :key="r.refId + (r.supplementOf ?? '')">
                <tr :class="r.excluded ? 'text-slate-400' : r.problems.length ? 'bg-red-50/50' : ''">
                  <td class="tabular px-2 py-1.5">{{ r.date }}</td>
                  <td class="px-2"><span class="text-xs">{{ r.caseLabel }}</span><UBadge v-if="r.supplementOf" tone="yellow" class="ml-1">補報（{{ r.supplementOf }}）</UBadge></td>
                  <td class="px-2">{{ r.patientName }}<span class="ml-1 text-xs text-slate-400">{{ r.chartNo }}</span></td>
                  <td class="px-2 text-xs">{{ r.doctorName }}</td>
                  <td class="px-2 text-xs">{{ r.diagnosis || '—' }}</td>
                  <td v-if="b.kind === 'ipd'" class="tabular px-2 text-right">{{ r.days ?? '' }}</td>
                  <td class="tabular px-2 text-right">{{ fmt(r.points) }}</td>
                  <td class="tabular px-2 text-right">{{ fmt(r.copay) }}</td>
                  <td class="tabular px-2 text-right font-medium">{{ fmt(r.claim) }}</td>
                  <td class="px-2 text-right">
                    <template v-if="!b.submitted && !r.supplementOf">
                      <UButton v-if="r.excluded" size="sm" variant="ghost" @click="unAct.run(b.kind, b.month, r.refId)">取消排除</UButton>
                      <UButton v-else-if="r.problems.length" size="sm" variant="ghost" @click="exFor = { refId: r.refId, label: `${r.patientName} ${r.date}` }; reason = ''">註記排除</UButton>
                    </template>
                  </td>
                </tr>
                <tr v-if="r.problems.length && !r.excluded" class="bg-red-50/50"><td :colspan="b.kind === 'ipd' ? 10 : 9" class="px-2 pb-1.5 text-xs text-red-700">檢核：{{ r.problems.join('；') }}</td></tr>
                <tr v-if="r.excluded"><td :colspan="b.kind === 'ipd' ? 10 : 9" class="px-2 pb-1.5 text-xs text-slate-500">已排除：{{ r.excluded.reason }}（{{ r.excluded.byName }}）</td></tr>
                <tr v-if="b.kind === 'ipd' && r.categories && !r.excluded"><td colspan="10" class="px-2 pb-1.5 text-xs text-slate-500">{{ CLAIM_CATEGORIES.filter((c) => r.categories?.[c]).map((c) => `${CLAIM_CATEGORY_LABEL[c]} ${fmt(r.categories![c]!)}`).join('・') }}
                  <div v-if="r.drg" class="text-slate-700">DRG <b>{{ r.drg.code }}</b> {{ r.drg.name }}・定額 {{ fmt(r.drg.points) }}・給付 {{ fmt(r.drg.pay) }}（{{ DRG_PAY_RULE_LABEL[r.drg.rule] }}）・<span :class="r.drg.diff < 0 ? 'text-red-700' : 'text-emerald-700'">{{ r.drg.diff >= 0 ? '盈' : '虧' }} {{ fmt(Math.abs(r.drg.diff)) }}</span></div>
                  <div v-else-if="r.drgExempt" class="text-slate-600">不適用 DRG：{{ r.drgExempt }}（照實申報）</div></td></tr>
              </template>
              <tr v-if="!rows.length"><td colspan="10" class="px-2 py-4 text-center text-slate-400">這個月沒有要申報的</td></tr>
            </tbody>
          </table>
        </div>
      </template>
    </UQueryState>
    <UDialog v-model="exOpen" :title="`註記排除：${exFor?.label ?? ''}`" size="sm" @submit="submitEx">
      <UInput v-model="reason" label="排除原因" placeholder="例：病人改自費、重複掛號已退費" :error="exAct.fieldErrors.value.reason" />
      <template #footer>
        <UButton variant="secondary" @click="exFor = undefined">取消</UButton>
        <UButton type="submit" :loading="exAct.pending.value">排除</UButton>
      </template>
    </UDialog>
  </div>
</template>
