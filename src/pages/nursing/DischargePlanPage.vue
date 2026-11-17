<script setup lang="ts">
// 出院準備（權限「出院準備」：個管師）：全院的工作清單——出院後待電話追蹤、待篩選（快到期、逾時）、收案待評估、待轉介或待回覆；
// 逾時、准出院卻還沒轉介的排最前面。點一列在右邊做（和護理站「出院準備」分頁同一個元件）
import { computed, ref } from 'vue'
import { UBadge, UCard, UPageHeader, UQueryState } from '@/components/ui'
import DischargePlanPanel from '@/components/DischargePlanPanel.vue'
import { dischargePlanApi, type PlanWorkItem } from '@/services'
import { useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => dischargePlanApi.listPlanWork())
const picked = ref<string>()
const stageLabel: Record<PlanWorkItem['stage'], { text: string; tone: 'red' | 'yellow' | 'cyan' | 'purple' | 'blue' }> = {
  follow: { text: '出院追蹤', tone: 'blue' }, screen: { text: '待篩選', tone: 'cyan' }, needs: { text: '待評估', tone: 'purple' }, refer: { text: '轉介', tone: 'yellow' },
}
const sel = computed(() => data.value?.find((x) => x.admissionId === picked.value))
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="出院準備" description="篩選、需求評估、長照與居家轉介、出院後電話追蹤" />
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-[24rem_1fr]">
      <UCard :padded="false" class="self-start">
        <UQueryState :loading="loading && !data" :ready="!!data?.length" empty-title="目前沒有要處理的出院準備">
          <ul class="max-h-[calc(100vh-12rem)] divide-y divide-slate-100 overflow-y-auto text-sm">
            <li v-for="i in data" :key="`${i.stage}-${i.admissionId}`">
              <button :class="['w-full px-3 py-2 text-left hover:bg-slate-50', i.admissionId === picked && '!bg-brand-50']" @click="picked = i.admissionId">
                <div class="flex flex-wrap items-center gap-1.5">
                  <UBadge :tone="i.overdue ? 'red' : stageLabel[i.stage].tone">{{ stageLabel[i.stage].text }}{{ i.overdue ? '・逾時' : '' }}</UBadge>
                  <b class="text-slate-800">{{ i.patientName }}</b><span class="text-xs text-slate-500">{{ i.age }} 歲{{ i.stage === 'follow' ? '・已出院' : `・${i.ward} ${i.bedNo}` }}</span>
                  <UBadge v-if="i.dischargeReady" tone="green">准出院</UBadge>
                </div>
                <div class="text-xs text-slate-600">{{ i.text }}</div>
              </button>
            </li>
          </ul>
        </UQueryState>
      </UCard>
      <UCard v-if="sel" :title="`${sel.patientName}（${sel.chartNo}）`" :subtitle="sel.diagnosis" :padded="false">
        <DischargePlanPanel :admission-id="sel.admissionId" />
      </UCard>
      <p v-else class="self-start rounded-md border border-slate-200 bg-white px-3 py-6 text-center text-sm text-slate-400">從左邊選一位病人</p>
    </div>
  </div>
</template>
