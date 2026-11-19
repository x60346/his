<script setup lang="ts">
// 一台手術的病理：送出、收件（少了的）、報告（惡性、和術前診斷不符標紅）、主刀確認。
// 誰能確認、要不要確認由服務層判斷（pathology.pathOf、ackPath）
import { ref } from 'vue'
import { UBadge, UButton, UInput, UQueryState } from '@/components/ui'
import { PATH_STAGE_LABEL, pathologyApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ surgeryId: string }>()
const { data: p, loading } = useQuery(() => pathologyApi.pathOf(props.surgeryId), [() => props.surgeryId])
const note = ref('')
const ack = useAction(pathologyApi.ackPath, { success: '已確認病理報告' })
const TONE = { sent: 'yellow', received: 'blue', reported: 'purple', acked: 'green' } as const
</script>

<template>
  <UQueryState :loading="loading && p === undefined" :ready="p !== undefined">
    <section v-if="p" class="space-y-1 rounded-md border p-3 text-sm" :class="p.critical && p.stage === 'reported' ? 'border-red-300 bg-red-50/40' : 'border-slate-200'">
      <div class="flex flex-wrap items-center gap-2">
        <h4 class="font-semibold text-slate-700">病理</h4>
        <UBadge :tone="TONE[p.stage]">{{ PATH_STAGE_LABEL[p.stage] }}</UBadge>
        <span class="tabular text-xs" :class="p.overdue ? 'font-semibold text-red-700' : 'text-slate-500'">{{ p.sentAt.slice(5) }} 送出{{ p.overdue ? '・超過 4 小時還沒收件' : '' }}</span>
      </div>
      <p class="text-xs text-slate-600">{{ p.specimens.map((x) => x.text).join('；') }}</p>
      <p v-for="x in p.specimens.filter((y) => y.frozenText)" :key="x.id" class="text-xs text-slate-600">{{ x.label }} 冰凍：{{ x.frozenText }}</p>
      <p v-if="p.receivedText" class="text-xs" :class="p.missing.length ? 'font-semibold text-red-700' : 'text-slate-600'">{{ p.receivedText }}</p>
      <div v-if="p.report" class="rounded bg-white px-2 py-1">
        <div :class="p.critical ? 'font-semibold text-red-700' : 'text-slate-800'">{{ p.report.diagnosis }}</div>
        <div class="text-xs text-slate-600">{{ p.report.malignant ? '惡性' : '良性' }}・{{ p.report.consistent ? '和術前診斷相符' : '和術前診斷不符' }}<template v-if="p.report.note">・{{ p.report.note }}</template>・{{ p.report.byName }} {{ p.report.at.slice(5) }}</div>
        <div v-if="p.report.frozenConcordant !== undefined" class="text-xs" :class="p.report.frozenConcordant ? 'text-slate-600' : 'font-medium text-amber-800'">{{ p.report.frozenConcordant ? '和冰凍切片結果一致' : `和冰凍切片結果不一致：${p.report.frozenNote}` }}</div>
      </div>
      <p v-if="p.ackText" class="text-xs text-emerald-700">{{ p.ackText }}</p>
      <div v-if="p.canAck" class="flex flex-wrap items-end gap-2">
        <p v-if="p.critical" class="text-xs font-medium text-red-700">惡性或和術前診斷不符：主刀要確認看過（並安排後續）。</p>
        <div class="min-w-[14rem] flex-1"><UInput v-model="note" label="後續處理（選填，例：已向病人說明、轉腫瘤科）" /></div>
        <UButton size="sm" :variant="p.critical ? 'danger' : 'secondary'" :loading="ack.pending.value" @click="ack.run(surgeryId, { note })">{{ p.critical ? '確認看過' : '已讀' }}</UButton>
      </div>
    </section>
  </UQueryState>
</template>
