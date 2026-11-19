<script setup lang="ts">
// 待預約回診（櫃台）：醫師寫「幾週後回診」交給櫃台——過期（建議日過一週）、該掛了、還早，建議日早的在前。
// 聯絡病人後：選日期與這一科的診（醫師指定的要掛那位）掛號；或標「病人自己掛」「不回診」（寫原因）。
// 病人在這一科之後已經有掛號的會提示（可能自己掛了）。服務層 booking.listAdvices／bookAdvice／closeAdvice
import { reactive, ref } from 'vue'
import { CalendarPlus, Phone } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UInput, UQueryState } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { bookingApi, type AdviceView, type FollowUpSession } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { addDays, periodLabel, today } from '@/utils/date'

const includeClosed = ref(false)
const { data, loading } = useQuery(() => bookingApi.listAdvices({ includeClosed: includeClosed.value }), [includeClosed])
const STATE = { overdue: { tone: 'red', label: '過期' }, due: { tone: 'yellow', label: '該掛了' }, upcoming: { tone: 'gray', label: '還早' }, closed: { tone: 'green', label: '' } } as const
const md = (d: string) => d.slice(5).replace('-', '/')
// 掛號：選日期 → 這一科的診
const booking = reactive<Record<string, { date: string; sessions?: FollowUpSession[] }>>({})
async function openBook(a: AdviceView) {
  const d = a.targetDate > today() ? a.targetDate : addDays(today(), 1)
  booking[a.id] = { date: d }
  await loadSessions(a)
}
async function loadSessions(a: AdviceView) {
  const b = booking[a.id]
  if (b) b.sessions = await bookingApi.adviceSessions(a.id, b.date).catch(() => [])
}
const book = useAction(bookingApi.bookAdvice, { success: (a) => `已掛號：${a.patientName} ${a.bookedText}` })
async function onBook(a: AdviceView, sessionId: string) {
  if (await book.run(a.id, sessionId)) delete booking[a.id]
}
const close = useAction(bookingApi.closeAdvice, { success: (a) => `已標記：${a.patientName} ${a.statusLabel}` })
const declining = ref<AdviceView>()
async function onDecline(note: string) {
  if (declining.value && (await close.run(declining.value.id, { result: 'declined', note }))) declining.value = undefined
}
</script>

<template>
  <div class="space-y-3 text-sm">
    <UCheckbox v-model="includeClosed" label="連處理過的一起看（最近 30 天）" />
    <UQueryState :loading="loading && !data" :ready="!!data?.length" empty-title="沒有待預約的建議回診">
      <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
        <li v-for="a in data" :key="a.id" class="space-y-1 px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge v-if="a.state !== 'closed'" :tone="STATE[a.state].tone">{{ STATE[a.state].label }}</UBadge>
            <UBadge v-else tone="green">{{ a.statusLabel }}</UBadge>
            <b>{{ a.patientName }}</b><span class="text-xs text-slate-500">{{ a.chartNo }}</span>
            <span class="inline-flex items-center gap-1 text-xs text-slate-600"><Phone class="h-3 w-3" />{{ a.phone }}</span>
            <span class="min-w-0 flex-1">建議 <b class="tabular">{{ md(a.targetDate) }}</b> 前後回診 {{ a.deptName }}{{ a.doctorName ? `（指定 ${a.doctorName}）` : '' }}：{{ a.reason }}</span>
            <span class="text-xs text-slate-500">{{ a.adviserName }} {{ md(a.at.slice(0, 10)) }} 建議</span>
          </div>
          <p v-if="a.laterVisit" class="text-xs text-blue-800">病人之後在這一科已有掛號：{{ md(a.laterVisit.date) }} {{ a.laterVisit.doctorName }}（可能自己掛了）</p>
          <p v-if="a.bookedText" class="text-xs text-emerald-800">已掛：{{ a.bookedText }}</p>
          <p v-if="a.note" class="text-xs text-slate-600">說明：{{ a.note }}</p>
          <div v-if="a.status === 'pending'" class="flex flex-wrap items-center justify-end gap-1">
            <UButton size="sm" :icon="CalendarPlus" @click="openBook(a)">掛號</UButton>
            <UButton size="sm" variant="secondary" :loading="close.pending.value" @click="close.run(a.id, { result: 'self' })">病人自己掛</UButton>
            <UButton size="sm" variant="ghost" @click="declining = a">不回診</UButton>
          </div>
          <div v-if="booking[a.id]" class="space-y-1 rounded border border-slate-200 bg-slate-50 p-2">
            <div class="w-44"><UInput v-model="booking[a.id].date" type="date" :min="addDays(today(), 1)" aria-label="掛號日期" @change="loadSessions(a)" /></div>
            <p v-if="booking[a.id].sessions && !booking[a.id].sessions!.length" class="text-xs text-slate-500">這天這一科沒有門診</p>
            <ul v-else class="space-y-1">
              <li v-for="s in booking[a.id].sessions" :key="s.id" :class="['flex flex-wrap items-center gap-2 text-xs', s.blocked && 'text-slate-400']">
                <span class="w-28">{{ periodLabel[s.period] }}・{{ s.roomNo }} 診</span><span>{{ s.doctorName }}<UBadge v-if="s.mine" tone="blue" class="ml-1">指定</UBadge></span>
                <span class="tabular text-slate-500">已掛 {{ s.booked }}／{{ s.limit }}</span>
                <UBadge v-if="s.blocked" tone="gray">{{ s.blocked }}</UBadge>
                <UButton v-else size="sm" variant="secondary" class="ml-auto" :loading="book.pending.value" @click="onBook(a, s.id)">掛這診</UButton>
              </li>
            </ul>
          </div>
        </li>
      </ul>
    </UQueryState>
    <ReasonDialog :model-value="!!declining" title="病人不回診" :subject="declining ? `${declining.patientName}：${declining.reason}` : ''" label="原因" :presets="['改到別家醫院', '症狀已改善', '聯絡不到多次']" ok-text="記錄" :pending="close.pending.value" :error="close.fieldErrors.value.note" @update:model-value="(x: boolean) => !x && (declining = undefined)" @confirm="onDecline" />
  </div>
</template>
