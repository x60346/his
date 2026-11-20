<script setup lang="ts">
// 核減與申復（申報組）：每月申報、核減、補付點數與核減率；輸入健保署的核減（送出過的月份的一筆）；
// 主治回覆後，申復的記結果（補付幾點或維持）；維持或只補付一部分的，60 天內可申請爭議審議、記審議結果。
// 能不能輸入、點數上限、期限由服務層判斷（claim-cut.ts、claim-rules）
import { computed, reactive, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UQueryState, USelect, UTextarea } from '@/components/ui'
import { CLAIM_KIND_LABEL, claimCutApi, CUT_REASONS, CUT_STATUS_TONE as TONE, type CutFilePreview, type CutItem } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data: v, loading } = useQuery(() => claimCutApi.cutBoard(), [])
const fmt = (n: number) => n.toLocaleString('zh-TW')

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

// 核定通知整批匯入：選送出的申報 → 貼上 → 預覽 → 只匯入沒問題的行
const fOpen = ref(false)
const ff = reactive({ submissionId: '' as string | number | undefined, text: '' })
const fPv = ref<CutFilePreview>()
function openFile() {
  Object.assign(ff, { submissionId: v.value?.submissions[0]?.id ?? '', text: '' })
  fPv.value = undefined
  fOpen.value = true
}
const fPvAct = useAction(claimCutApi.previewCutFile)
async function previewFile() {
  fPv.value = (await fPvAct.run(String(ff.submissionId ?? ''), ff.text)) ?? undefined
}
const fImpAct = useAction(claimCutApi.importCutFile, { success: (r) => `已輸入核減 ${r.created} 筆、${fmt(r.points)} 點，已通知主治${r.skipped ? `；略過 ${r.skipped} 行` : ''}` })
async function importFile() {
  if (await fImpAct.run(String(ff.submissionId ?? ''), ff.text)) fOpen.value = false
}

// 爭議審議：申請（理由，預帶主治的申復理由）、記結果（補付幾點或駁回）
const dispFor = ref<CutItem>()
const dispOpen = computed({ get: () => !!dispFor.value, set: (x) => !x && (dispFor.value = undefined) })
const df = reactive({ reason: '' })
function openDisp(c: CutItem) {
  df.reason = c.reply?.text ?? ''
  dispAct.fieldErrors.value = {}
  dispFor.value = c
}
const dispAct = useAction(claimCutApi.fileDispute, { success: (c) => `已申請爭議審議：${c.patientName} ${c.item} ${c.dispute?.points ?? 0} 點` })
async function submitDisp() {
  if (dispFor.value && (await dispAct.run(dispFor.value.id, { reason: df.reason }))) dispFor.value = undefined
}
const drFor = ref<CutItem>()
const drOpen = computed({ get: () => !!drFor.value, set: (x) => !x && (drFor.value = undefined) })
const drf = reactive({ outcome: 'paid' as string | number | undefined, points: undefined as number | undefined, note: '' })
function openDr(c: CutItem) {
  Object.assign(drf, { outcome: 'paid', points: c.dispute?.points, note: '' })
  drAct.fieldErrors.value = {}
  drFor.value = c
}
const drAct = useAction(claimCutApi.recordDisputeResult, { success: (c) => `已記錄爭議審議結果：${c.disputeResultText}` })
async function submitDr() {
  if (drFor.value && (await drAct.run(drFor.value.id, { outcome: drf.outcome as 'paid' | 'rejected', points: Number(drf.points), note: drf.note }))) drFor.value = undefined
}
</script>

