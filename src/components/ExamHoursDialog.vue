<script setup lang="ts">
// 檢查室開放時段：每間、每週幾（空白＝不開）＋休診日。管理員、放射科醫師可以改，其他人看。
// 改了之後排在時段外、休診日的檢查列「需改期」（影像檢查室一鍵排到下一個空檔）。服務層 exam.ts
import { computed, reactive, ref, watch } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import { UButton, UDialog, UInput, USelect } from '@/components/ui'
import { EXAM_ROOMS, examApi } from '@/services'
import type { ExamRoomHours } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { addDays, today } from '@/utils/date'

const open = defineModel<boolean>({ required: true })
const { data } = useQuery(async () => (open.value ? examApi.examHoursSettings() : undefined), [open])
const grid = ref<{ room: ExamRoomHours['room']; weekday: number; weekdayLabel: string; roomName: string; start: string; end: string; closed: boolean }[]>([])
watch(data, (d) => {
  if (d) grid.value = d.rows.map((r) => ({ room: r.room, weekday: r.weekday, weekdayLabel: r.weekdayLabel, roomName: r.roomName, start: r.start ?? '', end: r.end ?? '', closed: r.closed }))
})
const days = computed(() => grid.value.filter((g) => g.room === 'XR').map((g) => ({ weekday: g.weekday, label: g.weekdayLabel })))
const cell = (room: string, wd: number) => grid.value.find((g) => g.room === room && g.weekday === wd)!
const save = useAction(examApi.setExamHours, { success: (r) => `已更新開放時段${r.needsReschedule ? `，${r.needsReschedule} 筆檢查需改期` : ''}` })
async function onSave() {
  const rows: ExamRoomHours[] = grid.value.map((g) => (g.closed ? { room: g.room, weekday: g.weekday, closed: true as const } : { room: g.room, weekday: g.weekday, start: g.start, end: g.end }))
  if (await save.run(rows)) open.value = false
}
const cl = reactive({ date: addDays(today(), 1), room: '', reason: '' })
const addCl = useAction(examApi.addExamClosure, { success: (r) => `已設休診${r.needsReschedule ? `，${r.needsReschedule} 筆檢查需改期` : ''}` })
async function onAddClosure() {
  if (await addCl.run({ date: cl.date, ...(cl.room ? { room: cl.room as ExamRoomHours['room'] } : {}), reason: cl.reason })) cl.reason = ''
}
const delCl = useAction(examApi.removeExamClosure, { success: '已取消休診' })
const roomOptions = [{ value: '', label: '全部檢查室' }, ...EXAM_ROOMS.map((r) => ({ value: r.id, label: r.name }))]
</script>

<template>
  <UDialog v-model="open" title="檢查室開放時段" size="xl">
    <div v-if="data" class="space-y-4 text-sm">
      <div class="overflow-x-auto">
        <table class="w-full min-w-[46rem] text-xs">
          <thead class="text-left text-slate-500"><tr><th class="py-1">檢查室</th><th v-for="d in days" :key="d.weekday">週{{ d.label }}</th></tr></thead>
          <tbody>
            <tr v-for="r in EXAM_ROOMS" :key="r.id" class="border-t border-slate-100 align-top">
              <td class="py-1.5 pr-2 font-semibold">{{ r.name }}</td>
              <td v-for="d in days" :key="d.weekday" class="py-1.5 pr-1">
                <template v-if="cell(r.id, d.weekday)">
                  <label class="flex items-center gap-1"><input v-model="cell(r.id, d.weekday).closed" type="checkbox" :disabled="!data.canEdit" />不開</label>
                  <template v-if="!cell(r.id, d.weekday).closed">
                    <input v-model="cell(r.id, d.weekday).start" type="time" class="form-control mt-0.5 w-full px-1 py-0.5 text-xs" :disabled="!data.canEdit" :aria-label="`${r.name}週${d.label}開始`" />
                    <input v-model="cell(r.id, d.weekday).end" type="time" class="form-control mt-0.5 w-full px-1 py-0.5 text-xs" :disabled="!data.canEdit" :aria-label="`${r.name}週${d.label}結束`" />
                  </template>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="save.fieldErrors.value.hours" class="mt-1 text-xs text-red-600">{{ save.fieldErrors.value.hours }}</p>
        <p class="mt-1 text-xs text-slate-500">改了之後，排在時段外的檢查會列「需改期」（不自動搬）。</p>
      </div>
      <section class="space-y-2">
        <b>休診日</b>
        <p v-if="!data.closures.length" class="text-xs text-slate-400">沒有</p>
        <ul v-else class="space-y-1 text-xs">
          <li v-for="c in data.closures" :key="c.id" class="flex items-center gap-2"><span class="tabular">{{ c.date }}</span><b>{{ c.roomName }}</b><span>{{ c.reason }}</span><span class="text-slate-400">{{ c.byName }}</span>
            <UButton v-if="data.canEdit" size="sm" variant="ghost" :icon="Trash2" :loading="delCl.pending.value" @click="delCl.run(c.id)">取消</UButton></li>
        </ul>
        <div v-if="data.canEdit" class="flex flex-wrap items-end gap-2">
          <UInput v-model="cl.date" type="date" class="w-40" label="日期" :error="addCl.fieldErrors.value.date" />
          <USelect v-model="cl.room" class="w-36" label="檢查室" :options="roomOptions" />
          <UInput v-model="cl.reason" class="flex-1" label="原因" placeholder="例：國定假日、消防演練" :error="addCl.fieldErrors.value.reason" />
          <UButton size="sm" :loading="addCl.pending.value" @click="onAddClosure">加休診日</UButton>
        </div>
      </section>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">{{ data?.canEdit ? '取消' : '關閉' }}</UButton>
      <UButton v-if="data?.canEdit" :loading="save.pending.value" @click="onSave">儲存時段</UButton>
    </template>
  </UDialog>
</template>
