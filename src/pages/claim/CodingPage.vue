<script setup lang="ts">
// 疾病分類編碼審查（病歷管理師，權限「疾病分類」）：出院後看病摘與手術紀錄，確認或修改主診斷與次診斷；
// 改了要寫理由，修改前後的 DRG 試算一起看。審查過的住院才能申報。規則與 DRG 都在服務層（coding.ts）
import { computed, reactive, ref, watch } from 'vue'
import { UBadge, UButton, UDialog, UInput, UPageHeader, UQueryState, USearchSelect, UTabs } from '@/components/ui'
import SecondaryDxEditor from '@/components/SecondaryDxEditor.vue'
import { codingApi, masterApi, type CodingItem } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import type { IcdCode } from '@/types'

const { data, loading } = useQuery(() => codingApi.codingQueue(), [])
const mode = ref('todo')
const list = computed(() => (mode.value === 'todo' ? data.value?.todo : data.value?.done) ?? [])

const cur = ref<CodingItem>()
const open = computed({ get: () => !!cur.value, set: (x) => !x && (cur.value = undefined) })
const f = reactive({ mainIcd: '', mainLabel: '', secondary: [] as { icd: string; name: string }[], reason: '' })
function openCode(x: CodingItem) {
  const code = x.mainDiagnosis.match(/^[A-Z][0-9][0-9A-Z.]*/)?.[0] ?? ''
  Object.assign(f, { mainIcd: code, mainLabel: x.mainDiagnosis, secondary: x.secondary.map((s) => ({ ...s })), reason: '' })
  act.fieldErrors.value = {}
  cur.value = x
}
// 試算：照現在畫面上的編碼會分到哪一組
const { data: preview } = useQuery(async () => (cur.value && f.mainIcd ? codingApi.previewCoding(cur.value.admissionId, { mainIcd: f.mainIcd, secondary: f.secondary }) : undefined), [() => cur.value?.admissionId, () => f.mainIcd, () => f.secondary.map((x) => x.icd).join()])
watch(cur, () => (preview.value = undefined))
const act = useAction(codingApi.confirmCoding, { success: (r) => (r.item.coded?.changed ? `已修改編碼${!r.item.drgExempt && r.drgBefore.code !== r.drgAfter.code ? `（DRG ${r.drgBefore.code} → ${r.drgAfter.code}）` : ''}，已通知主治` : '已確認編碼') })
async function submit() {
  if (cur.value && (await act.run(cur.value.admissionId, { mainIcd: f.mainIcd, secondary: f.secondary, reason: f.reason }))) cur.value = undefined
}
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="編碼審查" description="出院後確認或修改主診斷與次診斷（DRG、健保申報以審查後的為準）" />
    <UTabs v-model="mode" :tabs="[{ key: 'todo', label: '待審查', count: data?.todo.length || undefined }, { key: 'done', label: '最近 30 天審查過' }]" />
    <UQueryState :loading="loading && !data" :ready="!!list.length" :empty-title="mode === 'todo' ? '沒有待審查的' : '最近沒有審查紀錄'">
      <ul class="space-y-2 text-sm">
        <li v-for="x in list" :key="x.admissionId" :class="['rounded-md border bg-white px-3 py-2', x.overdue ? 'border-red-300' : 'border-slate-200']">
          <div class="flex flex-wrap items-center gap-2">
            <b>{{ x.patientName }}</b><span class="text-xs text-slate-500">{{ x.chartNo }}・{{ x.admitNo }}・{{ x.deptName }} {{ x.doctorName }}・{{ x.admittedAt.slice(0, 10) }} ～ {{ x.dischargedAt.slice(0, 10) }}（{{ x.dischargeType }}）</span>
            <UBadge v-if="x.day" tone="purple">日間手術</UBadge>
            <UBadge v-if="x.overdue" tone="red">出院超過 7 天</UBadge>
            <UButton v-if="mode === 'todo' && data?.canCode" size="sm" class="ml-auto" @click="openCode(x)">審查</UButton>
          </div>
          <div class="text-xs text-slate-700">主診斷：{{ x.mainDiagnosis || '—' }}<template v-if="x.secondary.length">；次診斷：{{ x.secondary.map((s) => `${s.icd} ${s.name}`).join('、') }}</template><span v-else-if="x.noSecondaryField" class="text-slate-400">（舊病摘沒有次診斷欄位）</span></div>
          <div v-if="x.surgeries.length" class="text-xs text-slate-600">手術：{{ x.surgeries.join('；') }}</div>
          <div v-if="x.drgExempt" class="text-xs text-slate-500">不適用 DRG：{{ x.drgExempt }}（照實申報）</div>
          <div v-else class="text-xs text-slate-500">DRG <b>{{ x.drg.code }}</b> {{ x.drg.name }}（{{ x.drg.basis }}）</div>
          <div v-if="x.coded" class="text-xs" :class="x.coded.changed ? 'text-amber-800' : 'text-emerald-700'">
            {{ x.coded.changed ? '已修改' : '已確認' }}・{{ x.coded.byName }} {{ x.coded.at.slice(5) }}<template v-if="x.coded.changed">：{{ x.coded.reason }}（原 {{ x.coded.beforeText }}）</template>
            <div v-if="x.coded.changed" class="text-slate-600">主治：{{ x.coded.ack ?? '還沒讀' }}</div>
          </div>
        </li>
      </ul>
    </UQueryState>
    <UDialog v-model="open" :title="`編碼審查：${cur?.patientName ?? ''}（${cur?.admitNo ?? ''}）`" size="lg" @submit="submit">
      <div v-if="cur" class="space-y-3 text-sm">
        <div class="rounded bg-slate-50 px-3 py-2 text-xs text-slate-700">
          <div>病摘主診斷：{{ cur.summaryDiagnosis || '—' }}<template v-if="cur.summarySecondary.length">；次診斷：{{ cur.summarySecondary.map((s) => s.icd).join('、') }}</template></div>
          <div v-if="cur.course" class="mt-1 whitespace-pre-line">住院經過：{{ cur.course }}</div>
          <div v-if="cur.surgeries.length" class="mt-1">手術：{{ cur.surgeries.join('；') }}</div>
        </div>
        <div>
          <div class="text-sm font-medium text-slate-700">主診斷：<b class="tabular">{{ f.mainLabel }}</b></div>
          <USearchSelect placeholder="改主診斷：輸入 ICD 代碼或名稱" :search="(kw) => masterApi.searchIcd(kw)" :item-key="(c: IcdCode) => c.code" :item-label="(c: IcdCode) => `${c.code}　${c.name}`" @select="(c: IcdCode) => { f.mainIcd = c.code; f.mainLabel = `${c.code} ${c.name}` }" />
          <p v-if="act.fieldErrors.value.mainIcd" class="text-xs text-red-600">{{ act.fieldErrors.value.mainIcd }}</p>
        </div>
        <SecondaryDxEditor v-model="f.secondary" :error="act.fieldErrors.value.secondaryDiagnoses" />
        <p v-if="cur.drgExempt" class="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600">不適用 DRG：{{ cur.drgExempt }}（照實申報，編碼不影響給付）</p>
        <p v-else-if="preview" class="rounded border border-slate-200 px-2 py-1 text-xs">照這組編碼：DRG <b>{{ preview.code }}</b> {{ preview.name }}（定額 {{ preview.points.toLocaleString('zh-TW') }}）<template v-if="preview.code !== cur.drg.code"> ← 原本 {{ cur.drg.code }}（{{ cur.drg.points.toLocaleString('zh-TW') }}）</template></p>
        <UInput v-model="f.reason" label="修改理由（有改編碼才要寫）" :error="act.fieldErrors.value.reason" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="cur = undefined">取消</UButton>
        <UButton type="submit" :loading="act.pending.value">確認編碼</UButton>
      </template>
    </UDialog>
  </div>
</template>
