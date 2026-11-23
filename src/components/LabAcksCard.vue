<script setup lang="ts">
// 待確認的報告（首頁，醫師）：檢驗危急值或更正過的、影像重要發現或補充過的，開立醫師（住院另含主治）要確認「已知悉」——
// 時間會記下來（醫院評鑑要求危急值、重大發現通報要有醫師回覆的紀錄）。規則在服務層 lab.ackLab、imaging.ackImaging。
import { computed } from 'vue'
import { FlaskConical } from 'lucide-vue-next'
import { UBadge, UButton, UCard } from '@/components/ui'
import { imagingApi, LAB_FLAG_TEXT, labApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data: list } = useQuery(() => labApi.myLabAcks())
const ack = useAction(labApi.ackLab, { success: (r) => `已確認 ${r.patientName} 的${r.procName}` })
// 影像：重要發現或補充過的（同一張卡片，醫師一次處理完）
const { data: imgs } = useQuery(() => imagingApi.myImagingAcks())
const ackImg = useAction(imagingApi.ackImaging, { success: (r) => `已確認 ${r.patientName} 的${r.procName}` })
const total = computed(() => (list.value?.length ?? 0) + (imgs.value?.length ?? 0))
</script>

<template>
  <UCard v-if="total" :padded="false" class="border-red-300">
    <template #title>
      <div class="flex items-center gap-2 text-sm font-semibold text-slate-800"><FlaskConical class="h-4 w-4 text-red-600" />待確認的報告<UBadge tone="red">{{ total }}</UBadge></div>
      <div class="text-xs text-slate-500">檢驗危急值、影像重要發現，或更正、補充過的報告：看過、處理後按「已知悉」（會記錄時間）</div>
    </template>
    <ul class="divide-y divide-slate-100">
      <li v-for="r in list ?? []" :key="r.id" class="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
        <span class="min-w-0 flex-[1_1_10rem]">
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
      <li v-for="r in imgs ?? []" :key="r.id" class="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
        <span class="min-w-0 flex-[1_1_10rem]">
          <span class="font-medium text-slate-800">{{ r.patientName }}</span> <span class="tabular text-xs text-slate-500">{{ r.chartNo }}・{{ r.source === 'ipd' ? '住院' : '門診' }}</span>
          <UBadge v-if="r.significant" tone="red" class="ml-1">重要發現</UBadge>
          <UBadge v-if="r.addenda?.length" tone="yellow" class="ml-1">已補充</UBadge>
          <span class="block text-xs text-slate-600">{{ r.procName }}：<span :class="r.significant ? 'font-bold text-red-700' : ''">{{ r.impression }}</span>・{{ r.reportedAt.slice(5, 16).replace('-', '/') }} {{ r.readerName }} 判讀</span>
          <span v-if="r.addenda?.length" class="block text-xs text-amber-800">補充：{{ r.addenda.at(-1)!.text }}</span>
        </span>
        <UButton size="sm" variant="danger" :loading="ackImg.pending.value" @click="ackImg.run(r.id)">已知悉</UButton>
      </li>
    </ul>
  </UCard>
</template>
