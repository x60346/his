<script setup lang="ts">
// 待核准優免（首頁，有「可核准優免」權限的人）：櫃台送簽的優免，主管在這裡直接核准或退回（退回寫原因）——不必走到櫃台。
// 規則（不能核准自己送簽的、當天有效、病人已批價就不必處理）在服務層 charge.decideDiscountRequest。
import { ref } from 'vue'
import { BadgePercent } from 'lucide-vue-next'
import { UBadge, UButton, UCard } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { chargeApi } from '@/services'
import type { DiscountRequestView } from '@/services/charge'
import { useAction, useQuery } from '@/composables/useService'

const { data: list } = useQuery(() => chargeApi.listDiscountRequests())
const decide = useAction(chargeApi.decideDiscountRequest, { success: (r) => (r.status === 'approved' ? `已核准 ${r.patientName} 的${r.ruleName}` : `已退回 ${r.patientName} 的${r.ruleName}`) })
const rejecting = ref<DiscountRequestView | null>(null)
async function onReject(reason: string) {
  if (rejecting.value && (await decide.run(rejecting.value.id, { approve: false, reason }))) rejecting.value = null
}
</script>

<template>
  <UCard v-if="list?.length" :padded="false" class="border-amber-300">
    <template #title>
      <div class="flex items-center gap-2 text-sm font-semibold text-slate-800"><BadgePercent class="h-4 w-4 text-amber-600" />待核准優免<UBadge tone="yellow">{{ list.length }}</UBadge></div>
      <div class="text-xs text-slate-500">櫃台送簽的優免：核准後櫃台就能結帳（當天有效）</div>
    </template>
    <ul class="divide-y divide-slate-100">
      <li v-for="r in list" :key="r.id" class="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
        <span class="min-w-0 flex-1">
          <span class="font-medium text-slate-800">{{ r.patientName }}</span> <span class="tabular text-xs text-slate-500">{{ r.chartNo }}</span>
          <span class="block text-xs text-slate-600">{{ r.ruleName }} <b class="tabular">−{{ r.amount }} 元</b><template v-if="r.reason">・{{ r.reason }}</template>・櫃台 {{ r.cashierName }} {{ r.requestedAt.slice(11, 16) }} 送簽</span>
        </span>
        <UButton size="sm" variant="ghost" @click="rejecting = r">退回</UButton>
        <UButton size="sm" :loading="decide.pending.value" @click="decide.run(r.id, { approve: true })">核准</UButton>
      </li>
    </ul>
    <ReasonDialog
      :model-value="!!rejecting"
      title="退回優免送簽"
      :subject="rejecting ? `${rejecting.patientName}・${rejecting.ruleName} −${rejecting.amount} 元` : ''"
      label="退回原因"
      :presets="['不符合專案資格', '請改用其他優免類別', '請補充說明']"
      ok-text="退回"
      danger
      :pending="decide.pending.value"
      :error="decide.fieldErrors.value.reason"
      @update:model-value="(v: boolean) => !v && (rejecting = null)"
      @confirm="onReject"
    />
  </UCard>
</template>
