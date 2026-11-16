<script setup lang="ts">
// 檢驗（醫檢師）：左邊「待檢驗」（還沒發報告的，舊的在前；住院還沒採檢的灰色、不能登打）與「已報告」（某一天發出或更正的），
// 右邊逐項登打 → 即時標示偏高偏低、危急（同一個 lab-rules.judgeLab）→ 發報告。已發出的只能「更正」：寫原因、留舊值，醫師要重新確認。
import { computed, ref, watch } from 'vue'
import { FlaskConical, Pencil, Send } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UEmpty, UInput, UQueryState, USelect, UTabs, UTextarea } from '@/components/ui'
import { judgeLab, LAB_FLAG_TEXT, labApi } from '@/services'
import type { Gender, LabFlag, LabItemDef } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { followToday } from '@/composables/useClock'
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { ageText, today } from '@/utils/date'
import { genderLabel } from '@/utils/labels'

const tab = ref<'work' | 'done'>('work')
const date = ref(today())
const todayStr = followToday(date)
const { data: work, loading } = useQuery(() => labApi.listLabWork())
const { data: done, loading: doneLoading } = useQuery(() => labApi.listLabReports({ date: date.value }), [date])
const tabs = computed(() => [
  { key: 'work', label: '待檢驗', count: work.value?.filter((w) => !w.awaitingCollection).length },
  { key: 'done', label: '已報告', count: done.value?.length },
])

// 選中的：待檢驗用 key、已報告用 id（清單重查後用最新那份）
const selKey = ref<string>()
const selId = ref<string>()
useRevealOnNarrow(computed(() => selKey.value ?? selId.value))
const item = computed(() => work.value?.find((w) => w.key === selKey.value))
const report = computed(() => done.value?.find((r) => r.id === selId.value))
watch(tab, () => ((selKey.value = undefined), (selId.value = undefined)))

// ---------- 登打（新報告或更正共用） ----------
const values = ref<Record<string, string>>({})
const reason = ref('')
const correcting = ref(false)
/** 表單身分：換了一筆才重設（mutate 讓清單重查時不洗掉打到一半的數字） */
const formKey = computed(() => (item.value ? `w:${item.value.key}` : report.value ? `r:${report.value.id}:${report.value.corrections?.length ?? 0}` : ''))
watch(formKey, () => {
  correcting.value = false
  reason.value = ''
  values.value = item.value ? {} : Object.fromEntries((report.value?.values ?? []).map((v) => [v.code, v.value]))
  submit.fieldErrors.value = {}
  fix.fieldErrors.value = {}
})

const gender = computed<Gender>(() => (item.value ?? report.value)?.gender ?? 'M')
const defs = computed<(LabItemDef & { ref: string })[]>(() => item.value?.items ?? report.value?.items ?? [])
/**
 * 每一項的判讀：登打中＝即時判讀（和服務層發報告同一條規則 judgeLab）；看已發出的報告＝報告上存的。
 * text 空字串＝還沒填
 */
interface Shown { value: string; text: string; flag: LabFlag; critical: boolean; error?: string }
const shown = computed<Record<string, Shown>>(() => {
  const out: Record<string, Shown> = {}
  for (const d of defs.value) {
    if (editable.value) {
      const raw = values.value[d.code] ?? ''
      if (!raw.trim()) out[d.code] = { value: '', text: '', flag: '', critical: false }
      else {
        const j = judgeLab(d, raw, gender.value)
        out[d.code] = 'error' in j ? { value: raw, text: '', flag: '', critical: false, error: j.error } : { value: raw, text: LAB_FLAG_TEXT[j.flag] || '正常', flag: j.flag, critical: j.critical }
      }
    } else {
      const v = report.value?.values.find((x) => x.code === d.code)
      out[d.code] = v ? { value: v.value, text: LAB_FLAG_TEXT[v.flag] || '正常', flag: v.flag, critical: !!v.critical } : { value: '—', text: '', flag: '', critical: false }
    }
  }
  return out
})
const criticalNow = computed(() => (editable.value ? defs.value.filter((d) => shown.value[d.code]?.critical) : []))