<template>
  <UQueryState :loading="loading && !v" :ready="!!v">
    <div v-if="v" class="space-y-3 text-sm">
      <section class="overflow-x-auto rounded-md border border-slate-200 bg-white p-3">
        <h3 class="mb-1 font-semibold text-slate-700">每月核減率<span class="ml-2 text-xs font-normal text-slate-500">淨核減＝核減 − 補付（申復、爭議審議）；核減率＝淨核減 ÷ 申報點數</span></h3>
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
        <UButton v-if="v.canManage && v.submissions.length" size="sm" variant="secondary" class="ml-auto" @click="openFile">匯入核定通知</UButton>
        <UButton v-if="v.canManage && v.submissions.length" size="sm" :icon="Plus" @click="openAdd">輸入核減</UButton>
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
          <div v-if="c.disputeText" class="text-xs text-purple-800">爭議審議：{{ c.disputeText }}</div>
          <div v-if="c.disputeResultText" class="text-xs" :class="c.status === 'disputePaid' ? 'text-emerald-700' : 'text-red-700'">爭議審議結果：{{ c.disputeResultText }}</div>
          <div v-if="c.canDispute" class="text-xs text-amber-800">申復後還有 {{ fmt(c.disputeLeft) }} 點沒補回：{{ c.disputeDeadline }} 前可申請爭議審議</div>
          <div v-else-if="c.disputeWhy?.startsWith('超過')" class="text-xs text-slate-400">{{ c.disputeWhy }}</div>
          <div v-if="v.canManage && (c.status === 'appealed' || c.canDispute || c.status === 'disputed')" class="mt-1 flex justify-end gap-2">
            <UButton v-if="c.status === 'appealed'" size="sm" @click="openRes(c)">記錄申復結果</UButton>
            <UButton v-if="c.canDispute" size="sm" variant="secondary" @click="openDisp(c)">申請爭議審議</UButton>
            <UButton v-if="c.status === 'disputed'" size="sm" @click="openDr(c)">記錄爭議審議結果</UButton>
          </div>
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
    <UDialog v-model="fOpen" title="匯入核定通知（核減）" size="lg">
      <div class="space-y-3 text-sm">
        <USelect v-model="ff.submissionId" label="送出的申報" :options="(v?.submissions ?? []).map((s) => ({ label: s.label, value: s.id }))" @update:model-value="fPv = undefined" />
        <p class="text-xs text-slate-500">每行：病歷號,日期（住院是出院日）,核減項目,點數,理由代碼,審查意見。理由代碼：{{ CUT_REASONS.map((r) => r.code + ' ' + r.label).join('；') }}</p>
        <UTextarea v-model="ff.text" label="核定通知（貼上）" :rows="6" placeholder="100004,2026-09-03,膝關節 X 光,220,0213,30 天內重複檢查" />
        <table v-if="fPv" class="w-full text-xs">
          <thead class="text-slate-500"><tr><th class="text-left">行</th><th class="text-left">病歷號</th><th class="text-left">日期</th><th class="text-left">項目</th><th class="pr-3 text-right">點數</th><th class="text-left">對到</th><th class="text-left">結果</th></tr></thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="l in fPv.lines" :key="l.line" :class="l.error ? 'text-red-700' : ''">
              <td class="tabular">{{ l.line }}</td><td class="tabular">{{ l.chartNo }}</td><td class="tabular">{{ l.date }}</td><td>{{ l.item }}<div class="text-slate-400">{{ l.codeLabel }}</div></td><td class="tabular pr-3 text-right">{{ fmt(l.points || 0) }}</td>
              <td>{{ l.patientName ? `${l.patientName}（還能核減 ${fmt(l.left ?? 0)}）` : '—' }}</td><td>{{ l.error ?? '可以輸入' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="fPv" class="text-xs">可以輸入 <b>{{ fPv.ok }}</b> 筆、{{ fmt(fPv.points) }} 點<template v-if="fPv.bad">；有問題 <b class="text-red-700">{{ fPv.bad }}</b> 行（匯入時略過）</template></p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="fOpen = false">取消</UButton>
        <UButton variant="secondary" :loading="fPvAct.pending.value" @click="previewFile">預覽</UButton>
        <UButton :disabled="!fPv?.ok" :loading="fImpAct.pending.value" @click="importFile">匯入 {{ fPv?.ok ?? 0 }} 筆</UButton>
      </template>
    </UDialog>
    <UDialog v-model="dispOpen" :title="`爭議審議：${dispFor?.patientName ?? ''} ${dispFor?.item ?? ''}`" size="md" @submit="submitDisp">
      <div v-if="dispFor" class="space-y-3 text-sm">
        <p class="text-xs text-slate-600">申請點數：還沒補回的 <b>{{ fmt(dispFor.disputeLeft) }}</b> 點・期限 {{ dispFor.disputeDeadline }}・一筆只能申請一次</p>
        <UTextarea v-model="df.reason" label="爭議理由（預帶主治的申復理由，可補充病歷佐證）" :error="dispAct.fieldErrors.value.reason" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="dispFor = undefined">取消</UButton>
        <UButton type="submit" :loading="dispAct.pending.value">申請</UButton>
      </template>
    </UDialog>
    <UDialog v-model="drOpen" :title="`爭議審議結果：${drFor?.patientName ?? ''} ${drFor?.item ?? ''}`" size="sm" @submit="submitDr">
      <div class="space-y-3 text-sm">
        <USelect v-model="drf.outcome" label="審定結果" :options="[{ label: '補付', value: 'paid' }, { label: '駁回', value: 'rejected' }]" :error="drAct.fieldErrors.value.outcome" />
        <UInput v-if="drf.outcome === 'paid'" v-model="drf.points" type="number" :label="`補付點數（最多 ${drFor?.dispute?.points ?? 0}）`" :error="drAct.fieldErrors.value.points" />
        <UInput v-else v-model="drf.note" label="駁回理由（審定書上的）" :error="drAct.fieldErrors.value.note" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="drFor = undefined">取消</UButton>
        <UButton type="submit" :loading="drAct.pending.value">記錄</UButton>
      </template>
    </UDialog>
  </UQueryState>
</template>
