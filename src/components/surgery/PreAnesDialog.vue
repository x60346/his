<script setup lang="ts">
// 麻醉前評估（有「麻醉」權限的醫師）：ASA、呼吸道、禁食、病史、麻醉計畫。急刀可以先存精簡版（ASA、呼吸道、禁食）。
// 欄位檢查與困難插管判斷在服務層（anesthesia.savePreAnes、anesthesia-rules）；這裡只收表單
import { computed, reactive, watch } from 'vue'
import { UButton, UCheckbox, UDialog, UInput, USelect, UTextarea } from '@/components/ui'
import PatientFlags from '@/components/PatientFlags.vue'
import { anesthesiaApi, ANESTHESIA_LABEL, ASA_LABEL, HISTORY_LABEL, NPO_LABEL, type SurgeryView } from '@/services'
import type { AnesHistoryKey, AnesthesiaType, AsaClass, NpoStatus } from '@/types'
import { useAction } from '@/composables/useService'

const props = defineProps<{ surgery?: SurgeryView }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ saved: [SurgeryView] }>()

const form = reactive({
  brief: false, asa: '' as number | string | undefined, mallampati: '' as number | string | undefined, mouth: '' as string | number | undefined, neck: '' as string | number | undefined, airwayNote: '',
  npo: '' as string | number | undefined, lastIntake: '', history: [] as AnesHistoryKey[], noHistory: false, historyNote: '', plan: '' as string | number | undefined, planReason: '',
})
watch([open, () => props.surgery?.id], () => {
  const s = props.surgery
  if (!open.value || !s) return
  const p = s.preAnes
  Object.assign(form, {
    brief: p ? !!p.brief : false, asa: p?.asa ?? '', mallampati: p?.airway.mallampati ?? '', mouth: p?.airway.mouth ?? '', neck: p?.airway.neck ?? '', airwayNote: p?.airway.note ?? '',
    npo: p?.npo.status ?? '', lastIntake: (p?.npo.lastIntake ?? '').replace(' ', 'T'), history: [...(p?.history?.items ?? [])], noHistory: !!p?.history && !p.history.items.length, historyNote: p?.history?.note ?? '',
    plan: p?.plan ?? s.anesthesia, planReason: p?.planReason ?? '',
  })
  save.fieldErrors.value = {}
}, { immediate: true })
const requested = computed(() => props.surgery?.preAnes?.changedFrom ?? props.surgery?.anesthesia)
const toggle = (k: AnesHistoryKey, on: boolean) => {
  form.history = on ? [...new Set([...form.history, k])] : form.history.filter((x) => x !== k)
  if (on) form.noHistory = false
}
const save = useAction(anesthesiaApi.savePreAnes, { success: (s) => `已存麻醉前評估：${s.preAnesText}` })
async function submit() {
  if (!props.surgery) return
  const v = await save.run(props.surgery.id, {
    brief: form.brief, asa: Number(form.asa) as AsaClass,
    airway: { mallampati: Number(form.mallampati), mouth: String(form.mouth ?? ''), neck: String(form.neck ?? ''), note: form.airwayNote },
    npo: { status: String(form.npo ?? '') as NpoStatus, lastIntake: form.lastIntake.replace('T', ' ') },
    ...(form.brief ? {} : { history: form.history.length || form.noHistory ? { items: form.history, note: form.historyNote } : undefined, plan: String(form.plan ?? '') as AnesthesiaType, planReason: form.planReason }),
  })
  if (v) {
    open.value = false
    emit('saved', v)
  }
}
const e = (k: string) => save.fieldErrors.value[k]
</script>

