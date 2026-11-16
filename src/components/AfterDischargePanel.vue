<script setup lang="ts">
// 出院後回診（這次住院約好的門診）：醫師的出院病摘頁可以預約、取消（editable）；住院中心辦出院、護理站只看，可印預約單交給病人。
// 沒有約、又不能約的地方整塊不顯示
import { ref } from 'vue'
import { CalendarPlus, Printer } from 'lucide-vue-next'
import { UBadge, UButton } from '@/components/ui'
import AfterDischargeDialog from './AfterDischargeDialog.vue'
import RegistrationSlip from './RegistrationSlip.vue'
import { bookingApi, type VisitView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import { periodLabel, weekdayLabel } from '@/utils/date'

const props = defineProps<{ admissionId: string; editable?: boolean }>()
const { data: list } = useQuery(() => bookingApi.listAfterDischarge(props.admissionId), [() => props.admissionId])
const dlg = ref(false)
const slip = ref<VisitView>()
const slipOpen = ref(false)
const showSlip = (v: VisitView) => {
  slip.value = v
  slipOpen.value = true
}
const ui = useUi()
const cancel = useAction(bookingApi.cancelAfterDischarge, { success: '已取消出院後回診' })
async function onCancel(v: VisitView) {
  if (await ui.confirm({ title: '取消出院後回診', message: `取消 ${md(v.date)} ${periodLabel[v.period]} ${v.doctorName} 第 ${v.seqNo} 號？`, okText: '取消預約' })) cancel.run(v.id)
}
const md = (d: string) => `${d.slice(5).replace('-', '/')}（${weekdayLabel(d)}）`
</script>

<template>
  <section v-if="editable || list?.length" class="rounded-md border border-slate-200 px-3 py-2 text-sm">
    <div class="flex flex-wrap items-center gap-2">
      <h4 class="font-semibold text-slate-700">出院後回診</h4>
      <span v-if="!list?.length" class="text-xs text-slate-500">還沒約（出院後 30 天內第一次回診，部分負擔比照經轉診）</span>
      <UButton v-if="editable" size="sm" variant="secondary" class="ml-auto" :icon="CalendarPlus" @click="dlg = true">預約回診</UButton>
    </div>
    <ul v-if="list?.length" class="mt-1 divide-y divide-slate-100">
      <li v-for="v in list" :key="v.id" class="flex flex-wrap items-center gap-x-3 py-1">
        <span class="tabular">{{ md(v.date) }} {{ periodLabel[v.period] }}</span>
        <span>{{ v.deptName }} {{ v.doctorName }}・{{ v.roomNo }} 診 <b class="tabular">#{{ v.seqNo }}</b></span>
        <UBadge v-if="v.copayReferred === '出院後回診'" tone="cyan" title="出院後 30 天內第一次回診">比照經轉診</UBadge>
        <UBadge v-if="v.status !== 'registered'" tone="green">已看診</UBadge>
        <span class="ml-auto flex gap-1">
          <UButton size="sm" variant="ghost" :icon="Printer" @click="showSlip(v)">預約單</UButton>
          <UButton v-if="editable && v.status === 'registered'" size="sm" variant="ghost" :loading="cancel.pending.value" @click="onCancel(v)">取消</UButton>
        </span>
      </li>
    </ul>
    <AfterDischargeDialog v-if="editable" v-model="dlg" :admission-id="admissionId" @booked="showSlip" />
    <RegistrationSlip v-model="slipOpen" :visit="slip" />
  </section>
</template>
