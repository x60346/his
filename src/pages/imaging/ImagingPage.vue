<script setup lang="ts">
// 影像判讀（醫師）：放射科醫師判讀 X 光、超音波、電腦斷層；其他醫師在這裡判讀自己開的心電圖。
// 左邊「待判讀」（舊的在前；檢查室還沒做完的灰色、不能寫）與「已報告」（某天發出或補充的），
// 右邊寫「所見」「結論」（可一鍵帶入正常範本再改），有重要發現（氣胸、腦出血…）勾起來——開立醫師要確認。
// 發出後原文不能改，只能「補充報告」。規則都在服務層 imaging.ts。
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { FileText, ScanLine, Send } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UCheckbox, UEmpty, UInput, UQueryState, UTabs, UTextarea } from '@/components/ui'
import { imagingApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { followToday } from '@/composables/useClock'
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { useAuth } from '@/stores/auth'
import { ageText, today } from '@/utils/date'
import { genderLabel } from '@/utils/labels'

const auth = useAuth()
const isAdmin = computed(() => auth.user?.role === 'admin')
const route = useRoute()
const tab = ref<'work' | 'done'>('work')
const date = ref(today())
const todayStr = followToday(date)
const { data: work, loading } = useQuery(() => imagingApi.listImagingWork())
const { data: done, loading: doneLoading } = useQuery(() => imagingApi.listImagingReports({ date: date.value }), [date])
const tabs = computed(() => [
  { key: 'work', label: '待判讀', count: work.value?.filter((w) => !w.awaitingExam).length },
  { key: 'done', label: '已報告', count: done.value?.length },
])

// 從病人的影像清單點「判讀」進來：?key= 直接選好那一筆
const selKey = ref<string | undefined>(typeof route.query.key === 'string' ? route.query.key : undefined)
const selId = ref<string>()
useRevealOnNarrow(computed(() => selKey.value ?? selId.value))
const item = computed(() => work.value?.find((w) => w.key === selKey.value))
const report = computed(() => done.value?.find((r) => r.id === selId.value))
watch(tab, () => ((selKey.value = undefined), (selId.value = undefined)))

const form = ref({ findings: '', impression: '', significant: false })
const add = ref({ text: '', significant: false })
const adding = ref(false)
// 換了一筆才重設（清單重查時不洗掉寫到一半的報告）
watch(() => selKey.value ?? selId.value, () => {
  form.value = { findings: '', impression: '', significant: false }
  add.value = { text: '', significant: false }
  adding.value = false
  submit.fieldErrors.value = {}
  addendum.fieldErrors.value = {}
})
function useNormal() {
  if (!item.value) return
  form.value.findings = item.value.normal.findings
  form.value.impression = item.value.normal.impression
}

const submit = useAction(imagingApi.reportImaging, { success: (r) => `已發報告 ${r.no}${r.significant ? '（重要發現：已通知醫師）' : ''}` })
const addendum = useAction(imagingApi.addImagingAddendum, { success: (r) => `已補充 ${r.no}，醫師會收到通知` })
async function onSubmit() {
  if (!item.value) return
  const key = item.value.key
  if (await submit.run({ key, ...form.value })) selKey.value = work.value?.find((w) => w.key !== key && !w.awaitingExam)?.key
}
async function onAddendum() {
  // 成功就清掉：不然下一次補充會帶著上次的內容與「重要發現」，一按又通知一次
  if (report.value && (await addendum.run(report.value.id, add.value))) { adding.value = false; add.value = { text: '', significant: false } }
}
const when = (s: string) => s.slice(5, 16).replace('-', '/')
</script>

<template>
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]">
    <UCard :padded="false" class="self-start">
      <template #title><span class="flex items-center gap-2 text-sm font-semibold text-slate-800"><ScanLine class="h-4 w-4" />影像判讀</span></template>
      <template v-if="tab === 'done'" #actions><div class="w-40"><UInput v-model="date" type="date" :max="todayStr" aria-label="報告日期" /></div></template>
      <div class="px-3"><UTabs v-model="tab" :tabs="tabs" /></div>
      <UQueryState v-if="tab === 'work'" :loading="loading && !work" :ready="!!work?.length" empty-title="沒有待判讀的影像" empty-description="放射科判讀 X 光、超音波、電腦斷層；心電圖由開立醫師判讀">
        <ul class="max-h-[calc(100vh-14rem)] divide-y divide-slate-100 overflow-y-auto">
          <li v-for="w in work" :key="w.key">
            <button :class="['flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-slate-50', w.key === selKey && '!bg-brand-50', w.awaitingExam && 'opacity-60']" @click="selKey = w.key">
              <span class="min-w-0 flex-1">
                <span class="block font-medium text-slate-800">{{ w.patientName }} <span class="tabular text-xs font-normal text-slate-500">{{ w.chartNo }}</span></span>
                <span class="block text-sm text-slate-700">{{ w.procName }}</span>
                <span class="block text-xs text-slate-500">{{ w.where }}・{{ w.doctorName }}・{{ when(w.orderedAt) }} 開立</span>
              </span>
              <UBadge v-if="w.exam?.noShow" tone="red">病人未到</UBadge>
              <UBadge v-else-if="w.awaitingExam" tone="gray">待檢查</UBadge>
              <UBadge v-else :tone="w.er ? 'red' : w.source === 'ipd' ? 'purple' : 'blue'">{{ w.er ? '急診' : w.source === 'ipd' ? '住院' : '門診' }}</UBadge>
            </button>
          </li>
        </ul>
      </UQueryState>
      <UQueryState v-else :loading="doneLoading && !done" :ready="!!done?.length" empty-title="這天沒有發出或補充的報告">
        <ul class="max-h-[calc(100vh-14rem)] divide-y divide-slate-100 overflow-y-auto">
          <li v-for="r in done" :key="r.id">
            <button :class="['flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-slate-50', r.id === selId && '!bg-brand-50']" @click="selId = r.id">
              <span class="min-w-0 flex-1">
                <span class="block font-medium text-slate-800">{{ r.patientName }} <span class="tabular text-xs font-normal text-slate-500">{{ r.chartNo }}</span></span>
                <span class="block text-sm text-slate-700">{{ r.procName }}</span>
                <span class="tabular block text-xs text-slate-500">{{ r.no }}・{{ when(r.reportedAt) }} 發出</span>
              </span>
              <span class="flex flex-col items-end gap-1">
                <UBadge v-if="r.significant" tone="red">重要發現</UBadge>
                <UBadge v-if="r.addenda?.length" tone="yellow">已補充</UBadge>
                <UBadge v-if="r.needsAck" tone="gray">醫師未確認</UBadge>
              </span>
            </button>
          </li>
        </ul>
      </UQueryState>
    </UCard>

    <UCard v-if="!item && !report" data-detail><UEmpty title="請從左邊選一筆影像檢查" :description="tab === 'work' ? '舊的在前；影像檢查室完成檢查後才能判讀' : '已發出的報告不能改，可以加補充報告'" /></UCard>
    <UCard v-else-if="item" data-detail>
      <template #title>
        <div class="text-base font-semibold text-slate-800">{{ item.patientName }} <span class="text-sm font-normal text-slate-500">{{ item.chartNo }}・{{ genderLabel[item.gender] }}・{{ ageText(item.birthDate) }}</span></div>
        <div class="text-sm text-slate-600">{{ item.procName }}・{{ item.where }}・{{ item.doctorName }}・{{ when(item.orderedAt) }} 開立</div>
      </template>
      <div class="space-y-3">
        <div class="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700"><span class="text-xs text-slate-500">臨床資訊</span><div>{{ item.clinical || '（未填診斷）' }}</div></div>
        <p v-if="item.awaitingExam" class="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600" role="status">還沒做檢查（臨時醫囑還沒執行），做完後才能判讀。</p>
        <template v-else-if="!isAdmin">
          <div class="flex justify-end"><UButton size="sm" variant="secondary" :icon="FileText" @click="useNormal">帶入正常範本</UButton></div>
          <UTextarea v-model="form.findings" label="所見" :rows="4" required :error="submit.fieldErrors.value.findings" />
          <UTextarea v-model="form.impression" label="結論" :rows="2" required :error="submit.fieldErrors.value.impression" />
          <UCheckbox v-model="form.significant" label="重要發現（例：氣胸、腦出血、遊離氣體）——開立醫師要確認，並請電話通知" />
          <div class="flex justify-end"><UButton :icon="Send" :loading="submit.pending.value" @click="onSubmit">發報告</UButton></div>
        </template>
      </div>
    </UCard>
    <UCard v-else-if="report" data-detail>
      <template #title>
        <div class="text-base font-semibold text-slate-800">{{ report.patientName }} <span class="text-sm font-normal text-slate-500">{{ report.chartNo }}</span></div>
        <div class="text-sm text-slate-600">{{ report.procName }}・<span class="tabular">{{ report.no }}</span>・判讀 {{ report.readerName }} {{ when(report.reportedAt) }}・開立 {{ report.doctorName }}</div>
      </template>
      <div class="space-y-3 text-sm">
        <p v-if="report.needsAck" class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900" role="status">醫師還沒確認（{{ report.significant ? '重要發現' : '補充報告' }}）：已出現在醫師首頁。</p>
        <p v-else-if="report.ackAt" class="text-xs text-slate-500">{{ report.ackByName }} 已於 {{ when(report.ackAt) }} 確認</p>
        <div><div class="text-xs text-slate-500">所見</div><p class="whitespace-pre-wrap text-slate-800">{{ report.findings }}</p></div>
        <div><div class="text-xs text-slate-500">結論</div><p :class="['whitespace-pre-wrap font-semibold', report.significant ? 'text-red-700' : 'text-slate-800']">{{ report.impression }}<UBadge v-if="report.significant" tone="red" class="ml-2">重要發現</UBadge></p></div>
        <div v-for="(a, i) in report.addenda ?? []" :key="i" class="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2">
          <div class="text-xs text-amber-800">補充報告 {{ when(a.at) }}<UBadge v-if="a.significant" tone="red" class="ml-1">重要發現</UBadge></div>
          <p class="whitespace-pre-wrap text-slate-800">{{ a.text }}</p>
        </div>
        <template v-if="report.canAddendum">
          <template v-if="adding">
            <UTextarea v-model="add.text" label="補充內容" :rows="3" placeholder="原報告不會改；例：與 11/10 舊片比較，浸潤範圍增加" required :error="addendum.fieldErrors.value.text" />
            <UCheckbox v-model="add.significant" label="重要發現" />
            <div class="flex justify-end gap-2"><UButton variant="ghost" @click="adding = false">取消</UButton><UButton :loading="addendum.pending.value" @click="onAddendum">送出補充</UButton></div>
          </template>
          <div v-else class="flex justify-end"><UButton variant="secondary" @click="adding = true">補充報告</UButton></div>
        </template>
      </div>
    </UCard>
  </div>
</template>
