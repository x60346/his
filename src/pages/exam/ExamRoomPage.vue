<script setup lang="ts">
// 影像檢查室：上方「待排程」（門診批價後、住院開立後還沒排的影像，舊的在前）——選時間排進對應的檢查室；
// 下方各檢查室當天的排程（依時間），病人到了按「報到」、做完按「完成」（住院醫囑一起完成），完成後進判讀清單。
// 排程與操作由櫃台或放射科醫師；護理師只能看。撞期、開放時段由服務層擋（exam.ts、exam-rules）
import { computed, reactive, ref } from 'vue'
import { CalendarClock } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UInput, UPageHeader, UQueryState } from '@/components/ui'
import { EXAM_DAY, examApi, type ExamBoard } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { addDays, now, today } from '@/utils/date'

const date = ref(today())
const { data, loading } = useQuery(() => examApi.examBoard(date.value), [date])
const board = computed<ExamBoard | undefined>(() => (data.value?.date === date.value ? data.value : undefined))
// 預設排在下一個整點（開放時段內）
const nextSlot = () => {
  const t = now()
  const h = Number(t.slice(11, 13)) + 1
  return h < Number(EXAM_DAY.start.slice(0, 2)) ? { d: t.slice(0, 10), tm: EXAM_DAY.start } : h >= Number(EXAM_DAY.end.slice(0, 2)) ? { d: addDays(t.slice(0, 10), 1), tm: EXAM_DAY.start } : { d: t.slice(0, 10), tm: `${String(h).padStart(2, '0')}:00` }
}
const slot = reactive<Record<string, { d: string; tm: string }>>({})
const slotOf = (key: string) => (slot[key] ??= nextSlot())
const sched = useAction(examApi.scheduleExam, { success: (e) => `已排程：${e.roomName} ${e.start.slice(5)}（${e.patientName} ${e.procName}）` })
const err = ref<{ key: string; msg: string }>()
async function schedule(key: string) {
  const s = slotOf(key)
  const r = await sched.run(key, `${s.d} ${s.tm}`)
  err.value = r ? undefined : { key, msg: sched.fieldErrors.value.start ?? '' }
}
const arrive = useAction(examApi.arriveExam, { success: (e) => `已報到：${e.patientName}` })
const done = useAction(examApi.completeExam, { success: (e) => `檢查完成：${e.patientName} ${e.procName}，進判讀清單` })
const TONE = { scheduled: 'blue', arrived: 'yellow', done: 'green' } as const
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="影像檢查室" :description="`排程（${EXAM_DAY.start}–${EXAM_DAY.end}，同一間不能撞期）、報到、完成；完成後才進判讀清單`">
      <input v-model="date" type="date" class="form-control w-44" aria-label="日期" />
    </UPageHeader>
    <UQueryState :loading="loading && !board" :ready="!!board">
      <template v-if="board">
        <UCard :padded="false">
          <template #title><span class="flex items-center gap-2 text-sm font-semibold"><CalendarClock class="h-4 w-4" />待排程 <UBadge v-if="board.toSchedule.length" tone="yellow">{{ board.toSchedule.length }}</UBadge></span></template>
          <p v-if="!board.toSchedule.length" class="px-4 py-3 text-sm text-slate-400">沒有待排程的影像檢查</p>
          <ul v-else class="divide-y divide-slate-100 text-sm">
            <li v-for="w in board.toSchedule" :key="w.key" class="flex flex-wrap items-end gap-2 px-4 py-2">
              <div class="min-w-[14rem] flex-1">
                <b>{{ w.patientName }}</b> <span class="text-xs text-slate-500">{{ w.where }}</span>
                <div class="text-xs text-slate-700">{{ w.procName }}・{{ w.roomName }}・約 {{ w.minutes }} 分・{{ w.doctorName }} {{ w.orderedAt.slice(5) }} 開立</div>
                <p v-if="err?.key === w.key && err.msg" class="text-xs text-red-600">{{ err.msg }}</p>
              </div>
              <template v-if="board.canSchedule">
                <UInput v-model="slotOf(w.key).d" type="date" class="w-40" label="日期" />
                <UInput v-model="slotOf(w.key).tm" type="time" class="w-28" label="時間" />
                <UButton size="sm" :loading="sched.pending.value" @click="schedule(w.key)">排程</UButton>
              </template>
            </li>
          </ul>
          <p v-if="!board.canSchedule" class="px-4 pb-2 text-xs text-slate-500">排程與報到、完成由櫃台或放射科處理。</p>
        </UCard>
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <UCard v-for="r in board.rooms" :key="r.room" :title="r.name" :padded="false">
            <p v-if="!r.exams.length" class="px-4 py-3 text-sm text-slate-400">這天沒有排檢查</p>
            <ul v-else class="divide-y divide-slate-100 text-sm">
              <li v-for="e in r.exams" :key="e.id" class="flex flex-wrap items-center gap-2 px-4 py-2">
                <span class="tabular w-24 text-xs text-slate-600">{{ e.start.slice(11) }}–{{ e.end.slice(11) }}</span>
                <span class="min-w-0 flex-1"><b>{{ e.patientName }}</b> <span class="text-xs text-slate-500">{{ e.where }}</span><span class="block text-xs text-slate-700">{{ e.procName }}</span></span>
                <UBadge :tone="TONE[e.stage]">{{ e.stageLabel }}</UBadge>
                <template v-if="board.canSchedule">
                  <UButton v-if="e.stage === 'scheduled'" size="sm" variant="secondary" :loading="arrive.pending.value" @click="arrive.run(e.id)">報到</UButton>
                  <UButton v-else-if="e.stage === 'arrived'" size="sm" :loading="done.pending.value" @click="done.run(e.id)">完成</UButton>
                </template>
              </li>
            </ul>
          </UCard>
        </div>
      </template>
    </UQueryState>
  </div>
</template>
