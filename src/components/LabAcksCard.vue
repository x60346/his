<script setup lang="ts">
// 待確認的檢驗報告（首頁，醫師）：危急值、或檢驗科更正過的報告，開立醫師（住院另含主治）要確認「已知悉」——
// 時間會記下來（醫院評鑑要求危急值通報要有醫師回覆的紀錄）。規則在服務層 lab.ackLab。
import { FlaskConical } from 'lucide-vue-next'
import { UBadge, UButton, UCard } from '@/components/ui'
import { LAB_FLAG_TEXT, labApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data: list } = useQuery(() => labApi.myLabAcks())
const ack = useAction(labApi.ackLab, { success: (r) => `已確認 ${r.patientName} 的${r.procName}` })
</script>

<template>
  <UCard v-if="list?.length" :padded="false" class="border-red-300">
    <template #title>
      <div class="flex items-center gap-2 text-sm font-semibold text-slate-800"><FlaskConical class="h-4 w-4 text-red-600" />待確認的檢驗報告<UBadge tone="red">{{ list.length }}</UBadge></div>
      <div class="text-xs text-slate-500">危急值或檢驗科更正過的報告：看過、處理後按「已知悉」（會記錄時間）</div>
    </template>
    <ul class="divide-y divide-slate-100">
      <li v-for="r in list" :key="r.id" class="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
        <span class="min-w-0 flex-1">
          <span class="font-medium text-slate-800">{{ r.patientName }}</span> <span class="tabular text-xs text-slate-500">{{ r.chartNo }}・{{ r.source === 'ipd' ? '住院' : '門診' }}</span>
          <UBadge v-if="r.hasCritical" tone="red" class="ml-1">危急值</UBadge>
          <UBadge v-if="r.corrections?.length" tone="yellow" class="ml-1">已更正</UBadge>
          <span class="block text-xs text-slate-600">
            {{ r.procName }}：
            <template v-for="(v, i) in r.values.filter((x) => x.flag || x.critical)" :key="v.code">
              <template v-if="i">、</template><span :class="v.critical ? 'font-bold text-red-700' : 'text-amber-800'">{{ v.name }} {{ v.value }}{{ v.unit ? ` ${v.unit}` : '' }} {{ LAB_FLAG_TEXT[v.flag] }}</span>
            </template>
            <template v-if="!r.values.some((x) => x.flag || x.critical)">全部在參考範圍內</template>
            ・{{ r.reportedAt.slice(5, 16).replace('-', '/') }} 發出
          </span>
          <span v-if="r.corrections?.length" class="block text-xs text-amber-800">更正原因：{{ r.corrections.at(-1)!.reason }}</span>
        </span>
        <UButton size="sm" variant="danger" :loading="ack.pending.value" @click="ack.run(r.id)">已知悉</UButton>
      </li>
    </ul>
  </UCard>
</template>
