<script setup lang="ts">
// 交班：以「病房」為單位，接班的人要看的是整個病房，不是一個病人。
// 顯示最近三班（一整天），依「班」分組、最新的班在前——以前依「今天」查，小夜 23:45 寫的交班，大夜 00:15 就看不到。
// 新增時預設「正要結束的班別」（handoverShiftOf），病人預設為清單上選取的那一位。
import { computed, reactive, watch } from 'vue'
import { UButton, UQueryState, USelect, UTextarea } from '@/components/ui'
import { handoverShiftOf, nursingApi, shiftOf, SHIFT_ORDER, type Shift, type WardPatient } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ ward: string; patients: WardPatient[]; selectedId?: string; clock: string }>()
// 換班時（例：00:00 小夜 → 大夜）重新查詢，清單跟著往前推一班
const currentShift = computed(() => `${props.clock.slice(0, 10)} ${shiftOf(props.clock)}`)

const { data, loading } = useQuery(
  async () => {
    const ward = props.ward
    return { ward, groups: await nursingApi.listHandovers(ward) }
  },
  [() => props.ward, currentShift],
)
const grouped = computed(() => (data.value?.ward === props.ward ? data.value.groups : undefined))
const shifts: Shift[] = SHIFT_ORDER

const form = reactive({ shift: handoverShiftOf(props.clock) as string | number | undefined, admissionId: props.selectedId as string | number | undefined, content: '' })
watch(() => props.selectedId, (id) => id && (form.admissionId = id))
const patientOptions = computed(() => props.patients.map((p) => ({ label: `${p.bed?.bedNo} ${p.patientName}`, value: p.id })))

const save = useAction(nursingApi.addHandover, { success: '已新增交班' })
async function submit() {
  if (!form.admissionId) return
  const ok = await save.run({ ward: props.ward, shift: form.shift as Shift, admissionId: String(form.admissionId), content: form.content })
  if (ok) form.content = ''
}
</script>

<template>
  <div class="space-y-4 p-4">
    <div class="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div class="mb-2 text-sm font-semibold text-slate-700">新增交班</div>
      <div class="grid grid-cols-1 gap-2 md:grid-cols-[8rem_14rem_1fr]">
        <USelect v-model="form.shift" label="班別" :options="shifts.map((s) => ({ label: s, value: s }))" />
        <USelect v-model="form.admissionId" label="病人" required :options="patientOptions" placeholder="請選擇" />
        <UTextarea v-model="form.content" label="交班重點" :rows="2" :error="save.fieldErrors.value.content" placeholder="例：夜間體溫最高 38.1°C，已給退燒藥；明早空腹抽血" />
      </div>
      <div class="mt-2 text-right"><UButton size="sm" :loading="save.pending.value" :disabled="!form.admissionId" @click="submit">儲存交班</UButton></div>
    </div>

    <UQueryState :loading="loading && !grouped" :ready="!!grouped?.length" :empty-title="`${ward} 最近一天沒有交班紀錄`">
      <section v-for="g in grouped" :key="g.date + g.shift" class="mb-4 last:mb-0">
        <h3 class="mb-2 text-sm font-semibold text-slate-700"><span class="tabular">{{ g.date.slice(5).replace('-', '/') }}</span> {{ g.shift }}</h3>
        <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
          <li v-for="h in g.items" :key="h.id" :class="['flex gap-3 px-3 py-2 text-sm', h.admissionId === selectedId && 'bg-brand-50/50']">
            <span class="tabular w-14 shrink-0 font-medium text-slate-700">{{ h.bedNo }}</span>
            <div class="min-w-0 flex-1">
              <div class="font-medium text-slate-800">{{ h.patientName }}</div>
              <div class="text-slate-600">{{ h.content }}</div>
            </div>
            <div class="tabular shrink-0 text-right text-xs text-slate-500">{{ h.createdAt.slice(5).replace('-', '/') }}<br />{{ h.nurseName }}</div>
          </li>
        </ul>
      </section>
    </UQueryState>
  </div>
</template>
