<script setup lang="ts">
// 藥車簽收單（隨藥車送到病房的紙本）：一個病房一張（列印時分頁），依床號列出每位病人的藥盒內容與核對藥師，
// 下方送藥人、病房點收人簽名欄。病房已在系統點收的，印出系統記錄的點收人與時間。資料由服務層 ud.udCartSheet 整理。
import { Printer } from 'lucide-vue-next'
import { UButton, UDialog, UQueryState } from '@/components/ui'
import { udApi } from '@/services'
import { useQuery } from '@/composables/useService'
import { HOSPITAL } from '@/utils/hospital'

const props = defineProps<{ dispenseId?: string }>()
const open = defineModel<boolean>({ default: false })
const { data, loading } = useQuery(async () => (open.value && props.dispenseId ? udApi.udCartSheet(props.dispenseId) : undefined), [open, () => props.dispenseId])
const print = () => window.print()
const when = (s: string) => s.slice(5, 16).replace('-', '/')
</script>

<template>
  <UDialog v-model="open" title="藥車簽收單" size="lg">
    <UQueryState :loading="loading && !data" :ready="!!data" empty-title="找不到調劑單">
      <div v-if="data" class="print-area space-y-4">
        <article v-for="w in data.wards" :key="w.ward" class="break-after-page rounded-md border-2 border-slate-800 p-4 text-sm text-slate-900 last:break-after-auto">
          <header class="border-b-2 border-slate-800 pb-2">
            <div class="flex items-baseline justify-between">
              <span class="font-bold">{{ HOSPITAL.name }} 住院藥局</span>
              <span class="tabular text-xs">{{ data.no }}・{{ data.kind === 'daily' ? '每日調劑' : '補調劑' }}</span>
            </div>
            <div class="text-lg font-bold tracking-wider">藥車簽收單・{{ w.ward }}</div>
            <div class="text-xs text-slate-600">調劑 {{ data.dispensedByName }} {{ when(data.dispensedAt) }}・共 {{ w.boxes.length }} 盒</div>
          </header>
          <table class="tabular mt-2 w-full border-collapse">
            <thead class="whitespace-nowrap text-xs">
              <tr class="border-b border-slate-800">
                <th class="py-1 text-left">床號・病人</th>
                <th class="px-2 text-left">藥品</th>
                <th class="px-2 text-right">數量</th>
                <th class="px-2 text-right">劑數</th>
                <th class="pl-2 text-left">核對</th>
                <th class="pl-2 text-center">點收</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="b in w.boxes" :key="b.bedNo">
                <tr v-for="(l, i) in b.lines" :key="i" :class="['align-top', i === b.lines.length - 1 && 'border-b border-slate-300']">
                  <td v-if="i === 0" :rowspan="b.lines.length" class="whitespace-nowrap py-1 pr-2"><b>{{ b.bedNo }}</b> {{ b.patientName }}<div class="text-xs text-slate-600">{{ b.chartNo }}</div></td>
                  <td class="px-2 py-1">{{ l.drugName }}<span class="ml-1 text-xs text-slate-500">{{ l.spec }}</span></td>
                  <td class="whitespace-nowrap px-2 py-1 text-right">{{ l.qty }} {{ l.unit }}</td>
                  <td class="px-2 py-1 text-right">{{ l.doses }}</td>
                  <td v-if="i === 0" :rowspan="b.lines.length" class="whitespace-nowrap py-1 pl-2 text-xs">{{ b.verifiedByName }}<div>{{ when(b.verifiedAt) }}</div></td>
                  <td v-if="i === 0" :rowspan="b.lines.length" class="whitespace-nowrap py-1 pl-2 text-center text-xs">
                    <template v-if="b.receivedAt">{{ b.receivedByName }}<div>{{ when(b.receivedAt) }}</div></template>
                    <span v-else class="inline-block h-4 w-4 border border-slate-600" aria-label="勾選點收"></span>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          <footer class="mt-6 grid grid-cols-3 gap-4 text-sm">
            <div>送藥人：<span class="inline-block w-24 border-b border-slate-600">&nbsp;</span></div>
            <div>病房點收人：<span class="inline-block w-24 border-b border-slate-600">&nbsp;</span></div>
            <div>時間：<span class="inline-block w-24 border-b border-slate-600">&nbsp;</span></div>
          </footer>
          <p class="mt-2 text-xs text-slate-500">點收請以系統「藥車待點收」為準；有短少、破損、不是這位病人的，在系統按「不符」回報。</p>
        </article>
      </div>
    </UQueryState>
    <template #footer>
      <UButton variant="secondary" @click="open = false">關閉</UButton>
      <UButton :icon="Printer" :disabled="!data" @click="print">列印</UButton>
    </template>
  </UDialog>
</template>
