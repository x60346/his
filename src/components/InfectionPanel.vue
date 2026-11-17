<script setup lang="ts">
// 院內感染（護理站病人分頁、住院醫囑分頁、感染管制頁共用）：這次住院的感染個案；醫師、護理師「通報」
// （管路相關選管路：放不到 3 天的標出來不能選；手術部位選手術）；有「感染管制」權限的人判定成立或不成立；成立時提醒可以開接觸隔離
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UDialog, UInput, UQueryState, USelect, UTextarea } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { INFECTION_KINDS, infectionApi, lineRelated, type InfectionView } from '@/services'
import type { InfectionKind } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { today } from '@/utils/date'

const props = defineProps<{ admissionId: string }>()
const emit = defineEmits<{ changed: [] }>()
const { data, loading, reload } = useQuery(() => infectionApi.patientInfections(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const statusView = { reported: { text: '待判定', tone: 'yellow' }, confirmed: { text: '成立', tone: 'red' }, rejected: { text: '不成立', tone: 'gray' } } as const

const open = ref(false)
const f = reactive({ kind: '' as InfectionKind | '', lineId: '' as string | number | undefined, surgeryId: '' as string | number | undefined, onsetAt: today(), symptoms: '', culture: '' })
const meta = computed(() => INFECTION_KINDS.find((k) => k.kind === f.kind))
// 管路相關：只列對的種類；發生時放不到 3 天的標出來（服務層同一個 lineRelated）
const lineOptions = computed(() => (v.value?.lines ?? []).filter((l) => l.kind === meta.value?.line).map((l) => ({ label: `${l.text}${lineRelated(l.insertedAt, f.onsetAt, l.removedAt) ? '' : '・不算管路相關'}`, value: l.id })))
function openReport() {
  Object.assign(f, { kind: '', lineId: '', surgeryId: '', onsetAt: today(), symptoms: '', culture: '' })
  rep.fieldErrors.value = {}
  open.value = true
}
const rep = useAction(infectionApi.reportInfection, { success: '已通報，等感染管制判定' })
async function submit() {
  if (!f.kind) return
  if (await rep.run(props.admissionId, { kind: f.kind, lineId: String(f.lineId ?? ''), surgeryId: String(f.surgeryId ?? ''), onsetAt: f.onsetAt, symptoms: f.symptoms, culture: f.culture })) {
    open.value = false
    emit('changed')
  }
}
const deciding = ref<{ c: InfectionView; confirm: boolean }>()
const decide = useAction(infectionApi.decideInfection, { success: (c) => (c.status === 'confirmed' ? `判定成立${c.suggestIsolation ? '：病人目前沒有接觸隔離，可以在「隔離與 DNR」開' : ''}` : '判定不成立') })
async function onDecide(reason: string) {
  if (deciding.value && (await decide.run(deciding.value.c.id, deciding.value.confirm, reason))) {
    deciding.value = undefined
    reload()
    emit('changed')
  }
}
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <UQueryState :loading="loading && !v" :ready="!!v">
      <template v-if="v">
        <div class="flex items-center">
          <span class="font-semibold text-slate-700">院內感染</span>
          <UButton v-if="v.canReport" class="ml-auto" size="sm" variant="secondary" @click="openReport">通報</UButton>
        </div>
        <p v-if="!v.cases.length" class="rounded-md border border-slate-200 px-3 py-4 text-center text-slate-400">這次住院沒有通報的院內感染</p>
        <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
          <li v-for="c in v.cases" :key="c.id" class="space-y-1 px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <b class="text-slate-800">{{ c.label }}</b>
              <UBadge :tone="statusView[c.status].tone">{{ statusView[c.status].text }}</UBadge>
              <span class="text-xs text-slate-500">發生 {{ c.onsetAt.slice(5) }}・{{ c.reportedByName }} {{ c.reportedAt.slice(5) }} 通報</span>
            </div>
            <p v-if="c.lineText || c.surgeryText" class="text-xs text-slate-600">{{ c.lineText ?? c.surgeryText }}</p>
            <p class="text-slate-700">{{ c.symptoms }}</p>
            <p class="text-slate-700"><span class="text-xs text-slate-500">培養：</span>{{ c.culture }}</p>
            <p v-if="c.decision" class="text-xs text-slate-600">{{ c.decidedByName }} {{ c.decision.at.slice(5) }} 判定：{{ c.decision.reason }}</p>
            <p v-if="c.suggestIsolation" class="text-xs text-amber-800">成立：病人目前沒有接觸隔離，可以在「隔離與 DNR」開（不自動開）。</p>
            <div v-if="v.canDecide && c.status === 'reported'" class="flex gap-1.5">
              <UButton size="sm" variant="danger" @click="deciding = { c, confirm: true }">判定成立</UButton>
              <UButton size="sm" variant="secondary" @click="deciding = { c, confirm: false }">不成立</UButton>
            </div>
          </li>
        </ul>
      </template>
    </UQueryState>

    <UDialog v-model="open" title="院內感染通報" @submit="submit">
      <div class="space-y-3 text-sm">
        <div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <label v-for="k in INFECTION_KINDS" :key="k.kind" :class="['cursor-pointer rounded-md border-2 px-2 py-1', f.kind === k.kind ? 'border-brand-500 bg-brand-50' : 'border-slate-200']">
            <input v-model="f.kind" type="radio" :value="k.kind" class="sr-only" />{{ k.label }}<span class="block text-xs text-slate-500">{{ k.hint }}</span>
          </label>
        </div>
        <p v-if="rep.fieldErrors.value.kind" class="text-xs text-red-600">{{ rep.fieldErrors.value.kind }}</p>
        <UInput v-model="f.onsetAt" type="date" label="發生日期（症狀開始）" required :error="rep.fieldErrors.value.onsetAt" />
        <template v-if="meta?.line">
          <USelect v-model="f.lineId" label="當時在身上的管路" required placeholder="選擇" :options="lineOptions" :error="rep.fieldErrors.value.lineId" />
          <p v-if="!lineOptions.length" class="text-xs text-amber-800">這次住院沒有這種管路：請改選「其他院內感染」。</p>
        </template>
        <USelect v-if="f.kind === 'ssi'" v-model="f.surgeryId" label="哪一次手術" required placeholder="選擇" :options="(v?.surgeries ?? []).map((s) => ({ label: s.text, value: s.id }))" :error="rep.fieldErrors.value.surgeryId" />
        <UTextarea v-model="f.symptoms" label="症狀與徵象" :rows="2" required :error="rep.fieldErrors.value.symptoms" />
        <UInput v-model="f.culture" label="培養或檢查結果" required placeholder="例：尿液培養 E. coli ≥10⁵（還沒有結果寫「待報告」）" :error="rep.fieldErrors.value.culture" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton type="submit" :disabled="!f.kind" :loading="rep.pending.value">通報</UButton>
      </template>
    </UDialog>

    <ReasonDialog :model-value="!!deciding" :title="deciding?.confirm ? '判定成立' : '判定不成立'" :label="deciding?.confirm ? '依據' : '理由'"
      :presets="deciding?.confirm ? ['符合收案定義：症狀＋培養陽性'] : ['入院時已有症狀', '培養是污染菌', '找到其他感染源']" :pending="decide.pending.value" :error="decide.fieldErrors.value.reason"
      @update:model-value="(x: boolean) => !x && (deciding = undefined)" @confirm="onDecide" />
  </div>
</template>
