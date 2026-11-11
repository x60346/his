<script setup lang="ts">
// 出院病摘（唯讀）：住院中心辦理出院時核對、病患資料頁查閱都用這一份。撰寫在醫師的住院醫囑頁。
import type { DischargeSummary } from '@/types'

defineProps<{ summary: DischargeSummary; doctorName?: string }>()
</script>

<template>
  <div class="space-y-2 text-sm">
    <dl class="grid gap-1.5">
      <div v-for="[k, v] in [['出院診斷', summary.diagnosis], ['出院轉歸', summary.dischargeType], ['住院經過', summary.course], ['出院時狀況', summary.condition], ['出院後追蹤', summary.followUp]]" :key="k" class="flex gap-3">
        <dt class="w-20 shrink-0 text-slate-500">{{ k }}</dt>
        <dd class="whitespace-pre-line text-slate-800">{{ v || '—' }}</dd>
      </div>
    </dl>
    <p class="tabular text-right text-xs text-slate-500">
      {{ doctorName }}・{{ summary.signedAt ? `${summary.signedAt} 簽署` : `${summary.writtenAt} 草稿（未簽署）` }}
    </p>
  </div>
</template>
