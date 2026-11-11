<script setup lang="ts">
// 護理站「醫囑」：這位病人目前有效的醫囑（唯讀），依類別分組，飲食在最前面。
// 24 小時內新開的標「新」，24 小時內停止或完成的仍列出（劃掉）——接班的人要知道上一班之後改了什麼。
// 判斷「新／已停」在服務層（nursing-rules.orderChange），頁面只負責呈現。
import { computed } from 'vue'
import { UBadge, UQueryState } from '@/components/ui'
import { nursingApi, type AdmissionView } from '@/services'
import { useQuery } from '@/composables/useService'

const props = defineProps<{ admission: AdmissionView }>()
const { data, loading } = useQuery(
  async () => ({ id: props.admission.id, groups: await nursingApi.listNursingOrders(props.admission.id) }),
  [() => props.admission.id],
)
// 切換病人時，舊病人的醫囑在新資料回來前不顯示
const groups = computed(() => (data.value?.id === props.admission.id ? data.value.groups : undefined))
const md = (s?: string) => (s ? `${s.slice(5, 10).replace('-', '/')} ${s.slice(11)}` : '')
</script>

<template>
  <div class="space-y-4 p-4">
    <UQueryState :loading="loading && !groups" :ready="!!groups?.length" empty-title="目前沒有醫囑">
      <section v-for="g in groups" :key="g.category" class="mb-4 last:mb-0">
        <h3 class="mb-2 text-sm font-semibold text-slate-700">{{ g.label }}</h3>
        <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
          <li v-for="o in g.orders" :key="o.id" :class="['flex items-start gap-3 px-3 py-2 text-sm', o.status !== 'active' && 'bg-slate-50 text-slate-400']">
            <div class="min-w-0 flex-1">
              <div :class="['font-medium', o.status === 'active' ? 'text-slate-800' : 'line-through']">
                {{ o.content }}
                <template v-if="o.dose">・{{ o.dose }} {{ o.unit }}</template>
                <template v-if="o.freq">・{{ o.freqLabel }}</template>
                <template v-if="o.route">・{{ o.route }}</template>
              </div>
              <div class="text-xs text-slate-500">
                {{ o.type === 'stat' ? '臨時' : '長期' }}・{{ md(o.startAt) }} {{ o.doctorName }} 開立
                <template v-if="o.stopAt">・{{ md(o.stopAt) }} {{ o.status === 'done' ? '完成' : '停止' }}</template>
              </div>
            </div>
            <UBadge v-if="o.change === 'new'" tone="blue">新</UBadge>
            <UBadge v-else-if="o.change === 'stopped'" tone="gray">已停</UBadge>
            <UBadge v-else-if="o.change === 'done'" tone="green">已完成</UBadge>
            <UBadge v-if="o.highAlert" tone="purple">高警訊</UBadge>
          </li>
        </ul>
      </section>
    </UQueryState>
  </div>
</template>
