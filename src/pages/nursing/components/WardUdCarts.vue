<script setup lang="ts">
// 藥車待點收（全病房）：藥局核對送出的 UD 藥盒，藥車到病房後逐盒點收。
// 勾了哪幾盒就點收哪幾盒（畫面上看得到的）；有問題的那盒按「不符」寫原因，藥局 UD 頁會出現「病房回報」。
// 點收前照樣可以給藥（給藥列標「藥車未點收」）——不能因為少按一個鍵延誤病人用藥。
import { computed, reactive, ref } from 'vue'
import { AlertTriangle, PackageCheck, Truck } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, USelect } from '@/components/ui'
import { UD_ISSUE_CAUSES, udApi, type UdCart } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ ward: string }>()
const { data } = useQuery(async () => ({ ward: props.ward, r: await udApi.listWardUdCarts(props.ward) }), [() => props.ward])
const carts = computed(() => (data.value?.ward === props.ward ? data.value.r.carts : []))
const issues = computed(() => (data.value?.ward === props.ward ? data.value.r.issues : []))
const md = (s: string) => s.slice(5, 16).replace('-', '/')

const picked = reactive<Record<string, boolean>>({})
const key = (c: UdCart, admissionId: string) => `${c.dispenseId}|${admissionId}`
const chosenOf = (c: UdCart) => c.boxes.filter((b) => picked[key(c, b.admissionId)]).map((b) => b.admissionId)
const allOn = (c: UdCart) => c.boxes.every((b) => picked[key(c, b.admissionId)])
const setAll = (c: UdCart, v: boolean) => c.boxes.forEach((b) => (picked[key(c, b.admissionId)] = v))

const receive = useAction(udApi.receiveUdBoxes, { success: (r) => `已點收 ${r.no}：${r.boxes} 盒` })
async function onReceive(c: UdCart) {
  const ids = chosenOf(c)
  if (await receive.run(c.dispenseId, ids)) for (const id of ids) delete picked[key(c, id)]
}

// ---------- 不符 ----------
const reporting = ref<{ cart: UdCart; admissionId: string; label: string } | null>(null)
const reportOpen = computed({ get: () => !!reporting.value, set: (v) => !v && (reporting.value = null) })
const form = reactive({ cause: '' as string | number | undefined, note: '' })
function openReport(c: UdCart, b: UdCart['boxes'][number]) {
  Object.assign(form, { cause: '', note: '' })
  report.fieldErrors.value = {}
  reporting.value = { cart: c, admissionId: b.admissionId, label: `${b.bedNo} ${b.patientName}・${c.no}` }
}
const report = useAction(udApi.reportUdBox, { success: (r) => `已回報藥局：${r.no}` })
async function onReport() {
  const x = reporting.value
  if (!x) return
  if (await report.run(x.cart.dispenseId, x.admissionId, { cause: String(form.cause ?? ''), note: form.note })) {
    delete picked[key(x.cart, x.admissionId)]
    reporting.value = null
  }
}
</script>

<template>
  <section v-for="c in carts" :key="c.dispenseId" class="mb-4 rounded-md border border-sky-300 bg-sky-50/60 p-3">
    <div class="mb-2 flex flex-wrap items-center gap-2 text-sm">
      <Truck class="h-4 w-4 text-sky-700" />
      <span class="font-semibold text-sky-900">藥車待點收・{{ c.no }}（{{ c.boxes.length }} 盒）</span>
      <span class="text-xs text-sky-800">{{ c.kind === 'daily' ? '每日調劑' : '補調劑' }}・{{ md(c.sentAt) }} 送出；逐盒對床號、姓名再勾，有問題的按「不符」</span>
      <UButton size="sm" class="ml-auto" :icon="PackageCheck" :disabled="!chosenOf(c).length" :loading="receive.pending.value" @click="onReceive(c)">點收（{{ chosenOf(c).length }}）</UButton>
    </div>
    <UCheckbox :model-value="allOn(c)" class="mb-1 text-xs" @update:model-value="(v: boolean) => setAll(c, v)">全選</UCheckbox>
    <ul class="divide-y divide-sky-100 rounded border border-sky-200 bg-white">
      <li v-for="b in c.boxes" :key="b.admissionId" class="flex flex-wrap items-center gap-3 px-3 py-1.5 text-sm">
        <UCheckbox v-model="picked[key(c, b.admissionId)]" :aria-label="`點收 ${b.bedNo} ${b.patientName}`" />
        <span class="tabular w-12 text-xs font-semibold text-slate-600">{{ b.bedNo }}</span>
        <span class="min-w-0 flex-1">
          <span class="font-medium text-slate-800">{{ b.patientName }}</span>
          <span class="block text-xs text-slate-500">{{ b.items.join('、') || '（這次不發藥：床邊已有）' }}・{{ b.verifiedByName }} 核對</span>
        </span>
        <UButton size="sm" variant="ghost" :icon="AlertTriangle" @click="openReport(c, b)">不符</UButton>
      </li>
    </ul>
  </section>
  <section v-if="issues.length" class="mb-4 rounded-md border border-red-200 bg-red-50/60 p-3 text-sm">
    <div class="mb-1 flex items-center gap-2 font-semibold text-red-800"><AlertTriangle class="h-4 w-4" />已回報藥局、處理中（{{ issues.length }} 盒）</div>
    <ul class="space-y-0.5 text-xs text-red-900">
      <li v-for="i in issues" :key="`${i.dispenseId}|${i.admissionId}`">
        <span class="tabular font-semibold">{{ i.bedNo }}</span> {{ i.patientName }}・{{ i.no }}：<UBadge tone="red">{{ i.cause }}</UBadge> {{ i.note }}（{{ i.reportedByName }} {{ md(i.reportedAt) }}）
      </li>
    </ul>
  </section>

  <UDialog v-model="reportOpen" title="藥盒不符" size="sm" @submit="onReport">
    <div v-if="reporting" class="space-y-3 text-sm">
      <p class="font-medium text-slate-800">{{ reporting.label }}</p>
      <USelect v-model="form.cause" label="原因" required placeholder="請選擇" :options="UD_ISSUE_CAUSES.map((x) => ({ label: x, value: x }))" :error="report.fieldErrors.value.cause" />
      <UInput v-model="form.note" :label="form.cause === '其他' ? '說明' : '說明（選填）'" :required="form.cause === '其他'" placeholder="例：少一顆 Metformin、藥袋破損" :error="report.fieldErrors.value.note" />
      <p class="text-xs text-slate-500">回報後這一盒算已到病房，藥局 UD 頁會出現「病房回報」由藥師處理（需要時補發）；給藥列標「藥盒不符」直到藥局處理完。</p>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="reporting = null">取消</UButton>
      <UButton type="submit" variant="danger" :loading="report.pending.value">回報藥局</UButton>
    </template>
  </UDialog>
</template>
