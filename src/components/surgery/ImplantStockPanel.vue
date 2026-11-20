<script setup lang="ts">
// 手術室「植入物」分頁（供應中心）：各品項可用數、每一批（批號、效期、剩幾個、狀態）、收貨、廠商召回（用過的逐台通知主刀）。
// 能不能收、能不能召回由服務層判斷（implant.ts、implant-rules）
import { reactive, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import { implantApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { addDays, today } from '@/utils/date'

const { data: v, loading } = useQuery(() => implantApi.implantBoard(), [])
const TONE = { available: 'green', empty: 'gray', expired: 'yellow', recalled: 'red' } as const

const recvOpen = ref(false)
const rf = reactive({ procId: '' as string | number | undefined, lot: '', expiresOn: addDays(today(), 365), qty: undefined as number | undefined })
function openRecv() {
  Object.assign(rf, { procId: '', lot: '', expiresOn: addDays(today(), 365), qty: undefined })
  recvAct.fieldErrors.value = {}
  recvOpen.value = true
}
const recvAct = useAction(implantApi.receiveLot, { success: (l) => `已收貨：${l.name} 批號 ${l.lot} × ${l.qty}` })
async function submitRecv() {
  if (await recvAct.run({ procId: String(rf.procId ?? ''), lot: rf.lot, expiresOn: rf.expiresOn, qty: Number(rf.qty) })) recvOpen.value = false
}

const recalling = ref<{ id: string; label: string }>()
const recallOpen = ref(false)
const reason = ref('')
function openRecall(x: { id: string; label: string }) {
  recalling.value = x
  reason.value = ''
  recallAct.fieldErrors.value = {}
  recallOpen.value = true
}
const recallAct = useAction(implantApi.recallLot, { success: (r) => `已召回批號 ${r.lot}：用在 ${r.affected.length} 台手術` })
async function submitRecall() {
  if (recalling.value && (await recallAct.run(recalling.value.id, reason.value))) recallOpen.value = false
}

const notifying = ref<{ lotId: string; surgeryId: string; label: string }>()
const notifyOpen = ref(false)
const note = ref('')
function openNotify(x: { lotId: string; surgeryId: string; label: string }) {
  notifying.value = x
  note.value = ''
  notifyAct.fieldErrors.value = {}
  notifyOpen.value = true
}
const notifyAct = useAction(implantApi.notifyLotRecall, { success: '已記錄通知' })
async function submitNotify() {
  if (notifying.value && (await notifyAct.run(notifying.value.lotId, notifying.value.surgeryId, note.value))) notifyOpen.value = false
}
</script>

<template>
  <UQueryState :loading="loading && !v" :ready="!!v">
    <div v-if="v" class="space-y-3 text-sm">
      <div class="flex flex-wrap items-center gap-2">
        <p class="text-slate-500">手術中由流動護理師在那一台的「植入物」登記批號；會放植入物的手術完成前至少一筆。自費品項要病房先記錄病人同意。</p>
        <UButton v-if="v.canManage" size="sm" class="ml-auto" :icon="Plus" @click="openRecv">收貨</UButton>
      </div>

      <section v-for="r in v.recalls" :key="r.lotId" class="rounded-md border border-red-300 bg-red-50 p-3">
        <h3 class="font-semibold text-red-800">召回：{{ r.name }} 批號 {{ r.lot }}<span class="ml-2 text-xs font-normal text-red-700">{{ r.recalledText }}・{{ r.reason }}</span></h3>
        <p v-if="r.left" class="text-xs text-red-800">架上還有 {{ r.left }} 個：不能再用，退回廠商。</p>
        <ul v-if="r.affected.length" class="mt-1 divide-y divide-red-100">
          <li v-for="a in r.affected" :key="a.surgeryId" class="flex flex-wrap items-center gap-2 py-1">
            <b>{{ a.patientName }}</b><span class="text-xs text-slate-600">{{ a.chartNo }}・{{ a.date }} {{ a.no }} {{ a.procName }}・{{ a.site }} × {{ a.qty }}・主刀 {{ a.doctorName }}</span>
            <span v-if="a.notified" class="text-xs text-emerald-700">已通知：{{ a.notified }}</span>
            <UButton v-else-if="v.canManage" size="sm" variant="danger" class="ml-auto" @click="openNotify({ lotId: r.lotId, surgeryId: a.surgeryId, label: `${a.patientName} ${a.no}` })">記錄通知</UButton>
            <UBadge v-else tone="red">還沒通知</UBadge>
          </li>
        </ul>
        <p v-else class="mt-1 text-xs text-slate-600">這批沒有用在手術上。</p>
      </section>

      <section class="rounded-md border border-slate-200 bg-white p-3">
        <h3 class="mb-2 font-semibold text-slate-700">品項</h3>
        <div class="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))]">
          <div v-for="it in v.items" :key="it.id" class="rounded border border-slate-200 px-2 py-1.5">
            <div class="text-xs text-slate-500">{{ it.name }}<UBadge v-if="it.selfPay" tone="yellow" class="ml-1">自費</UBadge></div>
            <div class="tabular text-xl font-semibold" :class="it.available ? 'text-slate-800' : 'text-red-700'">{{ it.available }} 個</div>
            <div class="text-xs text-slate-500">{{ it.vendor }}</div>
          </div>
        </div>
      </section>

      <section class="rounded-md border border-slate-200 bg-white p-3">
        <h3 class="mb-1 font-semibold text-slate-700">批號<span class="ml-2 text-xs font-normal text-slate-500">可用的在前，先到期的先用</span></h3>
        <ul class="divide-y divide-slate-100">
          <li v-for="l in v.lots" :key="l.id" class="flex flex-wrap items-center gap-2 py-1.5">
            <UBadge :tone="TONE[l.state]">{{ l.stateLabel }}</UBadge>
            <b>{{ l.name }}</b>
            <span class="tabular text-xs text-slate-600">批號 {{ l.lot }}・效期 <span :class="l.expiring ? 'font-medium text-amber-700' : ''">{{ l.expiresOn }}</span>・剩 {{ l.left }}/{{ l.qty }}・收貨 {{ l.receivedText }}</span>
            <UButton v-if="v.canManage && l.state !== 'recalled'" size="sm" variant="ghost" class="ml-auto text-red-700" @click="openRecall({ id: l.id, label: `${l.name} 批號 ${l.lot}` })">廠商召回</UButton>
          </li>
        </ul>
      </section>
    </div>

    <UDialog v-model="recvOpen" title="植入物收貨" size="sm" @submit="submitRecv">
      <div class="space-y-3 text-sm">
        <USelect v-model="rf.procId" label="品項" placeholder="選擇" :options="(v?.items ?? []).map((x) => ({ label: `${x.name}${x.selfPay ? '（自費）' : ''}`, value: x.id }))" :error="recvAct.fieldErrors.value.procId" />
        <UInput v-model="rf.lot" label="批號" :error="recvAct.fieldErrors.value.lot" />
        <div class="grid grid-cols-2 gap-2">
          <UInput v-model="rf.expiresOn" type="date" label="效期" :error="recvAct.fieldErrors.value.expiresOn" />
          <UInput v-model="rf.qty" type="number" label="數量" :error="recvAct.fieldErrors.value.qty" />
        </div>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="recvOpen = false">取消</UButton>
        <UButton type="submit" :loading="recvAct.pending.value">收貨</UButton>
      </template>
    </UDialog>
    <UDialog v-model="recallOpen" :title="`廠商召回：${recalling?.label ?? ''}`" size="sm" @submit="submitRecall">
      <UInput v-model="reason" label="召回原因（廠商通知內容）" :error="recallAct.fieldErrors.value.reason" />
      <template #footer>
        <UButton variant="secondary" @click="recallOpen = false">取消</UButton>
        <UButton type="submit" variant="danger" :loading="recallAct.pending.value">召回整批</UButton>
      </template>
    </UDialog>
    <UDialog v-model="notifyOpen" :title="`召回通知：${notifying?.label ?? ''}`" size="sm" @submit="submitNotify">
      <UInput v-model="note" label="通知了誰、後續怎麼處理" placeholder="例：已電話通知主刀，門診追蹤傷口與 X 光" :error="notifyAct.fieldErrors.value.note" />
      <template #footer>
        <UButton variant="secondary" @click="notifyOpen = false">取消</UButton>
        <UButton type="submit" :loading="notifyAct.pending.value">記錄</UButton>
      </template>
    </UDialog>
  </UQueryState>
</template>
