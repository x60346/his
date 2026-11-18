<script setup lang="ts">
// 檢驗科「待收件」（住院檢體）：掃條碼（或在清單上按）收件，收件後那幾項才能登打；檢體有問題退件（寫原因），醫囑回到待採檢、
// 護理站提醒重新採檢。採檢後超過 60 分鐘還沒收件標紅。規則在服務層 specimen.ts
import { computed, ref } from 'vue'
import { PackageCheck, ScanLine } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UInput } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { SPECIMEN_REJECT_REASONS, specimenApi, TUBE_COLOR, type SpecimenView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data } = useQuery(() => specimenApi.labSpecimens())
const code = ref('')
const receive = useAction(specimenApi.receiveSpecimen, { success: (s) => `已收件 ${s.barcode}（${s.patientName}：${s.tests.join('、')}）` })
async function onScan() {
  if (code.value.trim() && (await receive.run(code.value.trim()))) code.value = ''
}
const rejecting = ref<SpecimenView>()
const rejectOpen = computed({ get: () => !!rejecting.value, set: (x) => !x && (rejecting.value = undefined) })
const reject = useAction(specimenApi.rejectSpecimen, { success: '已退件，護理站會看到「重新採檢」' })
async function confirmReject(reason: string) {
  if (rejecting.value && (await reject.run(rejecting.value.barcode, reason))) rejecting.value = undefined
}
</script>

<template>
  <UCard :padded="false">
    <template #title><span class="flex items-center gap-2 text-sm font-semibold text-slate-800"><PackageCheck class="h-4 w-4" />住院檢體待收件 <UBadge v-if="data?.toReceive.length" tone="blue">{{ data.toReceive.length }}</UBadge></span></template>
    <div class="space-y-2 p-3">
      <form class="flex items-end gap-2" @submit.prevent="onScan">
        <UInput v-model="code" class="flex-1" label="掃檢體條碼收件" placeholder="S2026…" :error="receive.fieldErrors.value.barcode" />
        <UButton type="submit" :icon="ScanLine" :loading="receive.pending.value">收件</UButton>
      </form>
      <p v-if="!data?.toReceive.length" class="text-xs text-slate-400">沒有待收件的檢體</p>
      <ul v-else class="divide-y divide-slate-100 rounded border border-slate-200 text-sm">
        <li v-for="s in data.toReceive" :key="s.id" class="flex flex-wrap items-center gap-2 px-2 py-1.5">
          <span :class="['h-3 w-3 rounded-full', TUBE_COLOR[s.tube]]" :title="s.tubeLabel" />
          <span class="tabular text-xs">{{ s.barcode }}</span>
          <span class="font-medium">{{ s.bedNo }} {{ s.patientName }}</span>
          <span class="min-w-0 flex-1 text-xs text-slate-600">{{ s.tests.join('、') }}</span>
          <span :class="['tabular text-xs', s.late ? 'font-semibold text-red-700' : 'text-slate-500']">採檢 {{ s.collectedAt?.slice(11) }}{{ s.late ? '・逾時' : '' }}</span>
          <UButton size="sm" variant="ghost" @click="rejecting = s">退件</UButton>
          <UButton size="sm" :loading="receive.pending.value" @click="receive.run(s.barcode)">收件</UButton>
        </li>
      </ul>
      <p v-if="data?.rejected.length" class="text-xs text-slate-500">最近退件：{{ data.rejected.map((s) => `${s.barcode} ${s.patientName}（${s.rejected?.reason}）`).join('；') }}</p>
    </div>
  </UCard>
  <ReasonDialog v-model="rejectOpen" title="檢體退件" :subject="rejecting ? `${rejecting.barcode} ${rejecting.patientName}：${rejecting.tests.join('、')}` : ''" label="退件原因（護理站會看到）" :presets="SPECIMEN_REJECT_REASONS" ok-text="退件" danger :pending="reject.pending.value" :error="reject.fieldErrors.value.reason" @confirm="confirmReject" />
</template>
