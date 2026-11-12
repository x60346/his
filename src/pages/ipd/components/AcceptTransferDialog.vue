<script setup lang="ts">
// 轉入申請（新科醫師）：接受＝成為主治；逐筆決定原醫囑延續或停止（預設全部延續），可一併轉到本科病房的空床。
// 也可以婉拒（寫原因，原科醫師會看到）。送出的是「這個畫面列出的醫囑」：原科在這之後又開的，服務層會擋下要求重新整理。
import { computed, reactive, ref, watch } from 'vue'
import { UBadge, UButton, UCheckbox, UDialog, USelect, UTextarea } from '@/components/ui'
import { admissionApi, masterApi } from '@/services'
import type { IncomingTransfer } from '@/services/admission'
import { useAction, useQuery } from '@/composables/useService'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ item?: IncomingTransfer }>()
const emit = defineEmits<{ accepted: [admissionId: string] }>()

const stops = reactive<Record<string, boolean>>({})
const bed = reactive({ ward: '' as string | number | undefined, bedId: '' as string | number | undefined })
const declining = ref(false)
const declineReason = ref('')
watch(open, (v) => {
  if (!v) return
  for (const k of Object.keys(stops)) delete stops[k]
  Object.assign(bed, { ward: '', bedId: '' })
  declining.value = false
  declineReason.value = ''
  accept.fieldErrors.value = {}
  decline.fieldErrors.value = {}
})

const wards = masterApi.staticCodes.wards
const { data: beds } = useQuery(async () => (bed.ward ? admissionApi.listBeds(String(bed.ward)) : []), [() => bed.ward])
const bedOptions = computed(() => [
  { label: '留在原床（之後可再轉床）', value: '' },
  ...(beds.value ?? []).filter((b) => b.status === 'empty').map((b) => ({ label: `${b.bedNo}（${b.bedClass}）`, value: b.id })),
])
function onWard(v: string | number | undefined) {
  bed.ward = v
  bed.bedId = ''
}
const stopCount = computed(() => Object.values(stops).filter(Boolean).length)

const accept = useAction(admissionApi.acceptDeptTransfer, { success: (a) => `已接受轉科：${a.patientName} 由您擔任主治（${a.deptName}）` })
async function onAccept() {
  const it = props.item
  if (!it) return
  const r = await accept.run(it.admission.id, {
    shownOrderIds: it.orders.map((o) => o.id),
    stopOrderIds: it.orders.filter((o) => stops[o.id]).map((o) => o.id),
    ...(bed.bedId ? { bedId: String(bed.bedId) } : {}),
  })
  if (r) {
    open.value = false
    emit('accepted', r.id)
  }
}
const decline = useAction(admissionApi.declineDeptTransfer, { success: '已婉拒轉科，原科醫師會看到原因' })
async function onDecline() {
  if (props.item && (await decline.run(props.item.admission.id, declineReason.value))) open.value = false
}
</script>

<template>
  <UDialog v-model="open" :title="`轉入申請：${item?.admission.patientName ?? ''}`" size="lg">
    <div v-if="item" class="space-y-4 text-sm">
      <div class="rounded-md bg-slate-50 px-3 py-2">
        <div class="font-medium text-slate-800">
          {{ item.transfer.fromDeptName }}（{{ item.transfer.fromDoctorName }}）→ {{ item.transfer.toDeptName }}<template v-if="item.transfer.toDoctorName">・指定 {{ item.transfer.toDoctorName }}</template>
        </div>
        <div class="text-slate-600">{{ item.admission.bed?.bedNo }}・{{ item.admission.diagnosis }}・第 {{ item.admission.days }} 天</div>
        <div class="mt-1 text-slate-700">原因：{{ item.transfer.reason }}</div>
        <div class="text-xs text-slate-500">{{ item.transfer.requestedAt.slice(5) }} {{ item.transfer.requestedByName }} 申請</div>
      </div>

      <template v-if="!declining">
        <section>
          <h3 class="mb-1 font-semibold text-slate-700">原醫囑：預設全部延續，勾選要停止的</h3>
          <p v-if="!item.orders.length" class="text-slate-400">沒有執行中的長期醫囑</p>
          <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
            <li v-for="o in item.orders" :key="o.id" :class="['flex items-center gap-3 px-3 py-2', stops[o.id] && 'bg-red-50 text-slate-500']">
              <UCheckbox v-model="stops[o.id]" :aria-label="`停止 ${o.content}`" />
              <div class="min-w-0 flex-1">
                <div :class="['font-medium', stops[o.id] ? 'line-through' : 'text-slate-800']">
                  {{ o.content }}<UBadge v-if="o.highAlert" tone="purple" class="ml-1">高警訊</UBadge>
                </div>
                <div v-if="o.category === 'medication'" class="tabular text-xs">每次 {{ o.dose }} {{ o.unit }}・{{ o.freqLabel }}・{{ o.route }}</div>
              </div>
              <span class="text-xs text-slate-500">{{ o.startAt.slice(5, 10) }} {{ o.doctorName }}</span>
              <UBadge :tone="stops[o.id] ? 'red' : 'green'">{{ stops[o.id] ? '停止' : '延續' }}</UBadge>
            </li>
          </ul>
          <p class="mt-1 text-xs text-slate-500">延續的醫囑仍記原開立醫師；停止的，之後還沒給的排程刪除（已調劑的藥自動列入住院藥局待退藥）。</p>
        </section>
        <section class="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3">
          <USelect :model-value="bed.ward" label="一併轉床：病房" :options="[{ label: '不轉床', value: '' }, ...wards.map((w) => ({ label: w, value: w }))]" @update:model-value="onWard" />
          <USelect v-model="bed.bedId" label="空床" :options="bedOptions" :disabled="!bed.ward" />
        </section>
      </template>
      <UTextarea v-else v-model="declineReason" label="婉拒原因（原科醫師會看到）" required :rows="2" placeholder="例：目前病床已滿，請下週再轉" :error="decline.fieldErrors.value.reason" />
    </div>
    <template #footer>
      <template v-if="!declining">
        <UButton variant="ghost" class="mr-auto" @click="declining = true">婉拒…</UButton>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton :loading="accept.pending.value" @click="onAccept">接受轉科{{ stopCount ? `（停止 ${stopCount} 筆）` : '' }}</UButton>
      </template>
      <template v-else>
        <UButton variant="secondary" @click="declining = false">返回</UButton>
        <UButton variant="danger" :disabled="!declineReason.trim()" :loading="decline.pending.value" @click="onDecline">婉拒</UButton>
      </template>
    </template>
  </UDialog>
</template>
