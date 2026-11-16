<script setup lang="ts">
// 預約回診（看診頁）：醫師當場替這位病人約下次門診——快速選「1／2／4 週後」（慢性病連續處方另有「處方用完前」），
// 服務層已找好最近一個可掛的自己的診；也可以選日期再挑同科的診次。約好就是正式掛號（有看診號），接著印預約單。
// 這一科已有未來的掛號：列出來，要勾「仍要再約」才送（服務層也會擋）。規則都在 booking.ts（followUpOptions、bookFollowUp）
import { computed, ref, watch } from 'vue'
import { CalendarPlus } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UQueryState } from '@/components/ui'
import RegistrationSlip from '@/components/RegistrationSlip.vue'
import { bookingApi, type VisitView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { addDays, periodLabel, today, weekdayLabel } from '@/utils/date'

const props = defineProps<{ visitId?: string }>()
const open = defineModel<boolean>({ default: false })
const { data: opts, loading } = useQuery(async () => (open.value && props.visitId ? bookingApi.followUpOptions(props.visitId) : undefined), [open, () => props.visitId])
const date = ref('')
const picked = ref<string>()
const again = ref(false)
watch(open, (v) => {
  if (v) {
    date.value = ''
    picked.value = undefined
    again.value = false
  }
})
const { data: sessions, loading: sLoading } = useQuery(async () => (open.value && props.visitId && date.value > today() ? bookingApi.followUpSessions(props.visitId, date.value) : undefined), [date, open])
const md = (d: string) => `${d.slice(5).replace('-', '/')}（${weekdayLabel(d)}）`
const book = useAction(bookingApi.bookFollowUp, { success: (v) => `已預約回診：${md(v.date)} ${periodLabel[v.period]} ${v.doctorName} 第 ${v.seqNo} 號` })
const hasExisting = computed(() => !!opts.value?.existing.length)
const slipOpen = ref(false)
const slipVisit = ref<VisitView>()
async function onBook(sessionId: string) {
  if (!props.visitId) return
  const v = await book.run(props.visitId, { sessionId, confirmDuplicate: again.value })
  if (v) {
    open.value = false
    slipVisit.value = v
    slipOpen.value = true
  }
}
</script>

<template>
  <UDialog v-model="open" :title="`預約回診${opts ? `：${opts.patientName}（${opts.deptName}）` : ''}`" size="lg">
    <UQueryState :loading="loading && !opts" :ready="!!opts">
      <div v-if="opts" class="space-y-4 text-sm">
        <div v-if="hasExisting" class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900" role="status">
          這一科已有未來的掛號：
          <span v-for="(x, i) in opts.existing" :key="x.visitId"><template v-if="i">、</template>{{ md(x.date) }} {{ periodLabel[x.period] }} {{ x.doctorName }} #{{ x.seqNo }}<template v-if="x.byFollowUp">（醫師預約）</template></span>
          <label class="mt-1 flex items-center gap-1.5"><input v-model="again" type="checkbox" class="h-4 w-4 rounded border-slate-300 text-brand-600" />仍要再約一次（例：一週後看報告、一個月後追蹤）</label>
          <p v-if="book.fieldErrors.value.confirmDuplicate" class="text-xs text-red-600">{{ book.fieldErrors.value.confirmDuplicate }}</p>
        </div>

        <section>
          <h4 class="mb-1.5 text-xs font-semibold text-slate-500">快速預約（自己的門診）</h4>
          <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
            <li v-for="s in opts.suggestions" :key="s.label" class="flex flex-wrap items-center gap-3 px-3 py-2">
              <span class="w-48 font-medium text-slate-800">{{ s.label }}</span>
              <span v-if="s.session" class="tabular text-slate-700">{{ md(s.session.date) }} {{ periodLabel[s.session.period] }}・{{ s.session.roomNo }} 診・已掛 {{ s.session.booked }}／{{ s.session.limit }}</span>
              <span v-else class="text-xs text-slate-500">{{ md(s.date) }} 起一週內沒有可掛的門診，請選日期</span>
              <UButton v-if="s.session" size="sm" class="ml-auto" :icon="CalendarPlus" :disabled="hasExisting && !again" :loading="book.pending.value" @click="onBook(s.session.id)">預約</UButton>
            </li>
          </ul>
        </section>

        <section>
          <h4 class="mb-1.5 text-xs font-semibold text-slate-500">或選日期（同科的門診）</h4>
          <div class="w-48"><UInput v-model="date" type="date" :min="addDays(today(), 1)" aria-label="回診日期" /></div>
          <UQueryState v-if="date" :loading="sLoading && !sessions" :ready="!!sessions?.length" empty-title="這天這一科沒有門診">
            <ul class="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
              <li v-for="s in sessions" :key="s.id" :class="['flex flex-wrap items-center gap-3 px-3 py-2', s.blocked && 'text-slate-400']">
                <span class="tabular w-32">{{ periodLabel[s.period] }}・{{ s.roomNo }} 診</span>
                <span>{{ s.doctorName }}<UBadge v-if="s.mine" tone="blue" class="ml-1">自己</UBadge></span>
                <span class="tabular text-xs text-slate-500">已掛 {{ s.booked }}／{{ s.limit }}</span>
                <UBadge v-if="s.blocked" tone="gray">{{ s.blocked }}</UBadge>
                <UButton v-else size="sm" variant="secondary" class="ml-auto" :disabled="hasExisting && !again" :loading="book.pending.value" @click="onBook(s.id)">預約</UButton>
              </li>
            </ul>
          </UQueryState>
        </section>
        <p class="text-xs text-slate-500">預約就是正式掛號（身分、案件類別沿用這次）；當天報到、看診、批價照常。改期或取消請到櫃台。</p>
      </div>
    </UQueryState>
    <template #footer><UButton variant="secondary" @click="open = false">關閉</UButton></template>
  </UDialog>
  <RegistrationSlip v-model="slipOpen" :visit="slipVisit" />
</template>
