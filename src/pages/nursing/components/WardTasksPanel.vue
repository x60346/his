<script setup lang="ts">
// 本班待辦（全病房）：逾時 → 可給 → 待處理（臨時醫囑、待核對醫囑、本班未量生命徵象）→ 本班稍後，依時間排。
// 點一列就跳到那位病人的對應頁面去做——執行一律在病人頁面（給藥的高警訊雙人核對、原因填寫只寫一份）。
import { computed } from 'vue'
import { UBadge, UQueryState } from '@/components/ui'
import { nursingApi, type WardTask } from '@/services'
import { useQuery } from '@/composables/useService'
import WardSendBack from './WardSendBack.vue'
import WardUdCarts from './WardUdCarts.vue'
import { wardStockApi } from '@/services'

const props = defineProps<{ ward: string; clock: string }>()
const emit = defineEmits<{ open: [admissionId: string, tab: string] }>()

// 時鐘每 30 秒走一次：「可給」「逾時」跟著時間變，所以時間變了就重新查（服務層用同一個 marUrgency 判斷）
const { data, loading } = useQuery(async () => ({ ward: props.ward, tasks: await nursingApi.listWardTasks(props.ward) }), [() => props.ward, () => props.clock])
const tasks = computed(() => (data.value?.ward === props.ward ? data.value.tasks : undefined))
// 病房常備：本班還沒點班、或有低於基準量的品項就提醒（點班在「常備點班」分頁）
const { data: ws } = useQuery(async () => ({ ward: props.ward, v: await wardStockApi.getWardStock(props.ward) }), [() => props.ward, () => props.clock])
const stockNote = computed(() => {
  const v = ws.value?.ward === props.ward ? ws.value.v : undefined
  if (!v) return ''
  const below = v.rows.filter((r) => r.below).length
  return [!v.shift.counted && `本班（${v.shift.shift}）病房常備還沒點班`, below && `${below} 項常備低於基準量（住院藥局會補充）`].filter(Boolean).join('；')
})

const urgencyView = {
  overdue: { label: '逾時', tone: 'red' },
  due: { label: '現在', tone: 'yellow' },
  todo: { label: '待處理', tone: 'cyan' },
  upcoming: { label: '稍後', tone: 'gray' },
} as const
const tabOf: Record<WardTask['kind'], string> = { mar: 'mar', stat: 'mar', ack: 'orders', vitals: 'vitals' }
const counts = computed(() => ({
  overdue: (tasks.value ?? []).filter((t) => t.urgency === 'overdue').length,
  due: (tasks.value ?? []).filter((t) => t.urgency === 'due').length,
}))
</script>

<template>
  <div class="p-4">
    <div class="mb-3 flex flex-wrap items-baseline gap-x-3 text-sm">
      <span class="font-semibold text-slate-700">本班待辦・{{ ward }}</span>
      <span v-if="tasks" class="text-xs text-slate-500">逾時 {{ counts.overdue }}・現在可做 {{ counts.due }}・共 {{ tasks.length }} 項　點選一列前往該病人</span>
    </div>
    <p v-if="stockNote" class="mb-3 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900">{{ stockNote }}（「常備點班」分頁）</p>
    <WardUdCarts :ward="ward" />
    <WardSendBack :ward="ward" />
    <UQueryState :loading="loading && !tasks" :ready="!!tasks?.length" empty-title="本班目前沒有待辦" empty-description="給藥、臨時醫囑、醫囑核對、生命徵象都已完成">
      <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
        <li v-for="t in tasks" :key="t.id">
          <button type="button" :class="['flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50', t.urgency === 'upcoming' && 'text-slate-500']" @click="emit('open', t.admissionId, tabOf[t.kind])">
            <UBadge :tone="urgencyView[t.urgency].tone" class="w-12 justify-center">{{ urgencyView[t.urgency].label }}</UBadge>
            <span class="tabular w-12 shrink-0 text-xs">{{ t.at ? t.at.slice(11) : '' }}</span>
            <span class="tabular w-12 shrink-0 font-medium text-slate-700">{{ t.bedNo }}</span>
            <span class="w-16 shrink-0 truncate font-medium text-slate-800">{{ t.patientName }}</span>
            <span class="min-w-0 flex-1 truncate">{{ t.text }}</span>
          </button>
        </li>
      </ul>
    </UQueryState>
  </div>
</template>
