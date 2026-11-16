<script setup lang="ts">
// 預約出院後回診（醫師，住院中）：快速選「1／2／4 週後」主治醫師的門診（服務層找好最近一個可掛的診），
// 或選科別、日期再挑診次（可以約別科：外科住院、內科追蹤血糖）。約好就是正式掛號，接著印預約單。
// 那一科已有未來掛號要勾「仍要再約」（服務層也會擋）。規則在 booking.ts（afterDischargeOptions、bookAfterDischarge）
import { computed, ref, watch } from 'vue'
import { CalendarPlus } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import { bookingApi, masterApi, type VisitView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { addDays, periodLabel, today, weekdayLabel } from '@/utils/date'

const props = defineProps<{ admissionId?: string }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ booked: [v: VisitView] }>()
const { data: opts, loading } = useQuery(async () => (open.value && props.admissionId ? bookingApi.afterDischargeOptions(props.admissionId) : undefined), [open, () => props.admissionId])
const { data: depts } = useQuery(() => masterApi.listDepartments())
const deptId = ref('')
const date = ref('')
const again = ref(false)
watch(open, (v) => {
  if (v) {
    date.value = ''
    again.value = false
    deptId.value = ''
  }
})
watch(opts, (o) => {
  if (o && !deptId.value) deptId.value = o.deptId
})
const { data: sessions, loading: sLoading } = useQuery(
  async () => (open.value && props.admissionId && deptId.value && date.value > today() ? bookingApi.afterDischargeSessions(props.admissionId, date.value, deptId.value) : undefined),
  [date, deptId, open],
)
const md = (d: string) => `${d.slice(5).replace('-', '/')}（${weekdayLabel(d)}）`
const book = useAction(bookingApi.bookAfterDischarge, { success: (v) => `已預約出院後回診：${md(v.date)} ${periodLabel[v.period]} ${v.deptName} ${v.doctorName} 第 ${v.seqNo} 號` })
/** 選的科別已有未來掛號（含剛約的出院回診）：要勾「仍要再約」 */
const existing = computed(() => (opts.value?.booked ?? []).filter((v) => v.deptId === deptId.value && v.status === 'registered'))
const needAgain = computed(() => existing.value.length > 0 || !!book.fieldErrors.value.confirmDuplicate)
async function onBook(sessionId: string) {
  if (!props.admissionId) return
  const v = await book.run(props.admissionId, { sessionId, confirmDuplicate: again.value })
  if (v) {
    open.value = false
    emit('booked', v)
  }
}
</script>

<template>
  <UDialog v-model="open" :title="`預約出院後回診${opts ? `：${opts.patientName}` : ''}`" size="lg">
    <UQueryState :loading="loading && !opts" :ready="!!opts">
      <div v-if="opts" class="space-y-4 text-sm">
        <p class="text-xs text-slate-500">出院後 30 天內第一次回診，門診基本部分負擔比照經轉診。病人沒來時，櫃台的「預約未到追蹤」會優先追。</p>
        <div v-if="needAgain" class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900" role="status">
          <template v-if="existing.length">這一科已約：<span v-for="(x, i) in existing" :key="x.id"><template v-if="i">、</template>{{ md(x.date) }} {{ periodLabel[x.period] }} {{ x.doctorName }} #{{ x.seqNo }}</span></template>
          <template v-else>{{ book.fieldErrors.value.confirmDuplicate }}</template>
          <label class="mt-1 flex items-center gap-1.5"><input v-model="again" type="checkbox" class="h-4 w-4 rounded border-slate-300 text-brand-600" />仍要再約一次（例：一週後看報告、一個月後追蹤）</label>
        </div>

        <section v-if="deptId === opts.deptId">
          <h4 class="mb-1.5 text-xs font-semibold text-slate-500">快速預約（主治醫師的門診）</h4>
          <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
            <li v-for="s in opts.suggestions" :key="s.label" class="flex flex-wrap items-center gap-3 px-3 py-2">
              <span class="w-20 font-medium text-slate-800">{{ s.label }}</span>
              <span v-if="s.session" class="tabular text-slate-700">{{ md(s.session.date) }} {{ periodLabel[s.session.period] }}・{{ s.session.doctorName }}・{{ s.session.roomNo }} 診・已掛 {{ s.session.booked }}／{{ s.session.limit }}</span>
              <span v-else class="text-xs text-slate-500">{{ md(s.date) }} 起一週內沒有可掛的門診，請選日期</span>
              <UButton v-if="s.session" size="sm" class="ml-auto" :icon="CalendarPlus" :disabled="needAgain && !again" :loading="book.pending.value" @click="onBook(s.session.id)">預約</UButton>
            </li>
          </ul>
        </section>

        <section>
          <h4 class="mb-1.5 text-xs font-semibold text-slate-500">或選科別與日期</h4>
          <div class="flex flex-wrap gap-3">
            <div class="w-40"><USelect v-model="deptId" label="科別" :options="(depts ?? []).map((d) => ({ value: d.id, label: d.name }))" /></div>
            <div class="w-44"><UInput v-model="date" type="date" :min="addDays(today(), 1)" label="回診日期" /></div>
          </div>
          <UQueryState v-if="date" :loading="sLoading && !sessions" :ready="!!sessions?.length" empty-title="這天這一科沒有門診">
            <ul class="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
              <li v-for="s in sessions" :key="s.id" :class="['flex flex-wrap items-center gap-3 px-3 py-2', s.blocked && 'text-slate-400']">
                <span class="tabular w-32">{{ periodLabel[s.period] }}・{{ s.roomNo }} 診</span>
                <span>{{ s.doctorName }}<UBadge v-if="s.mine" tone="blue" class="ml-1">主治</UBadge></span>
                <span class="tabular text-xs text-slate-500">已掛 {{ s.booked }}／{{ s.limit }}</span>
                <UBadge v-if="s.blocked" tone="gray">{{ s.blocked }}</UBadge>
                <UButton v-else size="sm" variant="secondary" class="ml-auto" :disabled="needAgain && !again" :loading="book.pending.value" @click="onBook(s.id)">預約</UButton>
              </li>
            </ul>
          </UQueryState>
        </section>
      </div>
    </UQueryState>
  </UDialog>
</template>
