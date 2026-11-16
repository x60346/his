<script setup lang="ts">
// 出院帶藥（住院藥局）：醫師簽准出院時開的帶回家的藥。待調劑的在前：核對處方（過敏、庫存）→「調劑完成」扣帳、印藥袋；
// 調好之後醫師要改：按「退回」（藥回到原批號、寫原因），醫師才能取消准予出院。今天出院的仍列出，可重印藥袋。
// 規則在服務層 discharge-rx.ts；調好才能住院結帳（ipd-charge）。
import { computed, ref } from 'vue'
import { AlertTriangle, CheckCheck, Printer, Undo2 } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UDialog } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import DrugBagLabels from '@/pages/pharmacy/components/DrugBagLabels.vue'
import { dischargeRxApi, type DischargeRxView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data: list } = useQuery(() => dischargeRxApi.listDischargeRx())
const give = useAction(dischargeRxApi.dispenseDischargeRx, { success: (r) => `已調劑 ${r.patientName} 的出院帶藥；請印藥袋，櫃台可以結帳了` })
const back = useAction(dischargeRxApi.returnDischargeRx, { success: (r) => `已退回 ${r.patientName} 的出院帶藥（藥回到原批號）` })
const returning = ref<DischargeRxView | null>(null)
async function onReturn(reason: string) {
  if (returning.value && (await back.run(returning.value.admissionId, reason))) returning.value = null
}
// 藥袋：看最新那份（調劑後重新查詢，藥師名字與日期才對）
const bagId = ref<string>()
const bag = computed(() => list.value?.find((x) => x.admissionId === bagId.value))
async function onDispense(r: DischargeRxView) {
  if (await give.run(r.admissionId)) bagId.value = r.admissionId
}
const print = () => window.print()
</script>

<template>
  <UCard v-if="list?.length" :padded="false">
    <template #title>
      <div class="flex items-center gap-2 text-sm font-semibold text-slate-800">出院帶藥<UBadge v-if="list.some((x) => x.status === 'pending')" tone="yellow">待調劑 {{ list.filter((x) => x.status === 'pending').length }}</UBadge></div>
      <div class="text-xs text-slate-500">醫師簽准出院時開的帶回家的藥：調好（扣帳）後櫃台才能住院結帳</div>
    </template>
    <ul class="divide-y divide-slate-100">
      <li v-for="r in list" :key="r.admissionId" class="space-y-2 px-4 py-3 text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-medium text-slate-800">{{ r.bedNo }} {{ r.patientName }}</span>
          <span class="tabular text-xs text-slate-500">{{ r.chartNo }}・{{ r.deptName }}・{{ r.doctorName }}</span>
          <UBadge v-if="r.chronicRx" tone="purple">慢性病</UBadge>
          <UBadge v-if="r.discharged" tone="gray">已出院</UBadge>
          <UBadge v-else :tone="r.status === 'pending' ? 'yellow' : 'green'">{{ r.status === 'pending' ? '待調劑' : `已調劑・${r.pharmacistName} ${r.dispensedAt?.slice(11, 16)}` }}</UBadge>
          <span class="ml-auto flex gap-2">
            <UButton v-if="r.status === 'pending'" size="sm" :icon="CheckCheck" :disabled="r.items.some((i) => i.shortage)" :loading="give.pending.value" @click="onDispense(r)">調劑完成</UButton>
            <template v-else>
              <UButton size="sm" variant="secondary" :icon="Printer" @click="bagId = r.admissionId">藥袋</UButton>
              <UButton v-if="!r.discharged" size="sm" variant="ghost" :icon="Undo2" @click="returning = r">退回</UButton>
            </template>
          </span>
        </div>
        <div v-if="r.allergyWarnings.length" class="flex items-start gap-1.5 rounded bg-red-50 px-2 py-1 text-xs text-red-800"><AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />過敏警示：{{ r.allergyWarnings.map((w) => `${w.drugName}（病人對 ${w.allergen} 過敏）`).join('、') }}</div>
        <table class="tabular w-full text-sm">
          <tbody>
            <tr v-for="i in r.items" :key="i.drugId" :class="['border-t border-slate-100', i.shortage && 'bg-red-50']">
              <td class="py-1 pr-2"><div class="font-medium text-slate-800">{{ i.drugName }}<UBadge v-if="i.highAlert" tone="purple" class="ml-1">高警訊</UBadge></div><div class="text-xs text-slate-500">{{ i.drugNameZh }}・{{ i.spec }}</div></td>
              <td class="px-2 text-slate-700">每次 {{ i.dose }} {{ i.doseUnit }}・{{ i.freq }}・{{ i.route }}<div v-if="i.timingText" class="text-xs text-slate-500">{{ i.timingText }}</div></td>
              <td class="whitespace-nowrap px-2 text-right">{{ i.days }} 天</td>
              <td class="whitespace-nowrap px-2 text-right font-semibold">{{ i.qty }} {{ i.unit }}</td>
              <td v-if="r.status === 'pending'" :class="['whitespace-nowrap pl-2 text-right text-xs', i.shortage ? 'font-semibold text-red-600' : 'text-slate-500']">庫存 {{ i.stock }}<div v-if="i.shortage">不足</div></td>
            </tr>
          </tbody>
        </table>
      </li>
    </ul>

    <ReasonDialog
      :model-value="!!returning"
      title="退回出院帶藥"
      :subject="returning ? `${returning.bedNo} ${returning.patientName}` : ''"
      label="退回原因"
      :presets="['醫師要改處方', '病人不帶藥', '病人延後出院']"
      ok-text="退回"
      danger
      :pending="back.pending.value"
      :error="back.fieldErrors.value.reason"
      @update:model-value="(v: boolean) => !v && (returning = null)"
      @confirm="onReturn"
    />
    <UDialog :model-value="!!bag" title="出院帶藥藥袋" size="lg" @update:model-value="(v: boolean) => !v && (bagId = undefined)">
      <DrugBagLabels v-if="bag" :d="bag" pharmacy="住院藥局" />
      <template #footer>
        <UButton variant="secondary" @click="bagId = undefined">關閉</UButton>
        <UButton :icon="Printer" @click="print">列印</UButton>
      </template>
    </UDialog>
  </UCard>
</template>
