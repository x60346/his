<script setup lang="ts">
// 住院檢體（護理站、住院醫囑的病人分頁「檢體」）：還沒印條碼的檢驗醫囑（依容器合併，會印成幾支）→「印條碼」（標籤：條碼、病人、
// 床號、項目、容器顏色）→ 採檢（掃條碼或按「採檢」）→ 等檢驗科收件；被退件的列出原因，醫囑回到待印條碼，重新印、重新採。
// 醫師只能看。規則在服務層 specimen.ts
import { computed, ref } from 'vue'
import { Printer, ScanLine } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UQueryState } from '@/components/ui'
import Barcode39 from '@/components/Barcode39.vue'
import { specimenApi, TUBE_COLOR, type SpecimenView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'

const props = defineProps<{ admissionId: string }>()
const auth = useAuth()
const isNurse = computed(() => auth.user?.role === 'nurse')
const { data, loading } = useQuery(() => specimenApi.wardSpecimens(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))

const labels = ref<SpecimenView[]>()
const print = useAction(specimenApi.printSpecimenLabels, { success: (xs) => `已產生 ${xs.length} 支條碼標籤` })
async function onPrint() {
  const xs = await print.run(props.admissionId)
  if (xs) labels.value = xs
}
const doPrint = () => window.print()
const code = ref('')
const collect = useAction(specimenApi.collectSpecimen, { success: (s) => `已採檢 ${s.barcode}：${s.tests.join('、')}，送檢驗科` })
async function onScan() {
  if (code.value.trim() && (await collect.run(code.value.trim()))) code.value = ''
}
</script>

<template>
  <UQueryState :loading="loading && !v" :ready="!!v">
    <div v-if="v" class="space-y-3 text-sm">
      <div v-if="v.recollect.length" class="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-900" role="alert">
        <b>檢體被退件，請重新採檢：</b>
        <span v-for="(s, i) in v.recollect" :key="s.id">{{ i ? '；' : '' }}{{ s.tests.join('、') }}（{{ s.rejected?.reason }}，{{ s.rejectedByName }} {{ s.rejected?.at.slice(11) }}）</span>
      </div>

      <section>
        <div class="mb-1 flex items-center gap-2">
          <h4 class="font-semibold text-slate-700">待印條碼</h4>
          <UButton v-if="isNurse && (v.toPrint.length || v.printed.length)" size="sm" class="ml-auto" :icon="Printer" :loading="print.pending.value" @click="onPrint">印條碼{{ v.printed.length && !v.toPrint.length ? '（重印）' : '' }}</UButton>
        </div>
        <p v-if="!v.toPrint.length" class="text-xs text-slate-400">沒有還沒印條碼的檢驗</p>
        <ul v-else class="space-y-1">
          <li v-for="g in v.toPrint" :key="g.tube" class="flex flex-wrap items-center gap-2"><span :class="['h-3 w-3 rounded-full', TUBE_COLOR[g.tube as keyof typeof TUBE_COLOR]]" />{{ g.tubeLabel }}：{{ g.orders.map((o) => o.content).join('、') }}<span class="text-xs text-slate-500">（一支）</span></li>
        </ul>
      </section>

      <section>
        <h4 class="mb-1 font-semibold text-slate-700">待採檢（已印條碼）</h4>
        <form v-if="isNurse && v.printed.length" class="mb-2 flex items-end gap-2" @submit.prevent="onScan">
          <UInput v-model="code" class="flex-1" label="掃條碼採檢" placeholder="S2026…" />
          <UButton type="submit" size="sm" :icon="ScanLine" :loading="collect.pending.value">採檢</UButton>
        </form>
        <p v-if="!v.printed.length" class="text-xs text-slate-400">沒有</p>
        <ul v-else class="divide-y divide-slate-100 rounded border border-slate-200">
          <li v-for="s in v.printed" :key="s.id" class="flex flex-wrap items-center gap-2 px-2 py-1.5">
            <span :class="['h-3 w-3 rounded-full', TUBE_COLOR[s.tube]]" /><span class="tabular text-xs">{{ s.barcode }}</span><span class="min-w-0 flex-1">{{ s.tests.join('、') }}</span>
            <UButton v-if="isNurse" size="sm" variant="secondary" :loading="collect.pending.value" @click="collect.run(s.barcode)">採檢</UButton>
          </li>
        </ul>
      </section>

      <section v-if="v.waiting.length || v.received.length">
        <h4 class="mb-1 font-semibold text-slate-700">已採檢</h4>
        <ul class="divide-y divide-slate-100 rounded border border-slate-200">
          <li v-for="s in [...v.waiting, ...v.received]" :key="s.id" class="flex flex-wrap items-center gap-2 px-2 py-1.5">
            <span :class="['h-3 w-3 rounded-full', TUBE_COLOR[s.tube]]" /><span class="tabular text-xs">{{ s.barcode }}</span><span class="min-w-0 flex-1">{{ s.tests.join('、') }}</span>
            <span class="tabular text-xs text-slate-500">採檢 {{ s.collectedAt?.slice(11) }} {{ s.collectedByName }}</span>
            <UBadge :tone="s.stage === 'received' ? 'green' : s.late ? 'red' : 'yellow'">{{ s.stage === 'received' ? '已收件' : s.late ? '待收件・逾時' : '待收件' }}</UBadge>
          </li>
        </ul>
      </section>
    </div>
  </UQueryState>

  <UDialog :model-value="!!labels" title="檢體條碼標籤" size="lg" @update:model-value="(x: boolean) => !x && (labels = undefined)">
    <div class="print-area grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div v-for="s in labels ?? []" :key="s.id" class="rounded border border-slate-800 p-2 text-xs">
        <div class="flex items-center gap-2"><span :class="['h-3 w-6 rounded', TUBE_COLOR[s.tube]]" /><b>{{ s.tubeLabel }}</b><span class="ml-auto">{{ s.bedNo }}</span></div>
        <div class="mt-1"><b>{{ s.patientName }}</b>・病歷號 {{ s.chartNo }}</div>
        <div class="flex justify-center"><Barcode39 :value="s.barcode" :height="34" /></div>
        <div class="tabular text-center">{{ s.barcode }}</div>
        <div class="mt-1">{{ s.tests.join('、') }}</div>
      </div>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="labels = undefined">關閉</UButton>
      <UButton :icon="Printer" @click="doPrint">列印標籤</UButton>
    </template>
  </UDialog>
</template>
