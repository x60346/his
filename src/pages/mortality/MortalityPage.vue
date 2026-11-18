<script setup lang="ts">
// 死亡審查（權限「死亡病例審查」，示範 dr02）：最近 30 天的院內死亡（待審查的在前）、觸發條件、審查（結論、檢討、改善事項、
// 需提病例討論的日期與報告人）、即將召開的病例討論、品質指標（院內死亡率、48 小時內、非預期、加護病房死亡率、SMR）
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { UBadge, UButton, UCard, UDialog, UInput, UPageHeader, UQueryState, USelect, UTextarea } from '@/components/ui'
import { mortalityApi, REVIEW_GRADES, type MortalityCase } from '@/services'
import type { Admission } from '@/types'
import { useAction, useQuery } from '@/composables/useService'

const router = useRouter()
const { data, loading, reload } = useQuery(() => mortalityApi.listMortality(30))
const hm = (s?: string) => s?.slice(5, 16).replace('-', '/') ?? ''
const pct = (x: number | null) => (x === null ? '—' : `${x}%`)

const reviewing = ref<MortalityCase>()
const open = computed({ get: () => !!reviewing.value, set: (x) => !x && (reviewing.value = undefined) })
const f = reactive({ grade: '' as string, findings: '', improvement: '', conferenceDate: '', presenter: '' })
function openReview(c: MortalityCase) {
  Object.assign(f, { grade: '', findings: '', improvement: '', conferenceDate: '', presenter: '' })
  act.fieldErrors.value = {}
  reviewing.value = c
}
const act = useAction(mortalityApi.reviewDeath, { success: (c) => `已審查：${c.review?.gradeLabel}` })
async function submit() {
  if (!reviewing.value) return
  const ok = await act.run(reviewing.value.admissionId, { grade: f.grade as NonNullable<Admission['mortalityReview']>['grade'], findings: f.findings, improvement: f.improvement, ...(f.grade === 'discuss' ? { conferenceDate: f.conferenceDate, presenter: f.presenter } : {}) })
  if (ok) {
    reviewing.value = undefined
    reload()
  }
}
const gradeTone = { unavoidable: 'gray', possibly: 'yellow', avoidable: 'red', discuss: 'purple' } as const
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="死亡審查" description="最近 30 天的院內死亡：非預期的要審查（結論、檢討、改善事項），需要的排病例討論" />
    <UQueryState :loading="loading && !data" :ready="!!data">
      <div v-if="data" class="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_20rem]">
        <UCard :padded="false" class="self-start">
          <div class="border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">院內死亡 {{ data.cases.length }}<span class="ml-2 text-xs font-normal text-slate-500">待審查 {{ data.toReview }}</span></div>
          <p v-if="!data.cases.length" class="px-4 py-4 text-center text-sm text-slate-400">最近 30 天沒有院內死亡</p>
          <div v-for="c in data.cases" :key="c.admissionId" class="border-b border-slate-100 px-4 py-3 text-sm last:border-b-0">
            <div class="flex flex-wrap items-center gap-2">
              <b>{{ c.patientName }}</b>
              <span class="text-xs text-slate-500">{{ c.chartNo }}・{{ c.deptName }}・主治 {{ c.doctorName }}・{{ c.diagnosis }}</span>
              <UBadge :tone="c.expected ? 'gray' : 'yellow'">{{ c.expected ? '預期' : '非預期' }}</UBadge>
              <UBadge v-if="c.review" :tone="gradeTone[c.review.grade]">{{ c.review.gradeLabel }}</UBadge>
              <UBadge v-else-if="c.needsReview" tone="red">待審查</UBadge>
              <UBadge v-else tone="gray">不用審</UBadge>
            </div>
            <div class="mt-0.5 text-xs text-slate-600">{{ hm(c.declaredAt) }} 宣告死亡・住院 {{ c.hoursInHospital }} 小時・死因 {{ c.causes.join(' ← ') }}<template v-if="c.icuPredicted !== undefined">・APACHE II 預估死亡率 {{ c.icuPredicted }}%</template></div>
            <div v-if="c.triggers.length" class="mt-1 flex flex-wrap gap-1"><span v-for="t in c.triggers" :key="t.key" class="rounded bg-amber-50 px-1.5 text-xs text-amber-800">{{ t.label }}</span></div>
            <div v-if="c.review" class="mt-1 text-xs text-slate-700">檢討：{{ c.review.findings }}<template v-if="c.review.improvement">；改善：{{ c.review.improvement }}</template><template v-if="c.review.conference">；病例討論 {{ c.review.conference.date }}（{{ c.review.conference.presenter }}）</template>・{{ c.review.byName }}</div>
            <div class="mt-2 flex gap-2">
              <UButton v-if="data.canReview && c.needsReview && !c.review" size="sm" @click="openReview(c)">審查</UButton>
              <UButton size="sm" variant="ghost" @click="router.push({ name: 'ipd', query: { admission: c.admissionId } })">病歷</UButton>
            </div>
          </div>
        </UCard>
        <div class="space-y-4 self-start">
          <UCard>
            <div class="text-sm font-semibold text-slate-700">品質指標（最近 {{ data.days }} 天）</div>
            <dl class="tabular mt-2 grid grid-cols-[1fr_auto] gap-y-1 text-sm">
              <dt class="text-slate-500">院內死亡率</dt><dd>{{ data.stats.deaths }} / {{ data.stats.discharges }}（{{ pct(data.stats.mortalityRate) }}）</dd>
              <dt class="text-slate-500">入院 48 小時內死亡</dt><dd>{{ data.stats.early }}</dd>
              <dt class="text-slate-500">非預期死亡</dt><dd>{{ data.stats.unexpected }}</dd>
              <dt class="text-slate-500">加護病房死亡率</dt><dd>{{ data.stats.icuDeaths }} / {{ data.stats.icuStays }}（{{ pct(data.stats.icuMortality) }}）</dd>
              <dt class="text-slate-500">預估死亡（APACHE II）</dt><dd>{{ data.stats.icuExpected }}</dd>
              <dt class="text-slate-500">SMR（實際 ÷ 預估）</dt><dd>{{ data.stats.smr ?? '—' }}</dd>
            </dl>
            <p class="mt-2 text-xs text-slate-500">院內死亡率：期間內出院（含死亡）的病人中死亡的比例。SMR &gt; 1 表示死亡比 APACHE II 預估多（本系統的 APACHE II 是簡化版，只供參考）。</p>
          </UCard>
          <UCard v-if="data.conferences.length">
            <div class="text-sm font-semibold text-slate-700">即將召開的病例討論</div>
            <div v-for="m in data.conferences" :key="m.admissionId" class="tabular mt-1 text-sm">{{ m.date }} {{ m.patientName }}<span class="text-xs text-slate-500">（{{ m.presenter }}報告）</span></div>
          </UCard>
        </div>
      </div>
    </UQueryState>

    <UDialog v-model="open" :title="`死亡病例審查：${reviewing?.patientName ?? ''}`" @submit="submit">
      <div class="space-y-2 text-sm">
        <div class="flex flex-wrap gap-1"><span v-for="t in reviewing?.triggers" :key="t.key" class="rounded bg-amber-50 px-1.5 text-xs text-amber-800">{{ t.label }}</span></div>
        <USelect v-model="f.grade" label="審查結論" :options="[{ label: '請選', value: '' }, ...REVIEW_GRADES.map((g) => ({ label: g.label, value: g.key }))]" :error="act.fieldErrors.value.grade" />
        <UTextarea v-model="f.findings" label="檢討" :rows="3" required :error="act.fieldErrors.value.findings" placeholder="例：入院時 NEWS2 已 7 分，快速反應小組 35 分鐘才到；急救流程符合規範" />
        <UTextarea v-model="f.improvement" :label="f.grade === 'unavoidable' ? '改善事項（選填）' : '改善事項'" :rows="2" :required="!!f.grade && f.grade !== 'unavoidable'" :error="act.fieldErrors.value.improvement" />
        <div v-if="f.grade === 'discuss'" class="grid grid-cols-2 gap-2">
          <UInput v-model="f.conferenceDate" type="date" label="病例討論日期" :error="act.fieldErrors.value.conferenceDate" />
          <UInput v-model="f.presenter" label="報告人" :error="act.fieldErrors.value.presenter" />
        </div>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton type="submit" :loading="act.pending.value">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