const submit = useAction(labApi.reportLab, { success: (r) => `已發報告 ${r.no}${r.hasCritical ? '（危急值：已通知醫師）' : ''}` })
const fix = useAction(labApi.correctLab, { success: (r) => `已更正 ${r.no}，醫師會收到通知` })
async function onSubmit() {
  if (!item.value) return
  if (await submit.run({ key: item.value.key, values: values.value })) selKey.value = work.value?.find((w) => w.key !== item.value?.key && !w.awaitingCollection)?.key
}
async function onFix() {
  if (report.value && (await fix.run(report.value.id, { values: values.value, reason: reason.value }))) correcting.value = false
}
const errors = computed(() => ({ ...submit.fieldErrors.value, ...fix.fieldErrors.value }))
const editable = computed(() => (!!item.value && !item.value.awaitingCollection) || correcting.value)

const flagTone = (f: string, critical?: boolean) => (critical ? 'text-red-700 font-bold' : f ? 'text-amber-800 font-semibold' : 'text-slate-800')
const whenText = (s: string) => s.slice(5, 16).replace('-', '/')
</script>

<template>
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]">
    <UCard :padded="false" class="self-start">
      <template #title><span class="flex items-center gap-2 text-sm font-semibold text-slate-800"><FlaskConical class="h-4 w-4" />檢驗</span></template>
      <template v-if="tab === 'done'" #actions><div class="w-40"><UInput v-model="date" type="date" :max="todayStr" aria-label="報告日期" /></div></template>
      <div class="px-3"><UTabs v-model="tab" :tabs="tabs" /></div>

      <UQueryState v-if="tab === 'work'" :loading="loading && !work" :ready="!!work?.length" empty-title="沒有待檢驗的項目" empty-description="門診批價後、住院採檢後會出現在這裡">
        <ul class="max-h-[calc(100vh-14rem)] divide-y divide-slate-100 overflow-y-auto">
          <li v-for="w in work" :key="w.key">
            <button :class="['flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-slate-50', w.key === selKey && '!bg-brand-50', w.awaitingCollection && 'opacity-60']" @click="selKey = w.key">
              <span class="min-w-0 flex-1">
                <span class="block font-medium text-slate-800">{{ w.patientName }} <span class="tabular text-xs font-normal text-slate-500">{{ w.chartNo }}</span></span>
                <span class="block text-sm text-slate-700">{{ w.procName }}</span>
                <span class="block text-xs text-slate-500">{{ w.where }}・{{ w.doctorName }}・{{ whenText(w.orderedAt) }} 開立</span>
              </span>
              <UBadge v-if="w.awaitingCollection" tone="gray">待採檢</UBadge>
              <UBadge v-else :tone="w.source === 'ipd' ? 'purple' : 'blue'">{{ w.source === 'ipd' ? '住院' : '門診' }}</UBadge>
            </button>
          </li>
        </ul>
      </UQueryState>
      <UQueryState v-else :loading="doneLoading && !done" :ready="!!done?.length" empty-title="這天沒有發出或更正的報告">
        <ul class="max-h-[calc(100vh-14rem)] divide-y divide-slate-100 overflow-y-auto">
          <li v-for="r in done" :key="r.id">
            <button :class="['flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-slate-50', r.id === selId && '!bg-brand-50']" @click="selId = r.id">
              <span class="min-w-0 flex-1">
                <span class="block font-medium text-slate-800">{{ r.patientName }} <span class="tabular text-xs font-normal text-slate-500">{{ r.chartNo }}</span></span>
                <span class="block text-sm text-slate-700">{{ r.procName }}</span>
                <span class="tabular block text-xs text-slate-500">{{ r.no }}・{{ whenText(r.reportedAt) }} 發出</span>
              </span>
              <span class="flex flex-col items-end gap-1">
                <UBadge v-if="r.hasCritical" tone="red">危急值</UBadge>
                <UBadge v-if="r.corrections?.length" tone="yellow">已更正</UBadge>
                <UBadge v-if="r.needsAck" tone="gray">醫師未確認</UBadge>
              </span>
            </button>
          </li>
        </ul>
      </UQueryState>
    </UCard>

    <UCard v-if="!item && !report" data-detail><UEmpty title="請從左邊選一筆檢驗" :description="tab === 'work' ? '舊的在前；住院的要護理師採檢後才能登打' : '已發出的報告可以更正（寫原因）'" /></UCard>
    <UCard v-else data-detail :padded="false">
      <template #title>
        <div class="text-base font-semibold text-slate-800">{{ (item ?? report)!.patientName }}
          <span class="text-sm font-normal text-slate-500">{{ (item ?? report)!.chartNo }}<template v-if="item">・{{ genderLabel[item.gender] }}・{{ ageText(item.birthDate) }}</template></span>
        </div>
        <div class="text-sm text-slate-600">
          <template v-if="item">{{ item.procName }}・{{ item.where }}・{{ item.doctorName }}・{{ whenText(item.orderedAt) }} 開立</template>
          <template v-else-if="report">{{ report.procName }}・<span class="tabular">{{ report.no }}</span>・{{ report.reportedByName }} {{ whenText(report.reportedAt) }} 發出・開立醫師 {{ report.doctorName }}</template>
        </div>
      </template>
      <div v-if="item?.awaitingCollection" class="mx-4 mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600" role="status">護理師還沒採檢（臨時醫囑還沒執行），採檢後才能登打。</div>
      <div v-if="report?.needsAck" class="mx-4 mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">醫師還沒確認（{{ report.hasCritical ? '危急值' : '更正過' }}）：已出現在醫師首頁。</div>
      <div v-else-if="report?.ackAt" class="mx-4 mt-3 text-xs text-slate-500">醫師 {{ report.ackByName }} 已於 {{ whenText(report.ackAt) }} 確認</div>

      <table class="tabular mt-2 w-full text-sm">
        <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500">
          <tr>
            <th class="px-4 py-1.5 text-left font-medium">項目</th>
            <th class="px-2 text-left font-medium">結果</th>
            <th class="px-2 text-left font-medium">判讀</th>
            <th class="px-2 text-left font-medium">單位</th>
            <th class="px-4 text-left font-medium">參考範圍</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-for="d in defs" :key="d.code">
            <td class="whitespace-nowrap px-4 py-2"><div class="font-medium text-slate-800">{{ d.name }}</div><div class="text-xs text-slate-500">{{ d.code }}</div></td>
            <td class="w-40 px-2 py-2">
              <template v-if="editable">
                <USelect v-if="d.options" v-model="values[d.code]" :aria-label="d.name" placeholder="請選擇" :options="d.options.map((o) => ({ label: o, value: o }))" :error="errors[d.code]" />
                <UInput v-else v-model="values[d.code]" :aria-label="d.name" inputmode="decimal" :error="errors[d.code]" />
              </template>
              <span v-else :class="flagTone(shown[d.code].flag, shown[d.code].critical)">{{ shown[d.code].value }}</span>
            </td>
            <td class="whitespace-nowrap px-2 py-2">
              <span v-if="shown[d.code].error" class="text-xs text-red-600">{{ shown[d.code].error }}</span>
              <template v-else-if="shown[d.code].text">
                <span :class="flagTone(shown[d.code].flag, shown[d.code].critical)">{{ shown[d.code].text }}</span>
                <UBadge v-if="shown[d.code].critical" tone="red" class="ml-1">危急</UBadge>
              </template>
            </td>
            <td class="whitespace-nowrap px-2 py-2 text-xs text-slate-500">{{ d.unit }}</td>
            <td class="whitespace-nowrap px-4 py-2 text-xs text-slate-500">{{ d.ref }}</td>
          </tr>
        </tbody>
      </table>

      <!-- 更正紀錄：舊值都留著 -->
      <div v-if="report?.corrections?.length" class="mx-4 mt-3 space-y-1 text-xs text-slate-600">
        <div v-for="(c, i) in report.corrections" :key="i">更正 {{ whenText(c.at) }}：{{ c.reason }}（原：{{ c.before.filter((b) => report!.values.find((v) => v.code === b.code)?.value !== b.value).map((v) => `${v.name} ${v.value}`).join('、') }}）</div>
      </div>

      <div class="space-y-2 border-t border-slate-100 px-4 py-3">
        <p v-if="editable && criticalNow.length" class="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800" role="alert">
          危急值：{{ criticalNow.map((d) => d.name).join('、') }}。發出後會立即出現在醫師首頁，請同時電話通知開立醫師。
        </p>
        <UTextarea v-if="correcting" v-model="reason" label="更正原因" :rows="2" placeholder="例：檢體溶血重驗、登打錯誤" required :error="errors.reason" />
        <div class="flex justify-end gap-2">
          <UButton v-if="item && !item.awaitingCollection" :icon="Send" :loading="submit.pending.value" @click="onSubmit">發報告</UButton>
          <template v-if="report">
            <UButton v-if="!correcting" variant="secondary" :icon="Pencil" @click="correcting = true">更正</UButton>
            <template v-else>
              <UButton variant="ghost" @click="correcting = false">取消</UButton>
              <UButton :loading="fix.pending.value" @click="onFix">送出更正</UButton>
            </template>
          </template>
        </div>
      </div>
    </UCard>
  </div>
</template>
