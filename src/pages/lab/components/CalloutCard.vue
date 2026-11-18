<script setup lang="ts">
// 危急值待通報（檢驗科）：有危急值的報告發出後 30 分鐘內要打電話通報——住院給病房護理師或主治、門診給開立醫師；
// 記受話者姓名、職稱、對方已複誦（病人姓名、項目、數值）。逾時標紅、照樣可以補記（標逾時）。
// 和醫師「已知悉」分開：通報是檢驗科的責任，已知悉是醫師的。規則在 callout-rules、服務層 lab.calloutLab
import { computed, reactive, ref } from 'vue'
import { PhoneCall } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UCheckbox, UDialog, UInput, USelect, UTextarea } from '@/components/ui'
import { CALLOUT_MINUTES, labApi, type LabReportView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data } = useQuery(() => labApi.calloutBoard())
const target = ref<LabReportView>()
const open = computed({ get: () => !!target.value, set: (x) => !x && (target.value = undefined) })
const form = reactive({ to: '', toRole: 'nurse' as 'nurse' | 'doctor', readBack: false, note: '' })
function start(r: LabReportView) {
  target.value = r
  Object.assign(form, r.source === 'opd' ? { to: r.doctorName, toRole: 'doctor' } : { to: '', toRole: 'nurse' }, { readBack: false, note: '' })
  save.fieldErrors.value = {}
}
const save = useAction(labApi.calloutLab, { success: (r) => `已記錄危急值通報：${r.patientName}（${r.callout?.to}）` })
async function submit() {
  if (target.value && (await save.run(target.value.id, { ...form }))) target.value = undefined
}
const crit = (r: LabReportView) => r.values.filter((v) => v.critical).map((v) => `${v.name} ${v.value}${v.unit ? ` ${v.unit}` : ''}`).join('、')
</script>

<template>
  <UCard v-if="data && (data.pending.length || data.doneToday.length)" :padded="false">
    <template #title>
      <span class="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
        <PhoneCall class="h-4 w-4" />危急值待通報 <UBadge v-if="data.pending.length" tone="red">{{ data.pending.length }}</UBadge>
        <span class="text-xs font-normal text-slate-500">近 30 天 {{ CALLOUT_MINUTES }} 分鐘內通報 {{ data.rate.ontime }}/{{ data.rate.total }}（{{ data.rate.pct }}%）</span>
      </span>
    </template>
    <div class="space-y-2 p-3 text-sm">
      <p v-if="!data.pending.length" class="text-xs text-slate-400">危急值都通報了</p>
      <ul v-else class="divide-y divide-slate-100 rounded border border-red-200">
        <li v-for="r in data.pending" :key="r.id" class="flex flex-wrap items-center gap-2 px-2 py-1.5">
          <b>{{ r.patientName }}</b><span class="text-xs text-slate-500">{{ r.where }}・{{ r.procName }}</span>
          <span class="min-w-0 flex-1 text-xs font-semibold text-red-700">{{ crit(r) }}</span>
          <span :class="['tabular text-xs', r.calloutState === 'late' ? 'font-semibold text-red-700' : 'text-slate-500']">{{ r.calloutState === 'late' ? '已逾時' : '期限' }} {{ r.calloutDue?.slice(5) }}</span>
          <UButton size="sm" :icon="PhoneCall" @click="start(r)">通報</UButton>
        </li>
      </ul>
      <p v-if="data.doneToday.length" class="text-xs text-slate-500">今天已通報：{{ data.doneToday.map((r) => `${r.patientName} → ${r.callout?.to} ${r.callout?.at.slice(11)}${r.calloutOnTime ? '' : '（逾時）'}`).join('；') }}</p>
    </div>
  </UCard>

  <UDialog v-model="open" title="危急值通報" size="md">
    <div v-if="target" class="space-y-3 text-sm">
      <p><b>{{ target.patientName }}</b>（{{ target.chartNo }}）{{ target.where }}・{{ target.procName }}：<span class="font-semibold text-red-700">{{ crit(target) }}</span></p>
      <p class="text-xs text-slate-500">{{ target.source === 'ipd' ? '住院：通報病房護理師或主治醫師' : `門診：通報開立醫師 ${target.doctorName}` }}</p>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <USelect v-model="form.toRole" label="受話者職稱" :options="target.source === 'ipd' ? [{ label: '護理師', value: 'nurse' }, { label: '醫師', value: 'doctor' }] : [{ label: '醫師', value: 'doctor' }]" :error="save.fieldErrors.value.toRole" />
        <UInput v-model="form.to" label="受話者姓名" placeholder="例：王小明" :error="save.fieldErrors.value.to" />
      </div>
      <UCheckbox v-model="form.readBack" label="對方已複誦病人姓名、檢驗項目與數值，確認無誤" />
      <p v-if="save.fieldErrors.value.readBack" class="text-xs text-red-600">{{ save.fieldErrors.value.readBack }}</p>
      <UTextarea v-model="form.note" label="備註（選填）" :rows="2" placeholder="例：醫師表示會立刻處理" />
    </div>
    <template #footer>
      <UButton variant="secondary" @click="target = undefined">取消</UButton>
      <UButton :icon="PhoneCall" :loading="save.pending.value" @click="submit">記錄通報</UButton>
    </template>
  </UDialog>
</template>
