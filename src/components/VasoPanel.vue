<script setup lang="ts">
// 升壓劑（住院醫囑「加護病房」分頁，病人在加護病房時）：執行中的升壓劑（目前流速換算的劑量、上限、目標）、開立（劑量換算流速）、
// 停止（劑量還高要寫原因：理想是先逐步調降）。限制（沒有 CVC、DNR 不給急救藥物）直接寫在上面
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UDialog, UInput, USelect, UTextarea } from '@/components/ui'
import { vasoApi, vasoRate, type VasoDef, type VasoItem } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ admissionId: string }>()
const emit = defineEmits<{ changed: [] }>()
const { data, reload } = useQuery(() => vasoApi.patientVaso(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))

const open = ref(false)
const f = reactive({ drugId: '' as string, dose: undefined as number | undefined, max: undefined as number | undefined, weightKg: undefined as number | undefined, target: '' })
const drug = computed(() => v.value?.drugs.find((d) => d.id === f.drugId))
const preview = computed(() => (drug.value && f.dose && f.weightKg ? vasoRate({ unit: drug.value.unit, perMl: drug.value.perMl } as VasoDef, Number(f.dose), Number(f.weightKg)) : undefined))
function openOrder() {
  Object.assign(f, { drugId: v.value?.drugs[0]?.id ?? '', dose: undefined, max: undefined, weightKg: v.value?.weightKg, target: v.value?.targetDefault ?? '' })
  act.fieldErrors.value = {}
  open.value = true
}
const act = useAction(vasoApi.orderVaso, { success: (x) => `已開立：${x.drugName}（護理站接上 CVC）` })
async function submit() {
  if (await act.run(props.admissionId, { drugId: f.drugId, dose: Number(f.dose), max: Number(f.max), weightKg: Number(f.weightKg), target: f.target })) {
    open.value = false
    reload()
    emit('changed')
  }
}
const stopping = ref<VasoItem>()
const stopOpen = computed({ get: () => !!stopping.value, set: (x) => !x && (stopping.value = undefined) })
const reason = ref('')
const stopAct = useAction(vasoApi.stopVaso, { success: '已停止（護理站停掉點滴）' })
async function stop() {
  if (stopping.value && (await stopAct.run(stopping.value.order.id, { reason: reason.value }))) {
    stopping.value = undefined
    reload()
    emit('changed')
  }
}
</script>

<template>
  <section v-if="v" class="rounded-md border border-slate-200 p-3 text-sm">
    <div class="flex flex-wrap items-center gap-2">
      <span class="font-semibold text-slate-700">升壓劑</span>
      <UBadge v-if="v.dnrBlocked" tone="red">DNR：不施行急救藥物（強心、升壓）</UBadge>
      <UBadge v-else-if="!v.hasCvc" tone="yellow">沒有中心靜脈導管：不能開</UBadge>
      <UButton v-if="v.canOrder && !v.dnrBlocked && v.hasCvc" class="ml-auto" size="sm" variant="secondary" @click="openOrder">開升壓劑</UButton>
    </div>
    <p v-if="!v.items.length" class="mt-1 text-xs text-slate-500">沒有使用升壓劑（SOFA 心血管看 MAP）</p>
    <div v-for="x in v.items" :key="x.order.id" class="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
      <b class="text-slate-800">{{ x.drugName }}</b>
      <span v-if="x.current" class="tabular">目前 <b>{{ x.current.dose }}</b> {{ x.unit }}（{{ x.current.rateMlH }} ml/h）</span>
      <UBadge v-else tone="yellow">護理站還沒接上</UBadge>
      <span class="tabular text-xs text-slate-500">上限 {{ x.order.infusion?.vaso?.max }}・{{ x.order.infusion?.vaso?.weightKg }} kg・目標 {{ x.order.infusion?.vaso?.target }}・{{ x.order.doctorName }}</span>
      <UButton class="ml-auto" size="sm" variant="ghost" @click="reason = ''; stopAct.fieldErrors.value = {}; stopping = x">停止</UButton>
    </div>

    <UDialog v-model="open" title="開升壓劑" size="sm" @submit="submit">
      <div class="space-y-2">
        <USelect v-model="f.drugId" label="藥品（預混點滴袋）" :options="v.drugs.map((d) => ({ label: d.name, value: d.id }))" :error="act.fieldErrors.value.drugId" />
        <div class="grid grid-cols-2 gap-2">
          <UInput v-model="f.dose" type="number" step="any" :label="`起始劑量 ${drug?.unit ?? ''}`" :hint="drug ? `${drug.range[0]}–${drug.range[1]}` : ''" :error="act.fieldErrors.value.dose" />
          <UInput v-model="f.max" type="number" step="any" :label="`上限 ${drug?.unit ?? ''}`" hint="護理師在上限內依血壓調" :error="act.fieldErrors.value.max" />
          <UInput v-model="f.weightKg" type="number" step="any" label="體重 kg" :hint="v.weightKg ? '帶入營養篩檢的體重' : ''" :error="act.fieldErrors.value.weightKg" />
          <UInput v-model="f.target" label="目標" :error="act.fieldErrors.value.target" />
        </div>
        <p v-if="preview !== undefined" class="tabular text-sm text-slate-700">換算流速 <b>{{ preview }} ml/h</b></p>
        <p class="text-xs text-slate-500">要從中心靜脈導管給；同一種只能有一筆（要改範圍先停再開）。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton type="submit" :loading="act.pending.value">開立</UButton>
      </template>
    </UDialog>
    <UDialog v-model="stopOpen" :title="`停止 ${stopping?.drugName ?? ''}`" size="sm" @submit="stop">
      <p v-if="stopping?.stopNeedsReason" class="text-sm text-amber-800">目前 {{ stopping?.current?.dose }} {{ stopping?.unit }}，高於可以直接停的 {{ stopping?.weanTo }}：建議先請護理師逐步調降；要直接停請寫原因。</p>
      <p v-else class="text-sm text-slate-600">劑量已經調降到可以停的範圍。</p>
      <div class="mt-2"><UTextarea v-model="reason" :label="stopping?.stopNeedsReason ? '直接停止的原因' : '原因（選填）'" :rows="2" :required="stopping?.stopNeedsReason" :error="stopAct.fieldErrors.value.reason" /></div>
      <template #footer>
        <UButton variant="secondary" @click="stopOpen = false">取消</UButton>
        <UButton type="submit" variant="danger" :loading="stopAct.pending.value">停止</UButton>
      </template>
    </UDialog>
  </section>
</template>
