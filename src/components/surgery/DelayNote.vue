<script setup lang="ts">
// 急刀插台順延：每次的經過、主刀與病房的已讀、禁食太久提醒、超過開放時段（改期或同意加班）。
// 手術室的手術視窗、病房「手術」分頁都用這一塊；誰能讀、能不能同意加班由服務層判斷（surgery.ackDelay、acceptOvertime）
import { computed } from 'vue'
import { UButton } from '@/components/ui'
import { OR_DAY, surgeryApi, type SurgeryView } from '@/services'
import { useAction } from '@/composables/useService'
import { useAuth } from '@/stores/auth'

const props = defineProps<{ surgery: SurgeryView; canSchedule?: boolean }>()
const emit = defineEmits<{ reschedule: [] }>()
const s = computed(() => props.surgery)
const auth = useAuth()
// 醫師：自己主刀的才讀得了；護理師：病房
const canAck = computed(() => (auth.user?.role === 'doctor' ? s.value.delayUnread.surgeon && auth.user.doctorId === s.value.doctorId : auth.user?.role === 'nurse' && s.value.delayUnread.ward))
const ackAct = useAction(surgeryApi.ackDelay, { success: '已讀順延通知' })
const otAct = useAction(surgeryApi.acceptOvertime, { success: '已同意加班（照新時間做）' })
const pullAct = useAction(surgeryApi.pullBackSurgery, { success: (x) => `已拉回 ${x.scheduleText}` })
</script>

<template>
  <div v-if="s.delayRows.length" :class="['space-y-1 rounded-md border px-3 py-2 text-xs', s.delayOverflow ? 'border-red-300 bg-red-50' : 'border-amber-300 bg-amber-50/60']">
    <div class="flex flex-wrap items-center gap-2">
      <b :class="s.delayOverflow ? 'text-red-800' : 'text-amber-900'">{{ s.delayMinutes ? `被急刀順延 ${s.delayMinutes} 分` : '急刀順延後已拉回原時間' }}</b>
      <span class="text-slate-600">原排 {{ s.originalStart?.slice(5) }}，現排 {{ s.scheduleText }}</span>
      <UButton v-if="canAck" size="sm" class="ml-auto" :loading="ackAct.pending.value" @click="ackAct.run(s.id)">已讀</UButton>
    </div>
    <ul class="space-y-0.5">
      <li v-for="d in s.delayRows" :key="d.id" class="text-slate-700">
        {{ d.text }}
        <span :class="d.surgeonAck ? 'text-emerald-700' : 'text-amber-800'">・主刀{{ d.surgeonAck ? `已讀 ${d.surgeonAck}` : '未讀' }}</span>
        <span :class="d.wardAck ? 'text-emerald-700' : 'text-amber-800'">・病房{{ d.wardAck ? `已讀 ${d.wardAck}` : '未讀' }}</span>
      </li>
    </ul>
    <div v-if="s.pullBack" class="flex flex-wrap items-center gap-2 font-medium text-emerald-800">
      <span>{{ s.pullBack.why }}：可以拉回原時間 {{ s.pullBack.to.slice(5) }}</span>
      <UButton v-if="canSchedule" size="sm" class="ml-auto" :loading="pullAct.pending.value" @click="pullAct.run(s.id)">拉回</UButton>
    </div>
    <p v-if="s.npoLong" class="font-medium text-amber-900">病人已禁食，又多等 {{ s.delayMinutes }} 分：請評估是否補點滴（或請麻醉科調整禁食）。</p>
    <div v-if="s.delayOverflow" class="flex flex-wrap items-center gap-2 font-medium text-red-800">
      <span>推到 {{ OR_DAY.end }} 以後了：要改期，或同意加班照新時間做。</span>
      <template v-if="canSchedule">
        <UButton size="sm" variant="secondary" class="ml-auto" @click="emit('reschedule')">改期</UButton>
        <UButton size="sm" variant="danger" :loading="otAct.pending.value" @click="otAct.run(s.id)">同意加班</UButton>
      </template>
      <span v-else class="font-normal text-slate-600">（由有「手術排程」權限的人處理）</span>
    </div>
    <p v-else-if="s.overtimeText" class="text-slate-600">{{ s.overtimeText }}</p>
  </div>
</template>
