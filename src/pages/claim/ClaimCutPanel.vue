<script setup lang="ts">
// 核減與申復（申報組）：每月申報、核減、補付點數與核減率；輸入健保署的核減（送出過的月份的一筆）；
// 主治回覆後，申復的記結果（補付幾點或維持）。能不能輸入、點數上限由服務層判斷（claim-cut.ts、claim-rules）
import { computed, reactive, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import { CLAIM_KIND_LABEL, claimCutApi, CUT_REASONS, type CutItem } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data: v, loading } = useQuery(() => claimCutApi.cutBoard(), [])
const fmt = (n: number) => n.toLocaleString('zh-TW')
const TONE = { reply: 'yellow', appealed: 'purple', accepted: 'gray', paid: 'green', upheld: 'red' } as const

const addOpen = ref(false)
const af = reactive({ submissionId: '' as string | number | undefined, refId: '' as string | number | undefined, item: '', points: undefined as number | undefined, code: '' as string | number | undefined, reason: '' })
const sub = computed(() => v.value?.submissions.find((s) => s.id === af.submissionId))
function openAdd() {
  Object.assign(af, { submissionId: v.value?.submissions[0]?.id ?? '', refId: '', item: '', points: undefined, code: '', reason: '' })
  addAct.fieldErrors.value = {}
  addOpen.value = true
}
const addAct = useAction(claimCutApi.addCut, { success: (c) => `已輸入核減：${c.patientName} ${c.item} ${c.points} 點，已通知主治` })
async function submitAdd() {
  if (await addAct.run({ submissionId: String(af.submissionId ?? ''), refId: String(af.refId ?? ''), item: af.item, points: Number(af.points), code: String(af.code ?? ''), reason: af.reason })) addOpen.value = false
}

const resFor = ref<CutItem>()
const resOpen = computed({ get: () => !!resFor.value, set: (x) => !x && (resFor.value = undefined) })
const rf = reactive({ outcome: 'paid' as string | number | undefined, points: undefined as number | undefined })
function openRes(c: CutItem) {
  Object.assign(rf, { outcome: 'paid', points: c.points })
  resAct.fieldErrors.value = {}
  resFor.value = c
}
const resAct = useAction(claimCutApi.recordCutResult, { success: (c) => `已記錄：${c.resultText}` })
async function submitRes() {
  if (resFor.value && (await resAct.run(resFor.value.id, { outcome: rf.outcome as 'paid' | 'upheld', points: Number(rf.points) }))) resFor.value = undefined
}
</script>

