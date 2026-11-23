<script setup lang="ts">
// 床邊侵入性處置（住院醫囑「床邊處置」分頁；護理站同分頁唯讀）：腰椎穿刺、胸腔穿刺、腹腔穿刺、胸管置放。
// 醫師登錄：適應症、處置前暫停（病人身分、部位與側別）、出血風險評估、外觀、引流量／開口壓、併發症。
// 要有這次住院、這種處置（同側）還沒用掉的同意書；緊急選原因。存檔自動開處置醫令。判斷都在服務層（bedside.ts）
import { computed, reactive, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState, UTextarea } from '@/components/ui'
import { BEDSIDE_CONSENT_WAIVERS, BEDSIDE_KINDS, bedsideApi, bedsideKind, SIDE_TEXT } from '@/services'
import type { BedsideKind } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { now } from '@/utils/date'

const props = defineProps<{ admissionId: string }>()
const auth = useAuth()
const isDoctor = computed(() => auth.user?.role === 'doctor')
const { data, loading } = useQuery(async () => ({ id: props.admissionId, v: await bedsideApi.listBedside(props.admissionId) }), [() => props.admissionId])
const v = computed(() => (data.value?.id === props.admissionId ? data.value.v : undefined))

const open = ref(false)
const f = reactive({ kind: 'thoracentesis' as BedsideKind, side: '' as '' | 'left' | 'right', indication: '', identity: false, site: false, performedAt: '', appearance: '', volumeMl: '', volumeNote: '', openingPressure: '', complication: '無', bleedingNote: '', consentWaiver: '' })
const meta = computed(() => bedsideKind(f.kind))
const ready = computed(() => !!v.value?.consentReady.some((c) => c.kind === f.kind && (!meta.value.sided || c.side === f.side)))
const readySides = computed(() => (v.value?.consentReady ?? []).filter((c) => c.kind === f.kind && c.side).map((c) => SIDE_TEXT[c.side!]))
const overVolume = computed(() => !!meta.value.maxVolumeMl && Number(f.volumeMl) > meta.value.maxVolumeMl)
function openAdd() {
  const first = v.value?.consentReady[0]
  Object.assign(f, { kind: first?.kind ?? 'thoracentesis', side: first?.side ?? '', indication: '', identity: false, site: false, performedAt: now().slice(0, 16).replace(' ', 'T'), appearance: '', volumeMl: '', volumeNote: '', openingPressure: '', complication: '無', bleedingNote: '', consentWaiver: '' })
  act.fieldErrors.value = {}
  open.value = true
}
const act = useAction(bedsideApi.recordBedside, { success: (p) => `已登錄${p.title}` })
async function submit() {
  const m = meta.value
  const ok = await act.run({
    admissionId: props.admissionId, kind: f.kind, ...(m.sided ? { side: f.side } : {}), indication: f.indication, timeOut: { identity: f.identity, site: f.site },
    performedAt: f.performedAt.replace('T', ' '), appearance: f.appearance, ...(m.volume ? { volumeMl: f.volumeMl, volumeNote: f.volumeNote } : {}), ...(m.pressure ? { openingPressure: f.openingPressure } : {}),
    complication: f.complication, bleedingNote: f.bleedingNote, ...(!ready.value && f.consentWaiver ? { consentWaiver: f.consentWaiver } : {}),
  })
  if (ok) open.value = false
}
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <div class="flex items-center justify-between gap-2">
      <span class="font-semibold text-slate-700">床邊處置</span>
      <UButton v-if="isDoctor && v?.admitted" size="sm" variant="secondary" :icon="Plus" @click="openAdd">登錄處置</UButton>
    </div>
    <UQueryState :loading="loading && !v" :ready="!!v">
      <template v-if="v">
        <div v-if="v.risks.length" class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">出血風險：{{ v.risks.join('、') }}</div>
        <p v-if="!v.items.length" class="rounded-md border border-slate-200 px-3 py-4 text-center text-slate-400">這次住院沒有床邊處置紀錄</p>
        <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
          <li v-for="p in v.items" :key="p.id" class="space-y-1 px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <b class="text-slate-800">{{ p.title }}</b>
              <span class="tabular text-xs text-slate-500">{{ p.performedAt.slice(5) }}・{{ p.performedByName }}</span>
              <span v-if="p.consentNo" class="text-xs text-slate-500">同意書 {{ p.consentNo }}</span>
              <UBadge v-else-if="p.consentWaiver" tone="gray" :title="p.consentWaiver">無同意書：緊急</UBadge>
              <UBadge v-if="p.complication !== '無'" tone="red">併發症</UBadge>
            </div>
            <div class="text-xs text-slate-600">適應症：{{ p.indication }}</div>
            <div class="text-xs text-slate-600">
              外觀 {{ p.appearance }}<template v-if="p.volumeMl !== undefined">・引流 {{ p.volumeMl }} mL</template><template v-if="p.openingPressure !== undefined">・開口壓 {{ p.openingPressure }} cmH2O</template>・併發症：{{ p.complication }}
            </div>
            <div v-if="p.volumeNote" class="text-xs text-slate-500">超過建議量：{{ p.volumeNote }}</div>
            <div v-if="p.bleedingRisks?.length" class="text-xs text-amber-700">出血風險 {{ p.bleedingRisks.join('、') }}：{{ p.bleedingNote }}</div>
          </li>
        </ul>
        <p class="text-xs text-slate-500">要有這次住院、這種處置（同側）還沒用掉的侵入性處置同意書（病患資料「同意書」分頁）；登錄時自動開處置醫令，帳單照醫令帶。</p>
      </template>
    </UQueryState>

    <UDialog v-model="open" title="登錄床邊處置" size="lg" @submit="submit">
      <div class="space-y-3 text-sm">
        <div class="flex flex-wrap gap-2">
          <label v-for="k in BEDSIDE_KINDS" :key="k.kind" :class="['cursor-pointer rounded-md border-2 px-3 py-1', f.kind === k.kind ? 'border-brand-500 bg-brand-50' : 'border-slate-200']">
            <input v-model="f.kind" type="radio" :value="k.kind" class="sr-only" @change="(f.side = ''), (f.appearance = ''), (f.consentWaiver = '')" />{{ k.label }}
          </label>
        </div>
        <div v-if="meta.sided">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-slate-600">側別：</span>
            <label v-for="s in (['left', 'right'] as const)" :key="s" :class="['cursor-pointer rounded-md border-2 px-3 py-1', f.side === s ? 'border-brand-500 bg-brand-50' : 'border-slate-200']">
              <input v-model="f.side" type="radio" :value="s" class="sr-only" />{{ SIDE_TEXT[s] }}
            </label>
          </div>
          <p v-if="act.fieldErrors.value.side" class="mt-1 text-xs text-red-600">{{ act.fieldErrors.value.side }}</p>
        </div>
        <div :class="['rounded-md border px-3 py-2', ready ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50']">
          <p v-if="ready" class="text-green-800">同意書已簽，登錄後這張就算用掉了。</p>
          <template v-else>
            <p class="text-amber-800">
              {{ meta.label }}{{ meta.sided && f.side ? `（${SIDE_TEXT[f.side]}）` : '' }}要先有侵入性處置同意書（醫師在病患資料「同意書」分頁記錄）<template v-if="readySides.length">；目前簽的是{{ readySides.join('、') }}</template>。緊急的選原因才能登錄：
            </p>
            <label class="mt-1 flex items-start gap-2 text-amber-900">
              <input v-model="f.consentWaiver" type="checkbox" :true-value="BEDSIDE_CONSENT_WAIVERS[0]" false-value="" class="mt-0.5 h-4 w-4" />{{ BEDSIDE_CONSENT_WAIVERS[0] }}
            </label>
          </template>
        </div>
        <UTextarea v-model="f.indication" label="適應症" :rows="2" required :error="act.fieldErrors.value.indication" />
        <div class="rounded-md border border-slate-200 px-3 py-2">
          <div class="mb-1 font-medium text-slate-700">處置前暫停</div>
          <div class="flex flex-wrap gap-x-4 gap-y-1">
            <UCheckbox v-model="f.identity" label="病人身分（手圈兩項辨識）" />
            <UCheckbox v-model="f.site" :label="meta.sided ? '部位與側別（已標記）' : '部位'" />
          </div>
          <p v-if="act.fieldErrors.value.timeOut" class="mt-1 text-xs text-red-600">{{ act.fieldErrors.value.timeOut }}</p>
        </div>
        <UTextarea v-if="v?.risks.length" v-model="f.bleedingNote" :label="`出血風險評估（${v.risks.join('、')}）`" :rows="2" required :error="act.fieldErrors.value.bleedingNote" />
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UInput v-model="f.performedAt" type="datetime-local" label="執行時間" required :error="act.fieldErrors.value.performedAt" />
          <div>
            <UInput v-model="f.appearance" label="外觀" required :error="act.fieldErrors.value.appearance" />
            <div class="mt-1 flex flex-wrap gap-1"><button v-for="s in meta.appearances" :key="s" type="button" class="rounded border border-slate-300 px-1.5 text-xs hover:bg-slate-100" @click="f.appearance = s">{{ s }}</button></div>
          </div>
          <UInput v-if="meta.volume" v-model="f.volumeMl" type="number" label="引流量（mL）" required :hint="meta.maxVolumeMl ? `建議單次不超過 ${meta.maxVolumeMl} mL` : undefined" :error="act.fieldErrors.value.volumeMl" />
          <UInput v-if="meta.pressure" v-model="f.openingPressure" type="number" label="開口壓（cmH2O，選填）" :error="act.fieldErrors.value.openingPressure" />
        </div>
        <UInput v-if="overVolume" v-model="f.volumeNote" label="超過建議量的原因與病人狀況" required :error="act.fieldErrors.value.volumeNote" />
        <UInput v-model="f.complication" label="併發症" required hint="沒有寫「無」" :error="act.fieldErrors.value.complication" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton type="submit" :loading="act.pending.value">登錄</UButton>
      </template>
    </UDialog>
  </div>
</template>
