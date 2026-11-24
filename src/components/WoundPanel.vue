<script setup lang="ts">
// 傷口（護理站病人分頁「傷口」、住院醫囑分頁「傷口」共用）：還沒癒合的傷口（種類、部位、分級、最新大小與面積、院內壓傷標記、
// 2 週沒變小的提醒）、換藥紀錄（面積趨勢）；護理師登錄、換藥、結案。院內壓傷登錄後提醒做壓傷「病情變化加評」
import { computed, reactive, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { areaOf, DRESSINGS, EXUDATE, PRESSURE_SITES, PRESSURE_STAGES, WOUND_KINDS, woundApi, type WoundView } from '@/services'
import type { PressureStage, Wound, WoundCare } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import { now } from '@/utils/date'

const props = defineProps<{ admissionId: string }>()
const emit = defineEmits<{ openRisk: [] }>()
const ui = useUi()
const { data, loading, reload } = useQuery(() => woundApi.patientWounds(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const exLabel = (k: WoundCare['exudate']) => EXUDATE.find((x) => x.key === k)?.label ?? k

// 登錄與換藥共用的評估欄位
const care = reactive({ dressing: '', exudate: '' as WoundCare['exudate'] | '', lengthCm: undefined as number | undefined, widthCm: undefined as number | undefined, depthCm: 0 as number | undefined, stage: '' as PressureStage | '', note: '' })
const liveArea = computed(() => (care.lengthCm && care.widthCm ? areaOf({ lengthCm: Number(care.lengthCm), widthCm: Number(care.widthCm) }) : undefined))
const careInput = () => ({ dressing: care.dressing, exudate: care.exudate as WoundCare['exudate'], lengthCm: Number(care.lengthCm), widthCm: Number(care.widthCm), depthCm: Number(care.depthCm), ...(care.stage ? { stage: care.stage as PressureStage } : {}), note: care.note })
const resetCare = (w?: WoundView) => Object.assign(care, { dressing: w?.latest.dressing ?? '', exudate: '', lengthCm: undefined, widthCm: undefined, depthCm: w?.latest.depthCm ?? 0, stage: w?.latest.stage ?? '', note: '' })

const addOpen = ref(false)
const nw = reactive({ kind: 'pressure' as Wound['kind'], site: '', foundAt: '' })
function openAdd() {
  Object.assign(nw, { kind: 'pressure', site: '', foundAt: now().slice(0, 16).replace(' ', 'T') })
  resetCare()
  add.fieldErrors.value = {}
  addOpen.value = true
}
const add = useAction(woundApi.addWound)
async function submitAdd() {
  const r = await add.run(props.admissionId, { kind: nw.kind, site: nw.site, foundAt: nw.foundAt.replace('T', ' '), ...careInput() })
  if (r) {
    addOpen.value = false
    reload()
    if (r.riskReminder) ui.toast.warning(r.riskReminder)
    else ui.toast.success('已登錄傷口')
  }
}

const caring = ref<WoundView>()
const careOpen = computed({ get: () => !!caring.value, set: (x) => !x && (caring.value = undefined) })
function openCare(w: WoundView) {
  resetCare(w)
  rec.fieldErrors.value = {}
  caring.value = w
}
const rec = useAction(woundApi.recordCare, { success: '已記錄換藥' })
async function submitCare() {
  if (caring.value && (await rec.run(caring.value.id, careInput()))) {
    caring.value = undefined
    reload()
  }
}
const closing = ref<WoundView>()
const close = useAction(woundApi.closeWound, { success: '傷口已結案' })
async function onClose(reason: string) {
  if (closing.value && (await close.run(closing.value.id, reason))) {
    closing.value = undefined
    reload()
  }
}
const errs = computed(() => (caring.value ? rec.fieldErrors.value : add.fieldErrors.value))
const kindNow = computed(() => (caring.value ? caring.value.kind : nw.kind))
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <UQueryState :loading="loading && !v" :ready="!!v">
      <template v-if="v">
        <div class="flex items-center">
          <span class="font-semibold text-slate-700">傷口</span>
          <UButton v-if="v.canNurse" class="ml-auto" size="sm" variant="secondary" :icon="Plus" @click="openAdd">登錄傷口</UButton>
        </div>
        <p v-if="v.riskChangeDue" class="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
          {{ v.riskChangeDue }}<UButton size="sm" variant="secondary" @click="emit('openRisk')">到風險評估</UButton>
        </p>
        <p v-if="!v.open.length" class="rounded-md border border-slate-200 px-3 py-4 text-center text-slate-400">沒有傷口</p>
        <section v-for="w in v.open" :key="w.id" class="space-y-1.5 rounded-md border border-slate-200 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <b class="text-slate-800">{{ w.label }}・{{ w.site }}</b>
            <UBadge v-if="w.stageText" tone="purple">{{ w.stageText }}</UBadge>
            <UBadge v-if="w.hospitalAcquired" tone="red">院內壓傷</UBadge>
            <span class="text-xs text-slate-500">{{ w.foundAt.slice(5).replace('-', '/') }} 發現（{{ w.recordedByName }}）</span>
          </div>
          <p class="tabular">最新：{{ w.latest.lengthCm }}×{{ w.latest.widthCm }}×{{ w.latest.depthCm }} cm（{{ w.latest.area }} cm²）・滲液{{ exLabel(w.latest.exudate) }}・{{ w.latest.dressing }}・{{ w.latest.at.slice(5).replace('-', '/') }}</p>
          <p v-if="w.stall" class="rounded bg-red-50 px-2 py-1 text-xs text-red-800">2 週沒有變小：{{ w.stall.from.at.slice(5, 10).replace('-', '/') }} {{ w.stall.from.area }} cm² → {{ w.stall.to.at.slice(5, 10).replace('-', '/') }} {{ w.stall.to.area }} cm²，請主治評估（換敷料、會診整形外科、營養）</p>
          <table class="w-full text-left text-xs">
            <thead class="whitespace-nowrap text-slate-500"><tr><th class="py-1">時間</th><th>大小 cm</th><th>面積</th><th>分級</th><th>滲液</th><th>敷料</th><th>護理師</th></tr></thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="c in w.careViews" :key="c.at"><td class="tabular py-1">{{ c.at.slice(5).replace('-', '/') }}</td><td class="tabular">{{ c.lengthCm }}×{{ c.widthCm }}×{{ c.depthCm }}</td><td class="tabular">{{ c.area }}</td><td>{{ PRESSURE_STAGES.find((s) => s.stage === c.stage)?.label ?? '—' }}</td><td>{{ exLabel(c.exudate) }}</td><td>{{ c.dressing }}</td><td>{{ c.byName }}</td></tr>
            </tbody>
          </table>
          <div v-if="v.canNurse" class="flex gap-1.5">
            <UButton size="sm" @click="openCare(w)">換藥</UButton>
            <UButton size="sm" variant="ghost" @click="closing = w">結案</UButton>
          </div>
        </section>
        <details v-if="v.closed.length" class="text-xs text-slate-600">
          <summary class="cursor-pointer">已結案 {{ v.closed.length }} 個</summary>
          <ul><li v-for="w in v.closed" :key="w.id">{{ w.label }} {{ w.site }}・{{ w.foundAt.slice(5, 10).replace('-', '/') }} → {{ w.closedAt!.slice(5, 10).replace('-', '/') }}・{{ w.closeReason }}</li></ul>
        </details>
      </template>
    </UQueryState>

    <UDialog :model-value="addOpen || careOpen" :title="caring ? `換藥：${caring.site}` : '登錄傷口'" @update:model-value="(x: boolean) => !x && ((addOpen = false), (caring = undefined))" @submit="caring ? submitCare() : submitAdd()">
      <div class="space-y-3 text-sm">
        <template v-if="!caring">
          <div class="flex gap-2">
            <label v-for="k in WOUND_KINDS" :key="k.kind" :class="['cursor-pointer rounded-md border-2 px-3 py-1', nw.kind === k.kind ? 'border-brand-500 bg-brand-50' : 'border-slate-200']"><input v-model="nw.kind" type="radio" :value="k.kind" class="sr-only" />{{ k.label }}</label>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <UInput v-model="nw.site" label="部位" required :error="add.fieldErrors.value.site" />
              <div v-if="nw.kind === 'pressure'" class="mt-1 flex flex-wrap gap-1"><button v-for="x in PRESSURE_SITES" :key="x" type="button" class="rounded border border-slate-300 px-1.5 text-xs hover:bg-slate-100" @click="nw.site = x">{{ x }}</button></div>
            </div>
            <UInput v-model="nw.foundAt" type="datetime-local" label="發現時間" required :error="add.fieldErrors.value.foundAt" />
          </div>
        </template>
        <div v-if="kindNow === 'pressure'">
          <div class="mb-1 text-slate-700">壓傷分級</div>
          <div class="grid grid-cols-2 gap-1 sm:grid-cols-3">
            <label v-for="s in PRESSURE_STAGES" :key="s.stage" :class="['cursor-pointer rounded border-2 px-2 py-1 text-xs', care.stage === s.stage ? 'border-brand-500 bg-brand-50' : 'border-slate-200']" :title="s.hint"><input v-model="care.stage" type="radio" :value="s.stage" class="sr-only" /><b>{{ s.label }}</b><span class="block text-slate-500">{{ s.hint }}</span></label>
          </div>
          <p v-if="errs.stage" class="text-xs text-red-600">{{ errs.stage }}</p>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <UInput v-model="care.lengthCm" type="number" step="0.1" label="長 cm" :error="errs.lengthCm" />
          <UInput v-model="care.widthCm" type="number" step="0.1" label="寬 cm" :error="errs.widthCm" :hint="liveArea ? `面積 ${liveArea} cm²` : undefined" />
          <UInput v-model="care.depthCm" type="number" step="0.1" label="深 cm" :error="errs.depthCm" />
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <UInput v-model="care.dressing" label="敷料" required :error="errs.dressing" />
            <div class="mt-1 flex flex-wrap gap-1"><button v-for="x in DRESSINGS" :key="x" type="button" class="rounded border border-slate-300 px-1.5 text-xs hover:bg-slate-100" @click="care.dressing = x">{{ x }}</button></div>
          </div>
          <USelect v-model="care.exudate" label="滲液" required placeholder="選擇" :options="EXUDATE.map((x) => ({ label: x.label, value: x.key }))" :error="errs.exudate" />
        </div>
        <UInput v-model="care.note" label="備註（選填：顏色、氣味、周圍皮膚）" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="(addOpen = false), (caring = undefined)">取消</UButton>
        <UButton type="submit" :loading="add.pending.value || rec.pending.value">{{ caring ? '記錄' : '登錄' }}</UButton>
      </template>
    </UDialog>

    <ReasonDialog :model-value="!!closing" title="傷口結案" label="原因" ok-text="結案" :presets="['已癒合，上皮化完整', '出院（轉居家護理）', '轉院']" :pending="close.pending.value" :error="close.fieldErrors.value.reason" @update:model-value="(x: boolean) => !x && (closing = undefined)" @confirm="onClose" />
  </div>
</template>
