<script setup lang="ts">
// 放射師排班：一般攝影、電腦斷層、磁振造影每天上午、下午由誰負責（一週一頁）。放射科組長（權限 radiology.roster）可以改，其他人看。
// 不擋排程；沒排人的時段，已排的檢查標「沒有排放射師」，下面列出未來 14 天受影響的檢查。服務層 rad-roster.ts
import { computed, ref } from 'vue'
import { UButton, UDialog, UQueryState } from '@/components/ui'
import { radRosterApi } from '@/services'
import type { RadShift } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { addDays, today } from '@/utils/date'

const open = defineModel<boolean>({ required: true })
const from = ref(today())
const { data, loading } = useQuery(async () => (open.value ? { from: from.value, v: await radRosterApi.radRoster(from.value, 7) } : undefined), [open, from])
const r = computed(() => (data.value?.from === from.value ? data.value.v : undefined))
const set = useAction(radRosterApi.setRadShift, { success: '已更新排班' })
function onPick(date: string, room: RadShift['room'], block: RadShift['block'], e: Event) {
  set.run({ date, room, block, userId: (e.target as HTMLSelectElement).value })
}
const wd = (d: string) => '日一二三四五六'[new Date(`${d}T00:00:00`).getDay()]
</script>

<template>
  <UDialog v-model="open" title="放射師排班" size="lg">
    <div class="space-y-3 text-sm">
      <div class="flex flex-wrap items-center gap-2">
        <UButton size="sm" variant="secondary" @click="from = addDays(from, -7)">上一週</UButton>
        <span class="tabular">{{ from.slice(5) }} 起 7 天</span>
        <UButton size="sm" variant="secondary" @click="from = addDays(from, 7)">下一週</UButton>
        <span class="text-xs text-slate-500">超音波由醫師做、心電圖由技術員做，不用排放射師</span>
      </div>
      <UQueryState :loading="loading && !r" :ready="!!r">
        <template v-if="r">
          <div class="overflow-x-auto">
            <table class="min-w-[36rem] text-xs">
              <thead><tr class="text-left text-slate-500"><th class="px-2 py-1">日期</th><th class="px-2 py-1">檢查室</th><th class="px-2 py-1">上午 08:00–12:30</th><th class="px-2 py-1">下午 12:30–17:00</th></tr></thead>
              <tbody>
                <template v-for="d in r.days" :key="d.date">
                  <tr v-for="(room, i) in d.rooms" :key="d.date + room.room" :class="i === 0 ? 'border-t border-slate-200' : ''">
                    <td class="tabular px-2 py-1 font-medium text-slate-700"><template v-if="i === 0">{{ d.date.slice(5) }}（{{ wd(d.date) }}）</template></td>
                    <td class="px-2 py-1">{{ room.name }}</td>
                    <td v-for="b in room.blocks" :key="b.block" class="px-2 py-1">
                      <span v-if="b.closed" class="text-slate-400">{{ b.closed }}</span>
                      <select v-else-if="r.canEdit && d.date >= r.from && d.date >= today()" class="form-control py-0.5 text-xs" :value="b.userId ?? ''" :aria-label="`${d.date} ${room.name} ${b.label}`" @change="onPick(d.date, room.room, b.block, $event)">
                        <option value="">（沒排）</option>
                        <option v-for="t in r.radtechs" :key="t.id" :value="t.id">{{ t.name }}</option>
                      </select>
                      <span v-else :class="b.name ? 'text-slate-700' : 'text-slate-400'">{{ b.name ?? '沒排' }}</span>
                      <span v-if="!b.userId && b.exams" class="ml-1 font-semibold text-red-700">{{ b.exams }} 筆檢查</span>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <div v-if="r.unstaffed.length" class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
            <div class="font-semibold text-amber-900">未來 14 天沒有放射師的檢查</div>
            <ul class="mt-1 space-y-0.5 text-xs text-amber-900">
              <li v-for="x in r.unstaffed" :key="x.id" class="tabular">{{ x.start.slice(5) }} {{ x.roomName }}・{{ x.patientName }}（{{ x.missing }}）</li>
            </ul>
          </div>
          <p v-if="!r.canEdit" class="text-xs text-slate-500">排班由放射科組長（權限「放射師排班」）安排。</p>
        </template>
      </UQueryState>
    </div>
    <template #footer><UButton variant="secondary" @click="open = false">關閉</UButton></template>
  </UDialog>
</template>
