<script setup lang="ts">
// 換班與請假（護理排班頁下方）：我的申請（可撤回）、別人請我換班（同意／不同意）、待核准（護理長：核准／退回）。
// 換班選對象時就列出「換完同一天兩班」（不能選）與「休息不到 8 小時」（提醒）——和服務層同一個 swapCheck
import { computed, reactive, ref, watch } from 'vue'
import { UBadge, UButton, UCard, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { LEAVE_TYPES, shiftRequestApi, type ShiftRequestView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'

const emit = defineEmits<{ changed: [] }>()
const auth = useAuth()
const isNurse = computed(() => auth.user?.role === 'nurse')
const { data, loading, reload } = useQuery(() => shiftRequestApi.listShiftRequests())
const { data: myShifts, reload: reloadShifts } = useQuery(async () => (isNurse.value ? shiftRequestApi.myUpcomingShifts() : []))
const statusView: Record<ShiftRequestView['status'], { text: string; tone: 'yellow' | 'cyan' | 'green' | 'red' | 'gray' }> = {
  'pending-peer': { text: '等對方同意', tone: 'cyan' }, pending: { text: '等護理長核准', tone: 'yellow' }, approved: { text: '已核准', tone: 'green' },
  rejected: { text: '退回', tone: 'red' }, declined: { text: '對方不同意', tone: 'red' }, cancelled: { text: '已撤回', tone: 'gray' },
}
const done = () => {
  reload()
  reloadShifts()
  emit('changed')
}

// ---------- 請假 ----------
const lvOpen = ref(false)
const lv = reactive({ shiftId: '' as string | number | undefined, leaveType: '' as string | number | undefined, reason: '' })
const leave = useAction(shiftRequestApi.requestLeave, { success: '已送出請假申請，等護理長核准' })
async function submitLeave() {
  if (await leave.run({ shiftId: String(lv.shiftId ?? ''), leaveType: String(lv.leaveType ?? ''), reason: lv.reason })) {
    lvOpen.value = false
    done()
  }
}

// ---------- 換班 ----------
const swOpen = ref(false)
const sw = reactive({ shiftId: '' as string | number | undefined, date: '', targetShiftId: '', reason: '' })
watch(() => sw.shiftId, (id) => (sw.date = myShifts.value?.find((x) => x.id === id)?.date ?? ''))
const { data: cands } = useQuery(async () => (swOpen.value && sw.shiftId && sw.date ? shiftRequestApi.swapCandidates(String(sw.shiftId), sw.date) : []), [swOpen, () => sw.shiftId, () => sw.date])
const pickedCand = computed(() => cands.value?.find((x) => x.id === sw.targetShiftId))
const swap = useAction(shiftRequestApi.requestSwap, { success: '已送出換班申請，等對方同意' })
async function submitSwap() {
  if (await swap.run({ shiftId: String(sw.shiftId ?? ''), targetShiftId: sw.targetShiftId, reason: sw.reason })) {
    swOpen.value = false
    done()
  }
}

// ---------- 回覆、核准、撤回 ----------
const respond = useAction(shiftRequestApi.respondSwap, { success: (r) => (r.status === 'pending' ? '已同意，等護理長核准' : '已回覆不同意') })
const decide = useAction(shiftRequestApi.decideShiftRequest, { success: (r) => (r.status === 'approved' ? '已核准，班表已更新' : '已退回') })
const cancel = useAction(shiftRequestApi.cancelShiftRequest, { success: '已撤回' })
const reasonFor = ref<{ id: string; kind: 'decline' | 'reject' }>()
async function onReason(note: string) {
  const r = reasonFor.value
  if (!r) return
  const ok = r.kind === 'decline' ? await respond.run(r.id, false, note) : await decide.run(r.id, false, note)
  if (ok) {
    reasonFor.value = undefined
    done()
  }
}
async function run<T>(p: Promise<T | undefined>) {
  if (await p) done()
}
</script>

<template>
  <UCard title="換班與請假" :padded="false">
    <template #actions>
      <span v-if="isNurse" class="flex gap-1.5">
        <UButton size="sm" variant="secondary" @click="(lv.shiftId = ''), (lv.leaveType = ''), (lv.reason = ''), (leave.fieldErrors.value = {}), (lvOpen = true)">申請請假</UButton>
        <UButton size="sm" variant="secondary" @click="(sw.shiftId = ''), (sw.date = ''), (sw.targetShiftId = ''), (sw.reason = ''), (swap.fieldErrors.value = {}), (swOpen = true)">申請換班</UButton>
      </span>
    </template>
    <UQueryState :loading="loading && !data" :ready="!!data">
      <div v-if="data" class="space-y-3 p-4 text-sm">
        <section v-if="data.toApprove.length">
          <div class="mb-1 font-semibold text-slate-700">待核准 {{ data.toApprove.length }}</div>
          <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
            <li v-for="r in data.toApprove" :key="r.id" class="space-y-1 px-3 py-2">
              <div class="flex flex-wrap items-center gap-2"><b>{{ r.requesterName }}</b><span>{{ r.text }}</span><span class="text-xs text-slate-500">{{ r.reason }}</span></div>
              <p v-for="w in r.warnings" :key="w" class="text-xs text-amber-800">休息不足：{{ w }}</p>
              <p v-if="r.block" class="text-xs font-semibold text-red-700">{{ r.block }}</p>
              <div class="flex gap-1.5">
                <UButton size="sm" :disabled="!!r.block" :loading="decide.pending.value" @click="run(decide.run(r.id, true))">核准</UButton>
                <UButton size="sm" variant="ghost" @click="reasonFor = { id: r.id, kind: 'reject' }">退回</UButton>
              </div>
            </li>
          </ul>
        </section>
        <section v-if="data.toRespond.length">
          <div class="mb-1 font-semibold text-slate-700">別人請我換班</div>
          <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
            <li v-for="r in data.toRespond" :key="r.id" class="space-y-1 px-3 py-2">
              <div class="flex flex-wrap items-center gap-2"><b>{{ r.requesterName }}</b><span>{{ r.text }}</span><span class="text-xs text-slate-500">{{ r.reason }}</span></div>
              <p v-for="w in r.warnings" :key="w" class="text-xs text-amber-800">休息不足：{{ w }}</p>
              <div class="flex gap-1.5">
                <UButton size="sm" :loading="respond.pending.value" @click="run(respond.run(r.id, true))">同意</UButton>
                <UButton size="sm" variant="ghost" @click="reasonFor = { id: r.id, kind: 'decline' }">不同意</UButton>
              </div>
            </li>
          </ul>
        </section>
        <section>
          <div class="mb-1 font-semibold text-slate-700">我的申請</div>
          <p v-if="!data.mine.length" class="text-xs text-slate-500">最近 30 天沒有申請。</p>
          <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
            <li v-for="r in data.mine" :key="r.id" class="flex flex-wrap items-center gap-2 px-3 py-2">
              <UBadge :tone="statusView[r.status].tone">{{ statusView[r.status].text }}</UBadge>
              <span>{{ r.text }}</span>
              <span v-if="r.peer?.note || r.decideNote" class="text-xs text-slate-500">{{ r.decideNote ?? r.peer?.note }}</span>
              <UButton v-if="r.status === 'pending' || r.status === 'pending-peer'" size="sm" variant="ghost" class="ml-auto" @click="run(cancel.run(r.id))">撤回</UButton>
            </li>
          </ul>
        </section>
      </div>
    </UQueryState>

    <UDialog v-model="lvOpen" title="申請請假" size="sm" @submit="submitLeave">
      <div class="space-y-3">
        <USelect v-model="lv.shiftId" label="哪一班" required placeholder="選擇自己接下來的班" :options="(myShifts ?? []).map((x) => ({ label: x.text, value: x.id }))" />
        <USelect v-model="lv.leaveType" label="假別" required placeholder="選擇" :options="LEAVE_TYPES.map((x) => ({ label: x, value: x }))" :error="leave.fieldErrors.value.leaveType" />
        <UInput v-model="lv.reason" label="原因" required :error="leave.fieldErrors.value.reason" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="lvOpen = false">取消</UButton>
        <UButton type="submit" :loading="leave.pending.value">送出</UButton>
      </template>
    </UDialog>

    <UDialog v-model="swOpen" title="申請換班" @submit="submitSwap">
      <div class="space-y-3 text-sm">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <USelect v-model="sw.shiftId" label="我的班" required placeholder="選擇自己接下來的班" :options="(myShifts ?? []).map((x) => ({ label: x.text, value: x.id }))" />
          <UInput v-model="sw.date" type="date" label="換到哪一天的班" />
        </div>
        <div v-if="sw.shiftId && cands" class="max-h-56 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2">
          <p v-if="!cands.length" class="text-xs text-slate-500">這天沒有別人的班。</p>
          <label v-for="c in cands" :key="c.id" :class="['flex items-start gap-2 rounded px-2 py-1', c.block ? 'opacity-50' : 'cursor-pointer hover:bg-slate-50']">
            <input v-model="sw.targetShiftId" type="radio" :value="c.id" :disabled="!!c.block" class="mt-0.5 h-4 w-4" />
            <span><b>{{ c.nurseName }}</b> {{ c.text }}<span v-if="c.block" class="block text-xs text-red-700">{{ c.block }}</span><span v-for="w in c.warnings" :key="w" class="block text-xs text-amber-800">休息不足：{{ w }}</span></span>
          </label>
        </div>
        <p v-if="swap.fieldErrors.value.targetShiftId" class="text-xs text-red-600">{{ swap.fieldErrors.value.targetShiftId }}</p>
        <p v-if="pickedCand?.warnings.length" class="text-xs text-amber-800">休息不到 8 小時只提醒，可以送出。</p>
        <UInput v-model="sw.reason" label="原因" required :error="swap.fieldErrors.value.reason" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="swOpen = false">取消</UButton>
        <UButton type="submit" :disabled="!sw.targetShiftId" :loading="swap.pending.value">送出</UButton>
      </template>
    </UDialog>

    <ReasonDialog :model-value="!!reasonFor" :title="reasonFor?.kind === 'decline' ? '不同意換班' : '退回申請'" label="原因" :presets="reasonFor?.kind === 'decline' ? ['那天已經有安排', '換完休息不夠'] : ['人力不足', '請改其他日期']" :pending="respond.pending.value || decide.pending.value" :error="respond.fieldErrors.value.note ?? decide.fieldErrors.value.note" @update:model-value="(x: boolean) => !x && (reasonFor = undefined)" @confirm="onReason" />
  </UCard>
</template>