<template>
  <UDialog v-model="open" :title="`麻醉前評估：${surgery?.patientName ?? ''}`" size="lg" @submit="submit">
    <div v-if="surgery" class="space-y-3 text-sm">
      <div class="space-y-1 rounded-md bg-slate-50 px-3 py-2">
        <div class="flex flex-wrap items-center gap-2">
          <b>{{ surgery.patientName }}</b><span class="text-slate-600">{{ surgery.gender }} {{ surgery.age }}・{{ surgery.bedNo }}</span>
          <span v-if="surgery.urgencyLabel" class="rounded bg-red-50 px-1.5 text-xs font-medium text-red-700">急刀・{{ surgery.urgencyLabel }}</span>
          <PatientFlags :flags="surgery.flags" />
        </div>
        <div>{{ surgery.procName }}（{{ surgery.sideText }}）・申請{{ requested ? ANESTHESIA_LABEL[requested] : '' }}・術前診斷 {{ surgery.diagnosis }}</div>
        <div :class="surgery.allergies.length ? 'font-semibold text-red-700' : 'text-slate-500'">過敏：{{ surgery.allergies.length ? surgery.allergies.join('、') : '無已知過敏' }}</div>
        <div class="text-xs text-slate-600">腎功能：{{ surgery.renalText }}</div>
      </div>

      <UCheckbox v-if="surgery.urgency" v-model="form.brief" label="急刀先存精簡版（ASA、呼吸道、禁食；病史與麻醉計畫事後補）" />
      <p v-if="e('brief')" class="text-xs text-red-700">{{ e('brief') }}</p>

      <USelect v-model="form.asa" label="ASA 分級" required :options="([1, 2, 3, 4, 5] as AsaClass[]).map((k) => ({ label: `ASA ${k}${surgery?.urgency ? 'E' : ''}：${ASA_LABEL[k]}`, value: k }))" placeholder="選擇" :error="e('asa')" />

      <fieldset class="rounded-md border border-slate-200 p-3">
        <legend class="px-1 text-xs font-semibold text-slate-600">呼吸道（任一不良＝困難插管）</legend>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <USelect v-model="form.mallampati" label="Mallampati" required :options="[1, 2, 3, 4].map((k) => ({ label: ['I', 'II', 'III', 'IV'][k - 1], value: k }))" placeholder="選擇" :error="e('mallampati')" />
          <USelect v-model="form.mouth" label="張口度" required :options="[{ label: '正常（≥ 3 指）', value: 'ok' }, { label: '受限', value: 'limited' }]" placeholder="選擇" :error="e('mouth')" />
          <USelect v-model="form.neck" label="頸部活動" required :options="[{ label: '正常', value: 'ok' }, { label: '受限', value: 'limited' }]" placeholder="選擇" :error="e('neck')" />
        </div>
        <div class="mt-2"><UInput v-model="form.airwayNote" label="備註（選填，例：假牙、鬍鬚、之前插管困難）" /></div>
      </fieldset>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <USelect v-model="form.npo" label="禁食狀態" required :options="(Object.keys(NPO_LABEL) as NpoStatus[]).map((k) => ({ label: NPO_LABEL[k], value: k }))" placeholder="選擇" :error="e('npo')" />
        <UInput v-if="form.npo && form.npo !== 'unknown'" v-model="form.lastIntake" type="datetime-local" label="最後進食時間" required :error="e('lastIntake')" />
      </div>

      <template v-if="!form.brief">
        <fieldset class="rounded-md border border-slate-200 p-3">
          <legend class="px-1 text-xs font-semibold text-slate-600">重大病史</legend>
          <div class="flex flex-wrap gap-x-4 gap-y-1">
            <UCheckbox v-for="(l, k) in HISTORY_LABEL" :key="k" :model-value="form.history.includes(k)" :label="l" @update:model-value="(on: boolean) => toggle(k, on)" />
            <UCheckbox :model-value="form.noHistory" label="無" @update:model-value="(on: boolean) => { form.noHistory = on; if (on) form.history = [] }" />
          </div>
          <p v-if="e('history')" class="mt-1 text-xs text-red-700">{{ e('history') }}</p>
          <div class="mt-2"><UTextarea v-model="form.historyNote" label="說明（選填）" :rows="2" /></div>
        </fieldset>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <USelect v-model="form.plan" label="計畫的麻醉方式" required :options="(Object.keys(ANESTHESIA_LABEL) as AnesthesiaType[]).map((k) => ({ label: ANESTHESIA_LABEL[k], value: k }))" :error="e('plan')" />
          <UInput v-if="form.plan && form.plan !== requested" v-model="form.planReason" label="和申請不同的原因" required :error="e('planReason')" />
        </div>
      </template>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton type="submit" :loading="save.pending.value">存評估</UButton>
    </template>
  </UDialog>
</template>
