<script setup lang="ts">
// 預約未到追蹤（櫃台）：最近 14 天就醫日已過、還沒報到的預約。出院後回診、醫師約的回診、慢性病標「要追」（首頁待辦只算這些），
// 病人自己掛、沒來的也列著但不催。每筆可以：改約（掛同一科的新診次，原本那筆留著）、記「病人不需要」（寫原因，結案）、
// 記「聯絡不到」（還在清單上，可以再打）。判斷與檢查都在服務層（booking.listNoShows / rebookNoShow / recordNoShowContact）
import { computed, ref, watch } from 'vue'
import { CalendarPlus, Phone } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState } from '@/components/ui'
import { bookingApi, scheduleApi, type NoShowItem } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { addDays, periodLabel, today, weekdayLabel } from '@/utils/date'

const includeClosed = ref(false)
const { data: list, loading } = useQuery(() => bookingApi.listNoShows({ includeClosed: includeClosed.value }), [includeClosed])
const open = computed(() => (list.value ?? []).filter((x) => !x.closed))
const md = (d: string) => `${d.slice(5).replace('-', '/')}（${weekdayLabel(d)}）`

// ---------- 改約 ----------
const rb = ref<NoShowItem>()
const rbDate = ref('')
const rbNote = ref('')
watch(rb, () => {
  rbDate.value = addDays(today(), 1)
  rbNote.value = ''
})
const { data: sessions, loading: sLoading } = useQuery(async () => (rb.value && rbDate.value >= today() ? scheduleApi.listSessions({ date: rbDate.value, deptId: rb.value.deptId }) : undefined), [rb, rbDate])
const rebook = useAction(bookingApi.rebookNoShow, { success: (v) => `已改約：${md(v.date)} ${periodLabel[v.period]} ${v.doctorName} 第 ${v.seqNo} 號` })
async function onRebook(sessionId: string) {
  if (rb.value && (await rebook.run(rb.value.id, { sessionId, note: rbNote.value }))) rb.value = undefined
}

// ---------- 聯絡結果 ----------
const ct = ref<NoShowItem>()
const ctResult = ref<'declined' | 'unreachable'>('unreachable')
const ctNote = ref('')
function openContact(x: NoShowItem, r: 'declined' | 'unreachable') {
  ct.value = x
  ctResult.value = r
  ctNote.value = ''
  record.fieldErrors.value = {}
}
const record = useAction(bookingApi.recordNoShowContact, { success: (x) => `已記錄：${x.patientName} ${x.contacts.at(-1)?.resultLabel}` })
async function onRecord() {
  if (ct.value && (await record.run(ct.value.id, { result: ctResult.value, note: ctNote.value }))) ct.value = undefined
}
</script>

