<script setup lang="ts">
// 危急值待通報（檢驗科）：有危急值的報告發出後 30 分鐘內要打電話通報——住院給病房護理師或主治、門診給開立醫師；
// 記受話者姓名、職稱、對方已複誦（病人姓名、項目、數值）。逾時標紅、照樣可以補記（標逾時）。
// 電話沒人接就記「沒聯絡上」（打給誰、幾點）；連續兩次要改通報下一層（住院→主治、門診→同科其他醫師），30 分鐘照算。
// 和醫師「已知悉」分開：通報是檢驗科的責任，已知悉是醫師的。規則在 callout-rules、服務層 lab.calloutLab／calloutFailed
import { computed, reactive, ref } from 'vue'
import { PhoneCall, PhoneMissed } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UCheckbox, UDialog, UInput, USelect, UTextarea } from '@/components/ui'
import { CALLOUT_FAIL_REASONS, CALLOUT_ROLE_LABEL, labApi, type LabReportView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data } = useQuery(() => labApi.calloutBoard())
const target = ref<LabReportView>()
/** ok＝聯絡上了（記通報）；fail＝沒聯絡上 */
const mode = ref<'ok' | 'fail'>('ok')
const open = computed({ get: () => !!target.value, set: (x) => !x && (target.value = undefined) })
const form = reactive({ to: '', toRole: 'nurse' as 'nurse' | 'doctor', readBack: false, note: '' })
function start(r: LabReportView, m: 'ok' | 'fail') {
  target.value = r
  mode.value = m
  // 預設打給誰：升級後住院帶主治、門診留空（選同科醫師）；沒升級門診帶開立醫師、住院沿用上一次沒聯絡上的對象
  const last = r.calloutAttempts?.at(-1)
  const who = r.calloutEscalated
    ? { to: r.source === 'ipd' ? r.calloutSuggest[0] ?? '' : '', toRole: 'doctor' as const }
    : r.source === 'opd' ? { to: r.doctorName, toRole: 'doctor' as const } : last ? { to: last.to, toRole: last.toRole } : { to: '', toRole: 'nurse' as const }
  Object.assign(form, who, { readBack: false, note: '' })
  save.fieldErrors.value = {}
  miss.fieldErrors.value = {}
}
const save = useAction(labApi.calloutLab, { success: (r) => `已記錄危急值通報：${r.patientName}（${r.callout?.to}）` })
const miss = useAction(labApi.calloutFailed, { success: (r) => (r.calloutEscalated ? `已記錄沒聯絡上（第 ${r.calloutTries} 次）：請改通報${r.source === 'ipd' ? '主治醫師' : '同科其他醫師'}` : `已記錄沒聯絡上（第 ${r.calloutTries} 次），請再打一次`) })
const act = computed(() => (mode.value === 'ok' ? save : miss))
async function submit() {
  if (!target.value) return
  const ok = mode.value === 'ok' ? await save.run(target.value.id, { ...form }) : await miss.run(target.value.id, { to: form.to, toRole: form.toRole, note: form.note })
  if (ok) target.value = undefined
}
const roleOptions = computed(() => (target.value?.source === 'ipd' && !(target.value.calloutEscalated && mode.value === 'ok') ? [{ label: '護理師', value: 'nurse' }, { label: '醫師', value: 'doctor' }] : [{ label: '醫師', value: 'doctor' }]))
const crit = (r: LabReportView) => r.values.filter((v) => v.critical).map((v) => `${v.name} ${v.value}${v.unit ? ` ${v.unit}` : ''}`).join('、')
</script>

