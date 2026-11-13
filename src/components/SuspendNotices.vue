<script setup lang="ts">
// 停診通知：因停診而退掛的病人，逐一電話通知後打勾。
// 「退掛」只是系統裡的狀態，病人不知道就還是會來——通知完成才算處理完。
import { useCan } from '@/composables/useCan'
import { Check, Phone } from 'lucide-vue-next'
import { UBadge, UButton, UQueryState } from '@/components/ui'
import { scheduleApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { periodLabel, weekdayLabel } from '@/utils/date'
import { useUi } from '@/stores/ui'
import { useAuth } from '@/stores/auth'
import type { NoticeRow } from '@/services/schedule'

const ui = useUi()
const can = useCan()
const { data: notices, loading } = useQuery(() => scheduleApi.listSuspendNotices())
const mark = useAction(scheduleApi.markNotified, { success: '已記錄通知' })
// 「已通知」不先確認（要連續按很多次），改成可以撤銷；撤銷較少用，所以先確認
const unmark = useAction(scheduleApi.unmarkNotified, { success: '已改回待通知' })
// 停診退掛的預收款：病人聯絡上或來院時退還（櫃台）
const auth = useAuth()
const refundPre = useAction(scheduleApi.refundSuspendedPrepay, { success: (r) => `已退還預收 ${r.amount} 元（退款單 ${r.receiptNo}）` })
const doRefund = async (n: NoticeRow) => {
  if (await ui.confirm({ title: '退還預收款', message: `退還 ${n.patientName} 預收款 ${n.prepayDue} 元（依預收時的付款方式），開退款單算在今天？`, okText: '退還' })) refundPre.run(n.visitId)
}
const undo = async (n: NoticeRow) => {
  if (await ui.confirm({ title: '撤銷通知紀錄', message: `把 ${n.patientName}（${n.date.slice(5)} #${n.seqNo}）改回待通知？\n撤銷會寫入稽核紀錄。`, okText: '改回待通知' })) unmark.run(n.visitId)
}
</script>

<template>
  <UQueryState :loading="loading && !notices" :ready="!!notices?.length" empty-title="沒有待通知的停診病人">
    <p class="mb-2 text-sm text-slate-600">
      待通知 <b class="tabular text-red-600">{{ notices!.filter((n) => !n.notifiedAt).length }}</b> 位・已通知 {{ notices!.filter((n) => n.notifiedAt).length }} 位
    </p>
    <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
      <li v-for="n in notices" :key="n.visitId" :class="['flex items-center gap-3 px-3 py-2 text-sm', n.notifiedAt && 'text-slate-400']">
        <span class="tabular w-28 text-xs">{{ n.date.slice(5) }}（{{ weekdayLabel(n.date) }}）{{ periodLabel[n.period] }}</span>
        <span class="w-16 text-xs">{{ n.doctorName }}</span>
        <span class="tabular w-10 text-xs">#{{ n.seqNo }}</span>
        <span class="w-20 font-medium" :class="!n.notifiedAt && 'text-slate-800'">{{ n.patientName }}</span>
        <span class="tabular flex items-center gap-1"><Phone class="h-3.5 w-3.5" />{{ n.phone }}</span>
        <UBadge tone="gray">{{ n.reason }}</UBadge>
        <span v-if="n.prepayDue" class="flex items-center gap-1 text-xs text-amber-800">
          待退預收 <b class="tabular">{{ n.prepayDue }}</b> 元
          <UButton v-if="auth.user?.role === 'clerk'" size="sm" variant="ghost" :loading="refundPre.pending.value" @click="doRefund(n)">退還</UButton>
        </span>
        <span class="ml-auto">
          <span v-if="n.notifiedAt" class="tabular flex items-center gap-2 text-xs">
            {{ n.notifiedAt.slice(5) }} {{ n.notifiedByName ?? '' }} 已通知
            <button type="button" class="text-brand-600 underline-offset-2 hover:underline disabled:opacity-50" :disabled="unmark.pending.value || !can('schedule.notice')" @click="undo(n)">撤銷</button>
          </span>
          <UButton v-else-if="can('schedule.notice')" size="sm" variant="secondary" :icon="Check" :loading="mark.pending.value" @click="mark.run(n.visitId)">已通知</UButton>
        </span>
      </li>
    </ul>
  </UQueryState>
</template>
