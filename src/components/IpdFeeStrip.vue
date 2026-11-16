<script setup lang="ts">
// 住院費用（護理站）：到今天為止的自付累計、期中已繳、還要繳多少；可列印費用明細給家屬。只看不收款（收款在櫃台）
import { ref } from 'vue'
import { Printer, Receipt } from 'lucide-vue-next'
import { UButton, UDialog } from '@/components/ui'
import { ipdChargeApi } from '@/services'
import { useQuery } from '@/composables/useService'
import { money } from '@/utils/labels'
import IpdStatementPrint from './IpdStatementPrint.vue'

const props = defineProps<{ admissionId: string }>()
const { data } = useQuery(() => ipdChargeApi.getIpdStatement(props.admissionId), [() => props.admissionId])
const open = ref(false)
const print = () => window.print()
</script>

<template>
  <div v-if="data && data.admission.id === admissionId" class="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm">
    <span class="flex items-center gap-1.5 font-medium text-slate-700"><Receipt class="h-4 w-4" />住院費用（截至今天）</span>
    <span class="tabular text-slate-600">自付累計 <b class="text-slate-800">{{ money(data.bill.patientTotal) }}</b></span>
    <span v-if="data.interimPaid" class="tabular text-slate-600">期中已繳 {{ money(data.interimPaid) }}</span>
    <span v-if="data.receiptNo" class="text-emerald-700">已出院結帳（{{ data.receiptNo }}）</span>
    <span v-else class="tabular text-slate-600">{{ data.stillDue >= 0 ? '還要繳' : '多繳' }} <b :class="data.stillDue > 0 ? 'text-amber-700' : 'text-slate-800'">{{ money(Math.abs(data.stillDue)) }}</b></span>
    <span class="text-xs text-slate-400">繳費請到櫃台</span>
    <UButton class="ml-auto" size="sm" variant="secondary" :icon="Printer" @click="open = true">費用明細</UButton>
    <UDialog v-model="open" title="住院費用明細表" size="lg">
      <IpdStatementPrint :s="data" />
      <template #footer>
        <UButton variant="secondary" @click="open = false">關閉</UButton>
        <UButton :icon="Printer" @click="print">列印</UButton>
      </template>
    </UDialog>
  </div>
</template>