<template>
  <UCard v-if="data && (data.pending.length || data.doneToday.length)" :padded="false">
    <template #title>
      <span class="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
        <PhoneCall class="h-4 w-4" />危急值待通報 <UBadge v-if="data.pending.length" tone="red">{{ data.pending.length }}</UBadge>
        <span class="text-xs font-normal text-slate-500">近 30 天時限內通報 {{ data.rate.ontime }}/{{ data.rate.total }}（{{ data.rate.pct }}%）</span>
      </span>
    </template>
    <div class="space-y-2 p-3 text-sm">
      <p v-if="!data.pending.length" class="text-xs text-slate-400">危急值都通報了</p>
      <ul v-else class="divide-y divide-slate-100 rounded border border-red-200">
        <li v-for="r in data.pending" :key="r.id" class="flex flex-wrap items-center gap-2 px-2 py-1.5">
          <b>{{ r.patientName }}</b><span class="text-xs text-slate-500">{{ r.where }}・{{ r.procName }}</span>
          <span class="min-w-0 flex-1 text-xs font-semibold text-red-700">{{ crit(r) }}</span>
          <UBadge v-if="r.calloutTries" :tone="r.calloutEscalated ? 'red' : 'yellow'">沒聯絡上 {{ r.calloutTries }} 次{{ r.calloutEscalated ? '・要升級' : '' }}</UBadge>
          <span :class="['tabular text-xs', r.calloutState === 'late' ? 'font-semibold text-red-700' : 'text-slate-500']">{{ r.calloutState === 'late' ? '已逾時' : '期限' }} {{ r.calloutDue?.slice(5) }}（{{ r.calloutMinutes }} 分）</span>
          <UButton size="sm" variant="secondary" :icon="PhoneMissed" @click="start(r, 'fail')">沒聯絡上</UButton>
          <UButton size="sm" :icon="PhoneCall" @click="start(r, 'ok')">通報</UButton>
        </li>
      </ul>
      <p v-if="data.doneToday.length" class="text-xs text-slate-500">今天已通報：{{ data.doneToday.map((r) => `${r.patientName} → ${r.callout?.to} ${r.callout?.at.slice(11)}${r.calloutOnTime ? '' : '（逾時）'}${r.callout?.escalated ? '（升級）' : ''}`).join('；') }}</p>
    </div>
  </UCard>

  <UDialog v-model="open" :title="mode === 'ok' ? '危急值通報' : '危急值通報：沒聯絡上'" size="md">
    <div v-if="target" class="space-y-3 text-sm">
      <p><b>{{ target.patientName }}</b>（{{ target.chartNo }}）{{ target.where }}・{{ target.procName }}：<span class="font-semibold text-red-700">{{ crit(target) }}</span></p>
      <p :class="['text-xs', target.calloutEscalated ? 'rounded border border-red-300 bg-red-50 px-2 py-1 font-semibold text-red-800' : 'text-slate-500']">{{ target.calloutTarget }}</p>
      <ul v-if="target.calloutAttempts?.length" class="space-y-0.5 text-xs text-slate-600">
        <li v-for="(a, i) in target.calloutAttempts" :key="i" class="tabular">{{ a.at.slice(11) }} 打給{{ CALLOUT_ROLE_LABEL[a.toRole] }} {{ a.to }}：沒聯絡上{{ a.note ? `（${a.note}）` : '' }}</li>
      </ul>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <USelect v-model="form.toRole" :label="mode === 'ok' ? '受話者職稱' : '打給（職稱）'" :options="roleOptions" :error="act.fieldErrors.value.toRole" />
        <UInput v-model="form.to" :label="mode === 'ok' ? '受話者姓名' : '打給（姓名）'" placeholder="例：王小明" :error="act.fieldErrors.value.to" />
      </div>
      <div v-if="target.calloutEscalated && target.source === 'opd' && target.calloutSuggest.length" class="flex flex-wrap items-center gap-1 text-xs text-slate-600">同科醫師：
        <UButton v-for="n in target.calloutSuggest" :key="n" size="sm" variant="secondary" @click="form.to = n">{{ n }}</UButton>
      </div>
      <template v-if="mode === 'ok'">
        <UCheckbox v-model="form.readBack" label="對方已複誦病人姓名、檢驗項目與數值，確認無誤" />
        <p v-if="save.fieldErrors.value.readBack" class="text-xs text-red-600">{{ save.fieldErrors.value.readBack }}</p>
        <UTextarea v-model="form.note" label="備註（選填）" :rows="2" placeholder="例：醫師表示會立刻處理" />
      </template>
      <template v-else>
        <div class="flex flex-wrap gap-1"><UButton v-for="p in CALLOUT_FAIL_REASONS" :key="p" size="sm" variant="secondary" @click="form.note = p">{{ p }}</UButton></div>
        <UInput v-model="form.note" label="原因（選填）" placeholder="例：電話沒人接" />
        <p class="text-xs text-slate-500">時限照算，不會因為沒聯絡上而停表；連續 2 次沒聯絡上要改通報下一層。</p>
      </template>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="target = undefined">取消</UButton>
      <UButton :icon="mode === 'ok' ? PhoneCall : PhoneMissed" :variant="mode === 'ok' ? 'primary' : 'danger'" :loading="act.pending.value" @click="submit">{{ mode === 'ok' ? '記錄通報' : '記錄沒聯絡上' }}</UButton>
    </template>
  </UDialog>
</template>
