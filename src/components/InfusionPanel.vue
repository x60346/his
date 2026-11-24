<script setup lang="ts">
// 點滴（護理站病人分頁「點滴」；醫師在住院醫囑也看得到）：每張點滴醫囑一張卡——正在滴第幾瓶、已滴入多少、預計幾點滴完（快到黃、過了紅）、
// 調過的流速；接上（勾留置針通暢）、換瓶（可修正實際量）、調流速（要原因）、停止。醫囑已停止但還在滴的另外列出來請停止
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { INFUSION_RATE_REASONS, infusionApi, vasoDose, type InfusionView, type VasoDef } from '@/services'
// 升壓劑：流速換算劑量（和服務層同一個公式）
const doseAt = (x: InfusionView, rate: number | undefined) => {
  const vs = x.vaso
  if (!vs || rate === undefined || rate === null || Number.isNaN(Number(rate))) return undefined
  return vasoDose({ unit: vs.unit, perMl: vs.perMl } as VasoDef, Number(rate), vs.weightKg)
}
const VASO_REASONS = ['MAP 低於目標，調升', 'MAP 高於目標，調降', '逐步調降準備停藥', '依醫師口頭指示']
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ admissionId: string }>()
const { data, loading, reload } = useQuery(() => infusionApi.patientInfusions(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const stateTone = { ok: 'blue', due: 'yellow', overdue: 'red' } as const

// 接上／換瓶（勾通暢；換瓶可修正上一瓶實際量）
const bag = ref<{ x: InfusionView; change: boolean }>()
const bagOpen = computed({ get: () => !!bag.value, set: (y) => !y && (bag.value = undefined) })
const bf = reactive({ patency: false, infusedMl: undefined as number | undefined })
function openBag(x: InfusionView, change: boolean) {
  Object.assign(bf, { patency: false, infusedMl: change ? x.running?.infused : undefined })
  start.fieldErrors.value = {}
  chg.fieldErrors.value = {}
  bag.value = { x, change }
}
const start = useAction(infusionApi.startInfusion, { success: '已接上點滴' })
const chg = useAction(infusionApi.changeBag, { success: '已換瓶' })
async function submitBag() {
  const b = bag.value
  if (!b) return
  const ok = b.change ? await chg.run(b.x.order.id, { patency: bf.patency, infusedMl: bf.infusedMl === undefined || (bf.infusedMl as unknown) === '' ? undefined : Number(bf.infusedMl) }) : await start.run(b.x.order.id, { patency: bf.patency })
  if (ok) {
    bag.value = undefined
    reload()
  }
}
const err = computed(() => (bag.value?.change ? chg.fieldErrors.value : start.fieldErrors.value))

// 調流速
const rate = ref<InfusionView>()
const rateOpen = computed({ get: () => !!rate.value, set: (y) => !y && (rate.value = undefined) })
const rf = reactive({ rateMlH: undefined as number | undefined, reason: '' })
const adj = useAction(infusionApi.adjustRate, { success: '已調整流速，換瓶時間重算' })
async function submitRate() {
  if (rate.value && (await adj.run(rate.value.order.id, { rateMlH: Number(rf.rateMlH), reason: rf.reason }))) {
    rate.value = undefined
    reload()
  }
}
// 停止
const stopFor = ref<InfusionView>()
const stop = useAction(infusionApi.stopInfusion, { success: '已停止點滴' })
async function onStop(reason: string) {
  if (stopFor.value && (await stop.run(stopFor.value.order.id, { reason }))) {
    stopFor.value = undefined
    reload()
  }
}
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <UQueryState :loading="loading && !v" :ready="!!v">
      <template v-if="v">
        <p v-if="!v.items.length && !v.orphans.length" class="rounded-md border border-slate-200 px-3 py-4 text-center text-slate-400">沒有點滴醫囑（醫師在住院醫囑開給藥 → 勾「點滴」）</p>
        <p v-if="v.canNurse && !v.hasIvLine && v.items.length" class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">病人沒有周邊留置針或 CVC：接上前請先放置並在「管路」登錄。</p>
        <section v-for="x in [...v.items, ...v.orphans]" :key="x.order.id" class="space-y-1.5 rounded-md border border-slate-200 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <b class="text-slate-800">{{ x.order.content }}</b>
            <UBadge v-if="x.order.status !== 'active'" tone="red">醫囑已停止：請停止</UBadge>
            <UBadge v-if="x.vaso" tone="purple" class="tabular">升壓劑 {{ x.vaso.dose }} {{ x.vaso.unit }}（上限 {{ x.vaso.max }}）・目標 {{ x.vaso.target }}</UBadge>
            <span class="text-xs text-slate-500">{{ x.order.doctorName }}・一瓶約 {{ x.hoursPerBag }} 小時</span>
          </div>
          <template v-if="x.running">
            <div class="flex flex-wrap items-center gap-2">
              <span>第 {{ x.running.bagNo }} 瓶・{{ x.running.startAt.slice(5) }} 接上（{{ x.running.startByName }}）・目前 {{ x.running.rateMlH }} ml/h</span>
              <UBadge :tone="stateTone[x.running.state]">預計 {{ x.running.endAt.slice(5) }} 滴完{{ x.running.state === 'overdue' ? '（已滴完）' : x.running.state === 'due' ? '（快滴完）' : '' }}</UBadge>
            </div>
            <div class="h-2 overflow-hidden rounded bg-slate-100"><div class="h-full bg-sky-500" :style="{ width: `${Math.round((x.running.infused / (x.order.infusion?.volumeMl ?? 1)) * 100)}%` }" /></div>
            <p class="tabular text-xs text-slate-500">已滴入約 {{ x.running.infused }}／{{ x.order.infusion?.volumeMl }} ml</p>
            <ul v-if="x.running.changes.length" class="text-xs text-slate-600"><li v-for="c in x.running.changes" :key="c">{{ c }}</li></ul>
          </template>
          <p v-else-if="x.order.status === 'active'" class="text-xs text-amber-800">還沒接上</p>
          <div v-if="v.canNurse" class="flex flex-wrap gap-1.5">
            <UButton v-if="!x.running && x.order.status === 'active'" size="sm" @click="openBag(x, false)">接上</UButton>
            <template v-if="x.running">
              <UButton v-if="x.order.status === 'active'" size="sm" :variant="x.running.state === 'ok' ? 'secondary' : 'primary'" @click="openBag(x, true)">換瓶</UButton>
              <UButton v-if="x.order.status === 'active'" size="sm" variant="secondary" @click="(rf.rateMlH = x.running.rateMlH), (rf.reason = ''), (adj.fieldErrors.value = {}), (rate = x)">調流速</UButton>
              <UButton size="sm" variant="ghost" @click="stopFor = x">停止</UButton>
            </template>
          </div>
          <details v-if="x.history.length" class="text-xs text-slate-600">
            <summary class="cursor-pointer">之前 {{ x.history.length }} 瓶</summary>
            <ul><li v-for="h in x.history" :key="h.bagNo">第 {{ h.bagNo }} 瓶 {{ h.startAt.slice(5) }} → {{ h.endAt.slice(5) }}・{{ h.infused }} ml・{{ h.reason }}（{{ h.byName }}）</li></ul>
          </details>
        </section>
      </template>
    </UQueryState>

    <UDialog v-model="bagOpen" :title="bag?.change ? '換瓶' : '接上點滴'" size="sm" @submit="submitBag">
      <div class="space-y-3 text-sm">
        <p class="text-slate-700">{{ bag?.x.order.content }}</p>
        <UInput v-if="bag?.change" v-model="bf.infusedMl" type="number" label="上一瓶實際輸入量 ml（依流速估算，可修正）" :error="err.infusedMl" />
        <UCheckbox v-model="bf.patency" label="留置針通暢（有回血、注射部位沒有腫脹、推注沒有阻力）" />
        <p v-if="err.patency" class="text-xs text-red-600">{{ err.patency }}</p>
        <p class="text-xs text-slate-500">接上會扣一瓶（加藥一起扣），進住院帳單。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="bagOpen = false">取消</UButton>
        <UButton type="submit" :loading="start.pending.value || chg.pending.value">{{ bag?.change ? '換瓶' : '接上' }}</UButton>
      </template>
    </UDialog>

    <UDialog v-model="rateOpen" title="調流速" size="sm" @submit="submitRate">
      <div class="space-y-3 text-sm">
        <UInput v-model="rf.rateMlH" type="number" step="any" label="新的流速 ml/小時" :error="adj.fieldErrors.value.rateMlH" :hint="rate?.vaso && doseAt(rate, rf.rateMlH) !== undefined ? `換算 ${doseAt(rate, rf.rateMlH)} ${rate.vaso.unit}（上限 ${rate.vaso.max}）` : undefined" />
        <UInput v-model="rf.reason" label="原因" required :error="adj.fieldErrors.value.reason" />
        <div class="flex flex-wrap gap-1"><button v-for="r in rate?.vaso ? VASO_REASONS : INFUSION_RATE_REASONS" :key="r" type="button" class="rounded border border-slate-300 px-1.5 text-xs hover:bg-slate-100" @click="rf.reason = r">{{ r }}</button></div>
        <p class="text-xs text-slate-500">醫師要改醫囑上的流速請開新的醫囑；這裡是護理師依病人狀況臨時調整（留紀錄）。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="rateOpen = false">取消</UButton>
        <UButton type="submit" :loading="adj.pending.value">調整</UButton>
      </template>
    </UDialog>

    <ReasonDialog :model-value="!!stopFor" title="停止點滴" label="原因" ok-text="停止點滴" danger :presets="['醫囑停止', '病人可以進食、不需要了', '留置針阻塞或滲漏', '出院']" :pending="stop.pending.value" :error="stop.fieldErrors.value.reason" @update:model-value="(y: boolean) => !y && (stopFor = undefined)" @confirm="onStop" />
  </div>
</template>