<template>
  <div class="space-y-2 text-sm">
    <div class="flex flex-wrap items-center gap-3">
      <p class="text-slate-600">
        還沒結案 <b class="tabular text-red-600">{{ open.length }}</b> 筆（要追的 <b class="tabular">{{ open.filter((x) => x.important).length }}</b> 筆）・最近 14 天
      </p>
      <UCheckbox v-model="includeClosed" class="ml-auto">含已結案</UCheckbox>
    </div>
    <UQueryState :loading="loading && !list" :ready="!!list?.length" empty-title="最近 14 天沒有預約未到">
      <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
        <li v-for="x in list" :key="x.id" :class="['space-y-1 px-3 py-2', x.closed && 'text-slate-400']">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="tabular w-36 text-xs">{{ md(x.date) }} {{ periodLabel[x.period] }}</span>
            <span class="w-28 text-xs">{{ x.deptName }} {{ x.doctorName }} #{{ x.seqNo }}</span>
            <span class="font-medium" :class="x.closed ? '' : 'text-slate-800'">{{ x.patientName }}</span>
            <span class="tabular text-xs text-slate-500">{{ x.chartNo }}</span>
            <span class="tabular flex items-center gap-1 text-xs"><Phone class="h-3 w-3" />{{ x.phone || '—' }}</span>
            <UBadge :tone="x.closed ? 'gray' : x.kind === 'afterDischarge' ? 'red' : x.important ? 'yellow' : 'gray'" :title="x.afterDischarge ? `住院 ${x.afterDischargeAdmitNo}，${x.afterDischargeByName} 醫師出院前預約` : x.followUpByName ? `${x.followUpByName} 醫師看診時預約` : ''">{{ x.kindLabel }}</UBadge>
            <span v-if="!x.closed" class="ml-auto flex gap-1">
              <UButton size="sm" :icon="CalendarPlus" @click="rb = x">改約</UButton>
              <UButton size="sm" variant="secondary" @click="openContact(x, 'unreachable')">聯絡不到</UButton>
              <UButton size="sm" variant="ghost" @click="openContact(x, 'declined')">不需要</UButton>
            </span>
          </div>
          <p v-if="x.laterVisit && !x.closed" class="text-xs text-sky-700">
            <template v-if="x.laterVisit.status === 'registered'">之後已有{{ x.deptName }}掛號：{{ md(x.laterVisit.date) }} {{ x.laterVisit.doctorName }}（可能自己掛了，聯絡前先確認）</template>
            <template v-else>之後已來看過{{ x.deptName }}：{{ md(x.laterVisit.date) }} {{ x.laterVisit.doctorName }}（可能不必再追）</template>
          </p>
          <ul v-if="x.contacts.length" class="tabular text-xs text-slate-500">
            <li v-for="(c, i) in x.contacts" :key="i">
              {{ c.at.slice(5).replace('-', '/') }} {{ c.byName }}：<b :class="c.result === 'unreachable' ? 'text-amber-700' : ''">{{ c.resultLabel }}</b>
              <template v-if="c.rebooked">→ {{ md(c.rebooked.date) }} {{ periodLabel[c.rebooked.period] }} {{ c.rebooked.doctorName }} #{{ c.rebooked.seqNo }}</template>
              <template v-if="c.note">（{{ c.note }}）</template>
            </li>
          </ul>
        </li>
      </ul>
    </UQueryState>

    <UDialog :model-value="!!rb" :title="`改約：${rb?.patientName ?? ''}（${rb?.deptName ?? ''}）`" size="lg" @update:model-value="(v: boolean) => !v && (rb = undefined)">
      <div v-if="rb" class="space-y-3 text-sm">
        <p class="text-slate-600">原本 {{ md(rb.date) }} {{ periodLabel[rb.period] }} {{ rb.doctorName }} #{{ rb.seqNo }} 沒來。改約後原本那筆留著（查得到沒來），{{ rb.important ? `新的那筆仍標「${rb.kindLabel}」` : '' }}</p>
        <div class="flex flex-wrap items-end gap-3">
          <div class="w-44"><UInput v-model="rbDate" type="date" :min="today()" label="改約日期" /></div>
          <div class="min-w-48 flex-1"><UInput v-model="rbNote" label="備註（選填）" placeholder="例：病人說忘記了" /></div>
        </div>
        <UQueryState :loading="sLoading && !sessions" :ready="!!sessions?.length" empty-title="這天這一科沒有門診">
          <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
            <li v-for="s in sessions" :key="s.id" :class="['flex flex-wrap items-center gap-3 px-3 py-2', !s.bookable && 'text-slate-400']">
              <span class="tabular w-32">{{ periodLabel[s.period] }}・{{ s.roomNo }} 診</span>
              <span>{{ s.doctorName }}<UBadge v-if="s.doctorId === rb.doctorId" tone="blue" class="ml-1">原醫師</UBadge></span>
              <span class="tabular text-xs text-slate-500">已掛 {{ s.booked }}／{{ s.limit }}</span>
              <UBadge v-if="!s.bookable" tone="gray">{{ s.suspended ? '停診' : s.full ? '額滿' : '已截止' }}</UBadge>
              <UButton v-else size="sm" class="ml-auto" :loading="rebook.pending.value" @click="onRebook(s.id)">掛這診</UButton>
            </li>
          </ul>
        </UQueryState>
      </div>
    </UDialog>

    <UDialog :model-value="!!ct" :title="ctResult === 'declined' ? '病人不需要回診' : '聯絡不到'" size="sm" @update:model-value="(v: boolean) => !v && (ct = undefined)" @submit="onRecord">
      <p class="mb-2 text-sm text-slate-600">{{ ct?.patientName }}・{{ ct ? md(ct.date) : '' }} {{ ct?.doctorName }}。{{ ctResult === 'declined' ? '記錄後結案。' : '還會留在清單上，可以再聯絡。' }}</p>
      <UInput v-model="ctNote" :label="ctResult === 'declined' ? '原因' : '備註（選填）'" :required="ctResult === 'declined'" :placeholder="ctResult === 'declined' ? '例：已在他院追蹤' : '例：電話沒人接'" :error="record.fieldErrors.value.note" />
      <template #footer>
        <UButton variant="secondary" @click="ct = undefined">取消</UButton>
        <UButton type="submit" :loading="record.pending.value">記錄</UButton>
      </template>
    </UDialog>
  </div>
</template>
