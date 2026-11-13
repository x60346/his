<script setup lang="ts">
// 單日調整：某天某診的停診或代診（系統管理 → 排班、掛號頁共用；權限 schedule.suspend，可設定）。
// 動手之前先看「會影響誰」：對話框先列出已掛號的病人，再選擇代診（病人轉給同科醫師）或停診（退掛＋通知）。
import { computed, reactive, ref, watch } from 'vue'
import { UBadge, UButton, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import { masterApi, scheduleApi, type AffectedVisit, type SessionImpact, type SessionView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { addDays, periodLabel, today, weekdayLabel } from '@/utils/date'

const emit = defineEmits<{ suspended: [] }>()
const date = ref(addDays(today(), 1))
const deptId = ref<string | number | undefined>('')
const { data: depts } = useQuery(() => masterApi.listDepartments())
const { data, loading } = useQuery(
  async () => {
    const d = date.value
    return { d, list: await scheduleApi.listSessions({ date: d, deptId: String(deptId.value ?? '') || undefined }) }
  },
  [date, deptId],
)
const sessions = computed(() => (data.value?.d === date.value ? data.value.list : undefined))

// ---------- 調整對話框 ----------
const open = ref(false)
const impact = ref<SessionImpact>()
const form = reactive({ mode: 'substitute' as 'substitute' | 'suspend', doctorId: undefined as string | number | undefined, reason: '' })
/** 停診完成後的通知名單（留在對話框裡，看得到要打給誰） */
const result = ref<AffectedVisit[] | null>(null)
async function openAdjust(s: SessionView) {
  impact.value = await scheduleApi.getSessionImpact(s.id)
  Object.assign(form, { mode: impact.value.candidates.length ? 'substitute' : 'suspend', doctorId: impact.value.candidates[0]?.id, reason: '' })
  result.value = null
  sub.fieldErrors.value = {}
  sus.fieldErrors.value = {}
  open.value = true
}
watch(open, (v) => !v && (impact.value = undefined))

const sub = useAction(scheduleApi.substituteSession, { success: (s) => `已改由 ${s.doctorName} 代診，掛號一併轉移` })
const sus = useAction(scheduleApi.suspendSession, { success: (list) => `已停診，${list.length} 位病人待通知` })
const fieldErr = computed(() => (form.mode === 'substitute' ? sub.fieldErrors.value : sus.fieldErrors.value))
async function submit() {
  const s = impact.value?.session
  if (!s) return
  if (form.mode === 'substitute') {
    if (await sub.run(s.id, String(form.doctorId ?? ''), form.reason)) open.value = false
  } else {
    const list = await sus.run(s.id, form.reason)
    if (list) {
      result.value = list
      emit('suspended')
    }
  }
}
const reasonPresets = computed(() => (form.mode === 'substitute' ? ['請假', '出國開會', '支援他院'] : ['醫師病假', '颱風停診', '設備維修']))
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-end gap-3">
      <UInput v-model="date" type="date" label="日期" :min="today()" class="w-40" />
      <USelect v-model="deptId" label="科別" :options="[{ label: '全部科別', value: '' }, ...(depts ?? []).filter((d) => d.active).map((d) => ({ label: d.name, value: d.id }))]" class="w-40" />
      <span class="pb-2 text-sm text-slate-600">{{ weekdayLabel(date) ? `星期${weekdayLabel(date)}` : '' }}</span>
    </div>

    <UQueryState :loading="loading && !sessions" :ready="!!sessions?.length" empty-title="這一天沒有門診">
      <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
        <li v-for="s in sessions" :key="s.id" :class="['flex items-center gap-3 px-3 py-2 text-sm', s.suspended && 'bg-slate-50 text-slate-400']">
          <span class="w-12 text-xs font-medium text-slate-600">{{ periodLabel[s.period] }}</span>
          <span class="tabular w-14 text-xs text-slate-500">{{ s.roomNo }} 診</span>
          <span class="w-20 text-xs text-slate-500">{{ s.deptName }}</span>
          <span :class="['font-medium', s.suspended ? 'line-through' : 'text-slate-800']">{{ s.doctorName }}</span>
          <UBadge v-if="s.suspended" tone="red">停診：{{ s.suspended.reason }}</UBadge>
          <UBadge v-else-if="s.originalDoctorName" tone="yellow">代診（原{{ s.originalDoctorName }}・{{ s.substituteReason }}）</UBadge>
          <span class="tabular ml-auto text-xs text-slate-500">已掛 {{ s.booked }} / {{ s.limit }}</span>
          <UButton
            size="sm"
            variant="secondary"
            :disabled="!!s.suspended || s.closed"
            :title="s.suspended ? '此診次已停診' : s.closed ? '此診次已結束，無法停診或代診' : ''"
            @click="openAdjust(s)"
          >停診・代診</UButton>
        </li>
      </ul>
    </UQueryState>

    <UDialog v-model="open" :title="impact ? `${impact.session.date}（${weekdayLabel(impact.session.date)}）${periodLabel[impact.session.period]}・${impact.session.doctorName}` : ''">
      <div v-if="impact" class="space-y-4 text-sm">
        <!-- 停診完成：顯示通知名單 -->
        <template v-if="result">
          <p class="rounded-md bg-emerald-50 px-3 py-2 text-emerald-800">已停診。以下 {{ result.length }} 位病人的掛號已退掛，請逐一電話通知（名單也列在「停診通知」）。</p>
          <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
            <li v-for="v in result" :key="v.visitId" class="flex gap-3 px-3 py-1.5"><span class="tabular w-10 text-slate-500">#{{ v.seqNo }}</span><span class="flex-1">{{ v.patientName }}</span><span class="tabular">{{ v.phone }}</span></li>
          </ul>
        </template>

        <p v-else-if="impact.blocked" class="rounded-md bg-amber-50 px-3 py-2 text-amber-900">{{ impact.blocked }}</p>

        <template v-else>
          <section>
            <h4 class="mb-1 font-medium text-slate-700">受影響的掛號（{{ impact.visits.length }}）</h4>
            <p v-if="!impact.visits.length" class="text-slate-500">目前沒有人掛號。</p>
            <ul v-else class="max-h-40 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
              <li v-for="v in impact.visits" :key="v.visitId" class="flex gap-3 px-3 py-1"><span class="tabular w-10 text-slate-500">#{{ v.seqNo }}</span><span class="flex-1">{{ v.patientName }}</span><span class="tabular text-slate-500">{{ v.phone }}</span></li>
            </ul>
          </section>

          <section class="space-y-2">
            <div class="flex gap-2">
              <button
                v-for="m in [{ k: 'substitute', l: '代診（病人轉給同科醫師）' }, { k: 'suspend', l: '停診（退掛並通知）' }] as const"
                :key="m.k"
                :class="['flex-1 rounded-md border px-3 py-2 text-left', form.mode === m.k ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50']"
                @click="form.mode = m.k"
              >{{ m.l }}</button>
            </div>
            <template v-if="form.mode === 'substitute'">
              <USelect
                v-if="impact.candidates.length"
                v-model="form.doctorId"
                label="代診醫師"
                required
                :options="impact.candidates.map((c) => ({ label: c.name, value: c.id }))"
                hint="同科、在職、此時段沒有其他門診的醫師"
                :error="fieldErr.doctorId"
              />
              <p v-else class="rounded-md bg-amber-50 px-3 py-2 text-amber-900">{{ impact.session.deptName }}沒有其他醫師在這個時段有空，無法代診，只能停診。</p>
            </template>
            <p v-else-if="impact.visits.length" class="rounded-md bg-red-50 px-3 py-2 text-red-800">停診後，上面 {{ impact.visits.length }} 筆掛號會退掛，並列入停診通知名單。</p>
            <div class="flex flex-wrap gap-1.5">
              <UButton v-for="r in reasonPresets" :key="r" size="sm" variant="secondary" @click="form.reason = r">{{ r }}</UButton>
            </div>
            <UInput v-model="form.reason" :label="form.mode === 'substitute' ? '代診原因' : '停診原因'" required :error="fieldErr.reason" />
          </section>
        </template>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">{{ result || impact?.blocked ? '關閉' : '取消' }}</UButton>
        <UButton
          v-if="impact && !impact.blocked && !result"
          :variant="form.mode === 'suspend' ? 'danger' : 'primary'"
          :disabled="form.mode === 'substitute' && !impact.candidates.length"
          :loading="sub.pending.value || sus.pending.value"
          @click="submit"
        >{{ form.mode === 'substitute' ? '確認代診' : '確認停診' }}</UButton>
      </template>
    </UDialog>
  </div>
</template>
