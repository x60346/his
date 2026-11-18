<script setup lang="ts">
// 藥事照護（臨床藥師查房）：上方最近 30 天依類型的建議數與接受率；左邊住院中的病人（有待回覆建議的標數字）；
// 右邊看病人（診斷、過敏、腎功能、在用的藥）、這位病人的建議紀錄，寫新的建議（類型＋內容）。規則在服務層 pharmcare.ts
import { computed, reactive, ref, watch } from 'vue'
import { Send } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UEmpty, UQueryState, USelect, UTextarea } from '@/components/ui'
import PharmCareList from '@/components/PharmCareList.vue'
import { PHARMCARE_KIND_LABEL, pharmCareApi } from '@/services'
import type { PharmCareKind } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'

const { data, loading } = useQuery(() => pharmCareApi.listPharmCare())
const selId = ref<string>()
useRevealOnNarrow(selId)
const pt = computed(() => data.value?.patients.find((x) => x.admissionId === selId.value))
const form = reactive({ kind: '' as string | number | undefined, text: '' })
watch(selId, () => Object.assign(form, { kind: '', text: '' }))
const add = useAction(pharmCareApi.addPharmCare, { success: '已送出建議，主治首頁會看到「藥師建議待回覆」' })
async function submit() {
  if (pt.value && (await add.run(pt.value.admissionId, { kind: String(form.kind ?? '') as PharmCareKind, text: form.text }))) Object.assign(form, { kind: '', text: '' })
}
const total = computed(() => data.value?.stats.at(-1))
</script>

<template>
  <div class="space-y-4">
    <UCard v-if="data" title="藥事照護建議（最近 30 天）" :padded="false">
      <div class="overflow-x-auto">
        <table class="tabular w-full text-sm">
          <thead class="bg-slate-50 text-xs text-slate-500"><tr><th class="px-3 py-2 text-left">類型</th><th class="px-3 py-2 text-right">建議</th><th class="px-3 py-2 text-right">接受</th><th class="px-3 py-2 text-right">不接受</th><th class="px-3 py-2 text-right">待回覆</th><th class="px-3 py-2 text-right">接受率</th></tr></thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="s in data.stats" :key="s.kind" :class="s.kind === 'total' && 'bg-slate-50 font-semibold'"><td class="whitespace-nowrap px-3 py-1.5">{{ s.label }}</td><td class="px-3 py-1.5 text-right">{{ s.sent }}</td><td class="px-3 py-1.5 text-right">{{ s.accepted }}</td><td class="px-3 py-1.5 text-right">{{ s.declined }}</td><td class="px-3 py-1.5 text-right">{{ s.pending }}</td><td class="px-3 py-1.5 text-right">{{ s.rate === null ? '—' : `${s.rate.toFixed(1)}%` }}</td></tr>
          </tbody>
        </table>
      </div>
      <p v-if="total" class="px-4 py-2 text-xs text-slate-500">接受率＝接受 ÷（接受＋不接受）；待回覆不算分母。</p>
    </UCard>
    <div class="grid grid-cols-1 gap-4 xl:grid-cols-[20rem_1fr]">
      <UCard :padded="false" class="self-start" title="住院中的病人">
        <UQueryState :loading="loading && !data" :ready="!!data?.patients.length" empty-title="沒有住院中的病人">
          <ul class="divide-y divide-slate-100">
            <li v-for="p in data?.patients ?? []" :key="p.admissionId">
              <button type="button" :class="['w-full px-4 py-2 text-left text-sm hover:bg-slate-50', p.admissionId === selId && '!bg-brand-50']" @click="selId = p.admissionId">
                <div class="flex items-center gap-2">
                  <span class="tabular rounded bg-slate-100 px-1.5 text-xs">{{ p.bedNo }}</span>
                  <span class="font-medium text-slate-800">{{ p.patientName }}</span>
                  <UBadge v-if="p.pending" tone="blue" class="ml-auto">待回覆 {{ p.pending }}</UBadge>
                </div>
                <div class="text-xs text-slate-500">{{ p.diagnosis }}・{{ p.meds.length }} 種藥</div>
              </button>
            </li>
          </ul>
        </UQueryState>
      </UCard>
      <UCard v-if="!pt" data-detail><UEmpty title="請從左邊選一位病人" description="看病人用藥，寫建議給主治" /></UCard>
      <div v-else data-detail class="min-w-0 space-y-3">
        <UCard :title="`${pt.patientName}・${pt.bedNo}`" :subtitle="`${pt.diagnosis}・主治 ${pt.attendingName}`">
          <div class="space-y-1 text-sm">
            <div :class="pt.allergies.length ? 'text-red-700' : 'text-slate-500'">過敏：{{ pt.allergies.join('、') || '無已知過敏' }}</div>
            <div class="text-xs text-slate-600">{{ pt.renal }}</div>
            <ul class="list-disc pl-5 text-xs text-slate-700"><li v-for="m in pt.meds" :key="m">{{ m }}</li></ul>
          </div>
        </UCard>
        <UCard title="寫建議">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-[12rem_1fr]">
            <USelect v-model="form.kind" label="類型" required placeholder="請選擇" :options="Object.entries(PHARMCARE_KIND_LABEL).map(([k, l]) => ({ label: l, value: k }))" :error="add.fieldErrors.value.kind" />
            <UTextarea v-model="form.text" label="建議內容" required :rows="2" placeholder="例：CrCl 30，建議 Meropenem 改每 12 小時" :error="add.fieldErrors.value.text" />
          </div>
          <div class="mt-3 text-right"><UButton :icon="Send" :loading="add.pending.value" @click="submit">送出建議</UButton></div>
        </UCard>
        <UCard title="這位病人的紀錄"><PharmCareList :admission-id="pt.admissionId" /></UCard>
      </div>
    </div>
  </div>
</template>
