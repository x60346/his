<script setup lang="ts">
// 掛號單（對話框預覽＋列印）：掛完號交給病人，上面寫著去哪一間、第幾號、大概要付多少。
// 寬 80 mm（櫃台熱感應出單機的寬度）；外層 print-area，列印時只印這一張（見 style.css）。
// 病歷號條碼：掃描器＝打字＋Enter，批價、掛號的搜尋框掃了就直接選到這位病人。
import { HOSPITAL } from '@/utils/hospital'
import { computed, nextTick, ref } from 'vue'
import { Printer } from 'lucide-vue-next'
import { UButton, UDialog } from '@/components/ui'
import Barcode39 from './Barcode39.vue'
import { bookingApi, preventApi, type VisitView } from '@/services'
import { useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { now, periodLabel, toRoc, weekdayLabel } from '@/utils/date'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ visit?: VisitView }>()
const auth = useAuth()

// 預估應收：與掛號頁同一個 estimateFee（實際掛進去的身分、案件分類）
const { data: estimate } = useQuery(async () => (open.value && props.visit ? bookingApi.estimateFee(props.visit.identityCode, props.visit.caseType, false, props.visit.date) : undefined), [open, () => props.visit?.id])
const { data: items } = useQuery(async () => (open.value && props.visit?.preventItems.length ? preventApi.listPreventItems() : []), [open, () => props.visit?.id])
const preventNames = computed(() => (props.visit?.preventItems ?? []).map((c) => items.value?.find((i) => i.code === c)?.name ?? c))

const printedAt = ref('')
async function print() {
  printedAt.value = now()
  await nextTick() // 列印時間在按下那一刻取值
  window.print()
}
</script>

<template>
  <UDialog v-model="open" title="掛號單" size="sm">
    <div v-if="visit" class="print-area mx-auto w-[80mm] max-w-full bg-white p-3 font-sans text-[13px] leading-snug text-black">
      <header class="border-b border-dashed border-black pb-1.5 text-center">
        <div class="text-base font-bold">{{ HOSPITAL.name }}</div>
        <div class="text-xs">門診掛號單（展示用）</div>
      </header>

      <div class="mt-2 text-center">
        <div class="tabular">{{ toRoc(visit.date) }}（{{ weekdayLabel(visit.date) }}）{{ periodLabel[visit.period] }}</div>
        <div class="text-base font-semibold">{{ visit.deptName }}・{{ visit.doctorName }}</div>
        <div><b class="tabular">{{ visit.roomNo }}</b> 診<template v-if="visit.roomLocation">（{{ visit.roomLocation }}）</template></div>
        <div class="mt-1 text-xs">看診號</div>
        <div class="tabular text-5xl font-bold leading-none">{{ visit.seqNo }}</div>
      </div>

      <dl class="mt-2 grid grid-cols-[4.5em_1fr] gap-x-1 border-t border-dashed border-black pt-1.5">
        <dt>姓名</dt><dd class="font-semibold">{{ visit.patientName }}<span v-if="visit.firstVisit" class="ml-1 rounded border border-black px-1 text-[11px]">初診</span></dd>
        <dt>病歷號</dt><dd class="tabular">{{ visit.chartNo }}</dd>
        <dt>身分</dt><dd>{{ visit.identityName }}・案件 {{ visit.caseType }}</dd>
        <dt>就醫序號</dt><dd class="tabular">{{ visit.cardSeq }}</dd>
        <template v-if="preventNames.length"><dt>預防保健</dt><dd>{{ preventNames.join('、') }}</dd></template>
        <template v-if="estimate"><dt>預估應收</dt><dd><b class="tabular">{{ estimate.total }}</b> 元起<span class="text-[11px]">（藥費看診後才確定）</span></dd></template>
      </dl>

      <div class="mt-2 flex justify-center"><Barcode39 :value="visit.chartNo" :height="36" /></div>

      <p class="mt-1.5 border-t border-dashed border-black pt-1.5 text-[11px]">請於叫號前至診間外候診；過號請洽診間護理師。看診後請至批價櫃台結帳。</p>
      <footer class="mt-1 flex justify-between text-[10px]">
        <span>{{ auth.user?.name }}</span>
        <span class="tabular">{{ printedAt ? `列印 ${printedAt.slice(5)}` : `掛號 ${visit.createdAt.slice(5)}` }}</span>
      </footer>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">關閉</UButton>
      <UButton :icon="Printer" @click="print">列印</UButton>
    </template>
  </UDialog>
</template>