<template>
  <UQueryState :loading="loading && !v" :ready="!!v">
    <div v-if="v" class="space-y-3 text-sm">
      <section class="overflow-x-auto rounded-md border border-slate-200 bg-white p-3">
        <h3 class="mb-1 font-semibold text-slate-700">每月核減率<span class="ml-2 text-xs font-normal text-slate-500">淨核減＝核減 − 申復補付；核減率＝淨核減 ÷ 申報點數</span></h3>
        <table class="w-full text-sm">
          <thead class="text-xs text-slate-500"><tr><th class="py-1 text-left">月份</th><th class="text-left">類別</th><th class="text-right">申報</th><th class="text-right">核減</th><th class="text-right">補付</th><th class="text-right">淨核減</th><th class="text-right">核減率</th><th class="text-right">待處理</th></tr></thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="m in v.months" :key="m.kind + m.month">
              <td class="tabular py-1">{{ m.month }}</td><td class="text-xs">{{ CLAIM_KIND_LABEL[m.kind] }}</td>
              <td class="tabular text-right">{{ fmt(m.claimed) }}</td><td class="tabular text-right">{{ fmt(m.cut) }}</td><td class="tabular text-right">{{ fmt(m.paid) }}</td><td class="tabular text-right">{{ fmt(m.net) }}</td>
              <td class="tabular text-right" :class="m.rate >= 3 ? 'font-semibold text-red-700' : ''">{{ m.rate }}%</td><td class="tabular text-right">{{ m.pending || '' }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <div class="flex items-center gap-2">
        <h3 class="font-semibold text-slate-700">核減</h3>
        <UButton v-if="v.canManage && v.submissions.length" size="sm" class="ml-auto" :icon="Plus" @click="openAdd">輸入核減</UButton>
      </div>
      <p v-if="!v.cuts.length" class="text-slate-400">沒有核減</p>
      <ul class="space-y-2">
        <li v-for="c in v.cuts" :key="c.id" class="rounded-md border border-slate-200 bg-white px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge :tone="TONE[c.status]">{{ c.statusLabel }}</UBadge>
            <b>{{ c.patientName }}</b><span class="text-xs text-slate-500">{{ c.chartNo }}・{{ c.month }} {{ CLAIM_KIND_LABEL[c.kind] }}・{{ c.date }}・主治 {{ c.doctorName }}</span>
            <span class="tabular ml-auto font-semibold text-red-700">−{{ fmt(c.points) }} 點</span>
          </div>
          <div class="text-xs text-slate-700">{{ c.item }}・{{ c.codeLabel }}<template v-if="c.reason">：{{ c.reason }}</template></div>
          <div v-if="c.replyText" class="text-xs text-slate-600">主治回覆：{{ c.replyText }}</div>
          <div v-if="c.resultText" class="text-xs" :class="c.status === 'paid' ? 'text-emerald-700' : 'text-red-700'">申復結果：{{ c.resultText }}</div>
          <div v-if="c.status === 'appealed' && v.canManage" class="mt-1 text-right"><UButton size="sm" @click="openRes(c)">記錄申復結果</UButton></div>
        </li>
      </ul>
    </div>

    <UDialog v-model="addOpen" title="輸入核減" size="md" @submit="submitAdd">
      <div class="space-y-3 text-sm">
        <USelect v-model="af.submissionId" label="送出的申報" :options="(v?.submissions ?? []).map((s) => ({ label: s.label, value: s.id }))" @update:model-value="af.refId = ''" />
        <USelect v-model="af.refId" label="哪一筆" placeholder="選擇" :options="(sub?.items ?? []).map((x) => ({ label: `${x.label}（還能核減 ${x.left}）`, value: x.refId }))" :error="addAct.fieldErrors.value.refId" />
        <UInput v-model="af.item" label="核減項目" placeholder="例：胸部 X 光" :error="addAct.fieldErrors.value.item" />
        <div class="grid grid-cols-2 gap-2">
          <UInput v-model="af.points" type="number" label="核減點數" :error="addAct.fieldErrors.value.points" />
          <USelect v-model="af.code" label="理由代碼" placeholder="選擇" :options="CUT_REASONS.map((r) => ({ label: `${r.code} ${r.label}`, value: r.code }))" :error="addAct.fieldErrors.value.code" />
        </div>
        <UInput v-model="af.reason" label="審查意見（選填）" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="addOpen = false">取消</UButton>
        <UButton type="submit" :loading="addAct.pending.value">輸入</UButton>
      </template>
    </UDialog>
    <UDialog v-model="resOpen" :title="`申復結果：${resFor?.patientName ?? ''} ${resFor?.item ?? ''}`" size="sm" @submit="submitRes">
      <div class="space-y-3 text-sm">
        <USelect v-model="rf.outcome" label="結果" :options="[{ label: '補付', value: 'paid' }, { label: '維持核減', value: 'upheld' }]" :error="resAct.fieldErrors.value.outcome" />
        <UInput v-if="rf.outcome === 'paid'" v-model="rf.points" type="number" :label="`補付點數（最多 ${resFor?.points ?? 0}）`" :error="resAct.fieldErrors.value.points" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="resFor = undefined">取消</UButton>
        <UButton type="submit" :loading="resAct.pending.value">記錄</UButton>
      </template>
    </UDialog>
  </UQueryState>
</template>
