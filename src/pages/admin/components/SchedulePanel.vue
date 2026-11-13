<script setup lang="ts">
// 排班：每週門診表（長期）、單日調整（例外）、停診通知（後續處理）。
import { ref } from 'vue'
import { UTabs } from '@/components/ui'
import WeeklyGrid from './WeeklyGrid.vue'
import DailyAdjust from '@/components/DailyAdjust.vue'
import RoomsPanel from './RoomsPanel.vue'
import SuspendNotices from '@/components/SuspendNotices.vue'
import { scheduleApi } from '@/services'
import { useQuery } from '@/composables/useService'

const tab = ref('weekly')
const { data: notices } = useQuery(() => scheduleApi.listSuspendNotices())
</script>

<template>
  <div class="space-y-4">
    <UTabs
      v-model="tab"
      :tabs="[
        { key: 'weekly', label: '每週門診表' },
        { key: 'daily', label: '單日調整（停診・代診）' },
        { key: 'notices', label: '停診通知', count: notices?.filter((n) => !n.notifiedAt).length || undefined },
        { key: 'rooms', label: '診間' },
      ]"
    />
    <WeeklyGrid v-if="tab === 'weekly'" />
    <DailyAdjust v-else-if="tab === 'daily'" />
    <RoomsPanel v-else-if="tab === 'rooms'" />
    <SuspendNotices v-else />
  </div>
</template>
