<script setup lang="ts">
// 急診檢驗（看板的「檢驗」）：急診護理師床邊印條碼（同管合併）、採檢；醫師看已出的報告（看過看板的「新報告」就清掉）。
// 不經抽血櫃台、不用先批價。服務層 er-lab.ts
import { computed, ref, watch } from 'vue'
import { Printer, Syringe } from 'lucide-vue-next'
import { UBadge, UButton, UDialog } from '@/components/ui'
import Barcode39 from '@/components/Barcode39.vue'
import { erLabApi, TUBE_COLOR, type ErSpecimenView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ visitId: string }>()
const open = defineModel<boolean>({ required: true })
const { data } = useQuery(async () => (open.value && props.visitId ? erLabApi.erLabs(props.visitId) : undefined), [() => props.visitId, open])
const labels = ref<ErSpecimenView[]>()
const print = useAction(erLabApi.printErLabels, { success: (xs) => `已印 ${xs.length} 支條碼` })
async function onPrint() {
  const xs = await print.run(props.visitId)
  if (xs) labels.value = xs
}
const collect = useAction(erLabApi.collectErSpecimen, { success: (s) => `已採檢 ${s.barcode}，送檢驗科` })
const seen = useAction(erLabApi.markErLabsSeen)
// 醫師打開、有新報告：記為看過（看板的「新報告」清掉）
watch(data, (d) => {
  if (d?.canSee && d.reports.some((r) => r.fresh)) seen.run(props.visitId)
})
const TONE: Record<string, 'blue' | 'yellow' | 'green' | 'red'> = { printed: 'blue', collected: 'yellow', received: 'green', rejected: 'red' }
const tubeColor = (t: string) => TUBE_COLOR[t as keyof typeof TUBE_COLOR]
const title = computed(() => (data.value ? `急診檢驗：${data.value.patientName}（${data.value.chartNo}）` : '急診檢驗'))
</script>

<template>
  <UDialog v-model="open" :title="title" size="lg">
    <div v-if="data" class="space-y-4 text-sm">
      <section v-if="data.toPrint.length" class="space-y-1">
        <div class="flex items-center gap-2"><b>待採檢</b><UButton v-if="data.canCollect" size="sm" class="ml-auto" :icon="Printer" :loading="print.pending.value" @click="onPrint">印條碼</UButton></div>
        <ul class="space-y-0.5 text-xs text-slate-700">
          <li v-for="g in data.toPrint" :key="g.tube" class="flex items-center gap-2"><span :class="['h-3 w-3 rounded-full', tubeColor(g.tube)]" />{{ g.tubeLabel }}：{{ g.tests.join('、') }}</li>
        </ul>
        <p v-if="!data.canCollect" class="text-xs text-slate-500">急診護理師床邊印條碼採檢</p>
      </section>
      <section v-if="data.specimens.length" class="space-y-1">
        <b>檢體</b>
        <ul class="space-y-1 text-xs">
          <li v-for="s in data.specimens" :key="s.id" class="flex flex-wrap items-center gap-2">
            <span :class="['h-3 w-3 rounded-full', tubeColor(s.tube)]" /><span class="tabular">{{ s.barcode }}</span><span class="min-w-0 flex-1">{{ s.tests.join('、') }}</span>
            <UBadge :tone="TONE[s.stage] ?? 'gray'">{{ s.stageLabel }}{{ s.rejectedReason ? `：${s.rejectedReason}` : '' }}</UBadge>
            <UButton v-if="data.canCollect && s.stage === 'printed'" size="sm" variant="secondary" :icon="Syringe" :loading="collect.pending.value" @click="collect.run(s.barcode)">採檢</UButton>
          </li>
        </ul>
      </section>
      <section class="space-y-1">
        <b>報告</b>
        <p v-if="!data.reports.length" class="text-xs text-slate-400">還沒有報告</p>
        <ul v-else class="space-y-1">
          <li v-for="r in data.reports" :key="r.id" :class="['rounded border px-2 py-1 text-xs', r.critical ? 'border-red-300 bg-red-50' : r.abnormal ? 'border-amber-200 bg-amber-50' : 'border-slate-200']">
            <div class="flex flex-wrap items-center gap-2"><b>{{ r.procName }}</b><span class="tabular text-slate-500">{{ r.reportedAt.slice(11) }} 發出</span>
              <UBadge v-if="r.critical" tone="red">危急值</UBadge><UBadge v-if="r.fresh" tone="blue">新報告</UBadge></div>
            <div class="text-slate-700">{{ r.text }}</div>
          </li>
        </ul>
      </section>
      <div v-if="labels" class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div v-for="s in labels" :key="s.id" class="rounded border border-slate-800 p-2 text-xs">
          <div class="flex items-center gap-2"><span :class="['h-3 w-6 rounded', tubeColor(s.tube)]" /><b>{{ s.tubeLabel }}</b><span class="ml-auto">急診</span></div>
          <div><b>{{ data.patientName }}</b>・{{ data.chartNo }}</div>
          <div class="flex justify-center"><Barcode39 :value="s.barcode" :height="30" /></div>
          <div>{{ s.tests.join('、') }}</div>
        </div>
      </div>
    </div>
    <template #footer><UButton variant="secondary" @click="open = false">關閉</UButton></template>
  </UDialog>
</template>
