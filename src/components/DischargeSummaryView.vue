<script setup lang="ts">
// 出院病摘（唯讀）：住院中心辦理出院時核對、病患資料頁查閱都用這一份。撰寫在醫師的住院醫囑頁。
import type { DischargeSummary } from '@/types'

defineProps<{ summary: DischargeSummary; doctorName?: string; medTexts?: string[]; rxStatus?: 'pending' | 'dispensed' }>()
</script>

<template>
  <div class="space-y-2 text-sm">
    <dl class="grid gap-1.5">
      <div v-for="[k, v] in [['出院診斷', summary.diagnosis], ['出院轉歸', summary.dischargeType], ['住院經過', summary.course], ['出院時狀況', summary.condition], ['出院後追蹤', summary.followUp]]" :key="k" class="flex gap-3">
        <dt class="w-20 shrink-0 text-slate-500">{{ k }}</dt>
        <dd class="whitespace-pre-line text-slate-800">{{ v || '—' }}</dd>
      </div>
    </dl>
    <div v-if="medTexts?.length" class="flex gap-3">
      <div class="w-20 shrink-0 text-slate-500">出院帶藥</div>
      <div class="min-w-0 flex-1">
        <ul class="list-disc pl-4 text-slate-800">
          <li v-for="m in medTexts" :key="m" class="break-keep break-words">{{ m }}</li>
        </ul>
        <div class="mt-0.5 text-xs text-slate-500">
          <template v-if="summary.chronicRx">慢性病（最多 30 天）・</template>
          <span v-if="rxStatus === 'dispensed'" class="text-emerald-700">住院藥局已調劑</span>
          <span v-else-if="rxStatus === 'pending' && summary.signedAt" class="text-amber-700">待住院藥局調劑</span>
        </div>
      </div>
    </div>
    <p class="tabular text-right text-xs text-slate-500">
      {{ doctorName }}・{{ summary.signedAt ? `${summary.signedAt} 簽署` : `${summary.writtenAt} 草稿（未簽署）` }}
    </p>
  </div>
</template>
