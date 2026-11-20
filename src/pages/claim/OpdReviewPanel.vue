<script setup lang="ts">
// 門診病歷品質抽審（病歷室）：選月份 → 抽樣（每位醫師 2 份）→ 逐項審查（符合／不符合）＋意見 → 各醫師平均分數。
// 抽樣方式、分數、能不能改都由服務層判斷（opd-review.ts、opd-review-rules）
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UDialog, UInput, UQueryState, UTextarea } from '@/components/ui'
import { OPD_REVIEW_ITEMS, OPD_REVIEW_PER_DOCTOR, opdReviewApi, type OpdReviewView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { today } from '@/utils/date'

const prevMonth = (() => { const d = new Date(`${today().slice(0, 7)}-01T00:00:00`); d.setDate(0); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })()
const month = ref(prevMonth)
const { data, loading } = useQuery(() => opdReviewApi.opdReviewBoard(month.value), [month])
const sampleAct = useAction(opdReviewApi.sampleOpdReviews, { success: (b) => `已抽 ${b.reviews.length} 份` })

const cur = ref<OpdReviewView>()
const open = computed({ get: () => !!cur.value, set: (x) => !x && (cur.value = undefined) })
const f = reactive({ items: {} as Record<string, boolean>, note: '' })
function openReview(r: OpdReviewView) {
  f.items = { ...(r.result?.items ?? {}) }
  f.note = r.result?.note ?? ''
  act.fieldErrors.value = {}
  cur.value = r
}
const act = useAction(opdReviewApi.saveOpdReview, { success: (r) => `已審查：${r.score} 分${r.fails.length ? '，已通知醫師' : ''}` })
async function submit() {
  if (cur.value && (await act.run(cur.value.id, { items: f.items, note: f.note }))) cur.value = undefined
}
</script>

<template>
  <div class="space-y-3 text-sm">
    <div class="flex flex-wrap items-end gap-2">
      <UInput v-model="month" type="month" label="病歷月份" class="w-44" />
      <UButton v-if="data && !data.sampled" :loading="sampleAct.pending.value" :disabled="!data.candidates.encounters" @click="sampleAct.run(month)">抽樣（每位醫師 {{ OPD_REVIEW_PER_DOCTOR }} 份）</UButton>
      <span v-if="data" class="text-xs text-slate-500">這個月完成的門診病歷 {{ data.candidates.encounters }} 份、{{ data.candidates.doctors }} 位醫師（急診、慢箋領藥不抽）</span>
    </div>
    <UQueryState :loading="loading && !data" :ready="!!data?.reviews.length" empty-title="這個月還沒抽樣">
      <div v-if="data" class="space-y-3">
        <table class="w-full rounded-md border border-slate-200 bg-white">
          <thead class="text-xs text-slate-500"><tr><th class="px-2 py-1 text-left">醫師</th><th class="text-right">抽</th><th class="text-right">已審</th><th class="px-2 text-right">平均分數</th></tr></thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="d in data.byDoctor" :key="d.doctorName"><td class="px-2 py-1">{{ d.doctorName }}</td><td class="tabular text-right">{{ d.count }}</td><td class="tabular text-right">{{ d.done }}</td><td class="tabular px-2 text-right" :class="d.avg !== null && d.avg < 80 ? 'font-semibold text-red-700' : ''">{{ d.avg ?? '—' }}</td></tr>
          </tbody>
        </table>
        <ul class="space-y-2">
          <li v-for="r in data.reviews" :key="r.id" class="rounded-md border border-slate-200 bg-white px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <UBadge v-if="!r.result" tone="yellow">待審查</UBadge>
              <UBadge v-else :tone="r.fails.length ? 'red' : 'green'">{{ r.score }} 分</UBadge>
              <b>{{ r.doctorName }}</b><span class="text-xs text-slate-500">{{ r.date }}・{{ r.deptName }}・{{ r.patientName }}（{{ r.chartNo }}）</span>
              <UButton v-if="!r.ack" size="sm" :variant="r.result ? 'secondary' : 'primary'" class="ml-auto" @click="openReview(r)">{{ r.result ? '修改' : '審查' }}</UButton>
            </div>
            <div v-if="r.fails.length" class="text-xs text-red-700">不符合：{{ r.fails.join('、') }}<template v-if="r.result?.note">（{{ r.result.note }}）</template></div>
            <div v-if="r.ack" class="text-xs text-slate-600">醫師回覆：{{ r.ack.note }}</div>
            <div v-else-if="r.needAck" class="text-xs text-slate-400">等醫師回覆</div>
          </li>
        </ul>
      </div>
    </UQueryState>
    <UDialog v-model="open" :title="`病歷審查：${cur?.doctorName ?? ''} ${cur?.date ?? ''}`" size="lg" @submit="submit">
      <div v-if="cur" class="space-y-3">
        <div class="rounded bg-slate-50 px-3 py-2 text-xs text-slate-700">
          <div><b>S</b> {{ cur.soap.subjective || '（空白）' }}</div>
          <div><b>O</b> {{ cur.soap.objective || '（空白）' }}</div>
          <div><b>A</b> {{ cur.soap.assessment || '（空白）' }}</div>
          <div><b>P</b> {{ cur.soap.plan || '（空白）' }}</div>
          <div class="mt-1">診斷：{{ cur.diagnoses.join('、') || '—' }}</div>
          <div>藥：{{ cur.medications.join('；') || '—' }}</div>
          <div v-if="cur.procedures.length">處置／檢查：{{ cur.procedures.join('、') }}</div>
        </div>
        <table class="w-full text-sm">
          <tr v-for="i in OPD_REVIEW_ITEMS" :key="i.key" class="border-b border-slate-100">
            <td class="py-1">{{ i.label }}</td>
            <td class="w-40 text-right">
              <label class="mr-3"><input v-model="f.items[i.key]" type="radio" :name="i.key" :value="true" /> 符合</label>
              <label><input v-model="f.items[i.key]" type="radio" :name="i.key" :value="false" /> 不符合</label>
            </td>
          </tr>
        </table>
        <p v-if="act.fieldErrors.value.items" class="text-xs text-red-600">{{ act.fieldErrors.value.items }}</p>
        <UTextarea v-model="f.note" label="審查意見（有不符合要寫，醫師會看到）" :error="act.fieldErrors.value.note" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="cur = undefined">取消</UButton>
        <UButton type="submit" :loading="act.pending.value">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
