<script setup lang="ts">
// 重症流程表（加護病房；護理站病人分頁「重症流程表」、住院醫囑分頁「重症流程表」唯讀）：
// 每小時一欄（00–23 時，依大夜／白班／小夜分三段），一列一個項目；最下面是各班與 24 小時的輸入輸出平衡。
// 輸入量＝護理師記的（口服等）＋點滴（依流速自動算）＋管灌，點滴不用再記一次。
// 流程表的數值就是生命徵象：生命徵象分頁、趨勢圖、本班未量都算得到
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { UBadge, UButton, UInput, UQueryState, USelect, UTextarea } from '@/components/ui'
import { GCS_LABEL, GCS_MAX, HOURLY_LATE_MIN, icuApi, isAbnormal, MAP_LOW, PAIN_ACT_FROM, PAIN_ACTIONS, PUPIL_LIGHT_LABEL, PUPIL_LIGHT_SHORT, vitalInputProblem, vitalSpecs, type FlowCell, type VitalKey } from '@/services'
import type { PupilLight } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useNow } from '@/composables/useNow'
import { addDays, today } from '@/utils/date'

const props = defineProps<{ admissionId: string }>()
const date = ref(today())
watch(() => props.admissionId, () => (date.value = today()))
const { data, loading, reload } = useQuery(async () => ({ id: props.admissionId, d: date.value, v: await icuApi.getFlowsheet(props.admissionId, date.value) }), [() => props.admissionId, date])
const fs = computed(() => (data.value?.id === props.admissionId && data.value.d === date.value ? data.value.v : undefined))
// 24 欄放不下：打開（或換病人、換日期）時把「現在這一小時」捲到看得見的地方（過去的日子捲到最右邊），不用護理師自己找
const clock = useNow()
const nowHour = computed(() => clock.value.slice(11, 13))
const scroller = ref<HTMLElement>()
watch(fs, async (v, old) => {
  if (!v || (old && old.admissionId === v.admissionId && old.date === v.date)) return
  await nextTick()
  const el = scroller.value
  if (!el) return
  const cur = el.querySelector<HTMLElement>('[data-now]')
  el.scrollLeft = cur ? cur.offsetLeft - el.clientWidth + cur.offsetWidth * 3 : el.scrollWidth
})

// ---------- 記一筆 ----------
const fields: VitalKey[] = ['temp', 'pulse', 'resp', 'sbp', 'dbp', 'spo2', 'pain', 'intake', 'output']
const blank = () => ({
  v: Object.fromEntries(fields.map((k) => [k, undefined])) as Record<VitalKey, number | undefined>,
  e: undefined as number | string | undefined, vv: undefined as number | string | undefined, m: undefined as number | string | undefined,
  l: undefined as number | undefined, r: undefined as number | undefined, lightL: '' as PupilLight | '', lightR: '' as PupilLight | '',
  painAction: '',
})
const form = reactive(blank())
watch(() => props.admissionId, () => Object.assign(form, blank()))
const needAction = computed(() => form.v.pain !== undefined && Number(form.v.pain) >= PAIN_ACT_FROM)
const save = useAction(icuApi.addFlowsheetEntry, { success: '已記錄流程表' })
const num = (x: number | string | undefined) => (x === undefined || x === '' ? undefined : Number(x))
const liveMap = computed(() => (form.v.sbp !== undefined && form.v.dbp !== undefined ? Math.round((Number(form.v.sbp) + 2 * Number(form.v.dbp)) / 3) : undefined))
const liveGcs = computed(() => (num(form.e) && num(form.vv) && num(form.m) ? num(form.e)! + num(form.vv)! + num(form.m)! : undefined))
async function submit() {
  const g = { e: num(form.e), v: num(form.vv), m: num(form.m) }
  const p = { l: form.l, r: form.r, lightL: form.lightL, lightR: form.lightR }
  if (await save.run({ admissionId: props.admissionId, ...form.v, ...(needAction.value ? { painAction: form.painAction } : {}), gcs: g, pupils: p })) {
    Object.assign(form, blank())
    date.value = today()
    reload()
  }
}
const errorOf = (k: VitalKey) => vitalInputProblem(k, form.v[k]) ?? save.fieldErrors.value[k]
const gcsOpts = (k: 'e' | 'v' | 'm') => [{ label: '—', value: '' }, ...Array.from({ length: GCS_MAX[k] }, (_, i) => ({ label: String(GCS_MAX[k] - i), value: GCS_MAX[k] - i }))]
const lightOpts = [{ label: '—', value: '' }, ...Object.entries(PUPIL_LIGHT_LABEL).map(([value, label]) => ({ label, value }))]

// ---------- 表格 ----------
type Row = { key: string; label: string; show: (c: FlowCell) => string | number | undefined; bad?: (c: FlowCell) => boolean }
const rows: Row[] = [
  { key: 'temp', label: '體溫', show: (c) => c.temp, bad: (c) => isAbnormal('temp', c.temp) },
  { key: 'pulse', label: '心跳', show: (c) => c.pulse, bad: (c) => isAbnormal('pulse', c.pulse) },
  { key: 'resp', label: '呼吸', show: (c) => c.resp, bad: (c) => isAbnormal('resp', c.resp) },
  { key: 'bp', label: '血壓', show: (c) => (c.sbp !== undefined ? `${c.sbp}/${c.dbp ?? '—'}` : undefined), bad: (c) => isAbnormal('sbp', c.sbp) || isAbnormal('dbp', c.dbp) },
  { key: 'map', label: 'MAP', show: (c) => c.map, bad: (c) => c.abnormal.includes('MAP') },
  { key: 'spo2', label: '血氧', show: (c) => c.spo2, bad: (c) => isAbnormal('spo2', c.spo2) },
  { key: 'pain', label: '疼痛', show: (c) => c.pain, bad: (c) => isAbnormal('pain', c.pain) },
  { key: 'gcs', label: 'GCS', show: (c) => (c.gcs ? `${c.gcsSum} E${c.gcs.e}V${c.gcs.v}M${c.gcs.m}` : undefined), bad: (c) => c.abnormal.includes('GCS') },
  { key: 'pupil', label: '瞳孔 左/右', show: (c) => (c.pupils ? `${c.pupils.l}${PUPIL_LIGHT_SHORT[c.pupils.lightL]}/${c.pupils.r}${PUPIL_LIGHT_SHORT[c.pupils.lightR]}` : undefined), bad: (c) => c.abnormal.includes('瞳孔不等大') },
  { key: 'by', label: '記錄', show: (c) => c.nurseName },
]
const sign = (n: number) => (n > 0 ? `+${n}` : String(n))
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <UQueryState :loading="loading && !fs" :ready="!!fs">
      <template v-if="fs">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-semibold text-slate-700">重症流程表</span>
          <span v-if="fs.since" class="text-xs text-slate-500">{{ fs.since.slice(5, 16).replace('-', '/') }} 轉入加護病房</span>
          <template v-if="fs.state">
            <UBadge v-if="fs.state.late" tone="red">{{ fs.state.minutes }} 分鐘沒記（超過 {{ HOURLY_LATE_MIN }} 分鐘）</UBadge>
            <span v-else class="text-xs text-slate-500">{{ fs.state.lastAt ? `上一筆 ${fs.state.lastAt.slice(11)}（${fs.state.minutes} 分鐘前）` : `還沒記（轉入 ${fs.state.minutes} 分鐘）` }}</span>
          </template>
          <span class="ml-auto flex items-center gap-1">
            <UButton size="sm" variant="ghost" :icon="ChevronLeft" aria-label="前一天" @click="date = addDays(date, -1)" />
            <span class="tabular">{{ date.slice(5).replace('-', '/') }}{{ date === today() ? '（今天）' : '' }}</span>
            <UButton size="sm" variant="ghost" :icon="ChevronRight" aria-label="後一天" :disabled="date >= today()" @click="date = addDays(date, 1)" />
          </span>
        </div>
        <p v-if="!fs.inIcu" class="rounded-md bg-slate-50 px-3 py-1.5 text-xs text-slate-600">病人目前不在加護病房：流程表只能看，不能再記（一般病房請記生命徵象）</p>

        <form v-if="fs.canRecord" class="rounded-md border border-slate-200 bg-slate-50 p-3" @submit.prevent="submit">
          <div class="mb-2 flex flex-wrap items-baseline gap-x-3">
            <span class="font-semibold text-slate-700">記一筆（現在）</span>
            <span class="text-xs text-slate-500">輸入量只記口服等；點滴依流速、管灌依紀錄自動算進去</span>
          </div>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-x-3 gap-y-2">
            <UInput v-for="k in fields" :key="k" v-model="form.v[k]" type="number" step="any" :label="vitalSpecs[k].label" :error="errorOf(k)" :hint="k === 'dbp' && liveMap !== undefined ? `MAP ${liveMap}${liveMap < MAP_LOW ? ' ⚠' : ''}` : vitalSpecs[k].unit" :class="!vitalInputProblem(k, form.v[k]) && isAbnormal(k, form.v[k]) && '!border-red-400 !text-red-700'" />
          </div>
          <div class="mt-2 grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-x-3 gap-y-2">
            <div><USelect v-model="form.e" :label="GCS_LABEL.e" :options="gcsOpts('e')" :error="save.fieldErrors.value.gcsE" /></div>
            <div><USelect v-model="form.vv" :label="GCS_LABEL.v" :options="gcsOpts('v')" :error="save.fieldErrors.value.gcsV" /></div>
            <div><USelect v-model="form.m" :label="GCS_LABEL.m" :options="gcsOpts('m')" :error="save.fieldErrors.value.gcsM" :hint="liveGcs ? `總分 ${liveGcs}` : undefined" /></div>
            <UInput v-model="form.l" type="number" step="0.5" label="左瞳孔 mm" :error="save.fieldErrors.value.pupilL" />
            <div><USelect v-model="form.lightL" label="左光反射" :options="lightOpts" :error="save.fieldErrors.value.lightL" /></div>
            <UInput v-model="form.r" type="number" step="0.5" label="右瞳孔 mm" :error="save.fieldErrors.value.pupilR" />
            <div><USelect v-model="form.lightR" label="右光反射" :options="lightOpts" :error="save.fieldErrors.value.lightR" /></div>
          </div>
          <div v-if="needAction" class="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2">
            <UTextarea v-model="form.painAction" :label="`疼痛 ${form.v.pain} 分的處置`" :rows="2" required :error="save.fieldErrors.value.painAction" />
            <div class="mt-1 flex flex-wrap gap-1"><button v-for="x in PAIN_ACTIONS" :key="x" type="button" class="rounded border border-amber-300 bg-white px-1.5 text-xs hover:bg-amber-100" @click="form.painAction = form.painAction ? `${form.painAction}；${x}` : x">{{ x }}</button></div>
          </div>
          <div class="mt-2 text-right"><UButton type="submit" size="sm" :loading="save.pending.value">儲存</UButton></div>
        </form>

        <!-- 24 欄放不下：表格自己橫向捲動，第一欄（項目）固定 -->
        <div ref="scroller" class="overflow-x-auto rounded-md border border-slate-200">
          <table class="tabular w-max min-w-full border-collapse text-xs">
            <thead>
              <tr class="bg-slate-50 text-slate-600">
                <th class="sticky left-0 z-10 bg-slate-50 px-2 py-1 text-left font-medium">時</th>
                <th v-for="h in fs.hours" :key="h.hour" :data-now="fs.date === today() && h.hour === nowHour ? '' : undefined" :class="['w-14 px-1 py-1 text-center font-medium', fs.date === today() && h.hour === nowHour && 'bg-brand-50 text-brand-700', h.hour === '08' || h.hour === '16' ? 'border-l-2 border-slate-300' : 'border-l border-slate-100', h.future && 'text-slate-300']">{{ h.hour }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.key" class="border-t border-slate-100">
                <th class="sticky left-0 z-10 whitespace-nowrap bg-white px-2 py-1 text-left font-medium text-slate-600">{{ r.label }}</th>
                <td v-for="h in fs.hours" :key="h.hour" :class="['px-1 py-1 text-center', h.hour === '08' || h.hour === '16' ? 'border-l-2 border-slate-300' : 'border-l border-slate-100', h.cell && r.bad?.(h.cell) && 'font-semibold text-red-600', r.key === 'by' && 'text-slate-400']" :title="r.key === 'pain' && h.cell?.painAction ? h.cell.painAction : h.more && r.key === 'by' ? `這一小時記了 ${h.more + 1} 筆，顯示最後一筆` : undefined">
                  {{ h.cell ? r.show(h.cell) ?? '' : '' }}
                </td>
              </tr>
              <tr class="border-t-2 border-slate-200 bg-sky-50/40">
                <th class="sticky left-0 z-10 whitespace-nowrap bg-sky-50 px-2 py-1 text-left font-medium text-slate-600">輸入</th>
                <td v-for="h in fs.hours" :key="h.hour" :class="['px-1 py-1 text-center', h.hour === '08' || h.hour === '16' ? 'border-l-2 border-slate-300' : 'border-l border-slate-100']" :title="h.io.intake ? `手記 ${h.io.manual}・點滴 ${h.io.iv}・管灌 ${h.io.tube}` : undefined">{{ h.io.intake || '' }}</td>
              </tr>
              <tr class="border-t border-slate-100 bg-sky-50/40">
                <th class="sticky left-0 z-10 whitespace-nowrap bg-sky-50 px-2 py-1 text-left font-medium text-slate-600">　其中點滴</th>
                <td v-for="h in fs.hours" :key="h.hour" :class="['px-1 py-1 text-center text-slate-500', h.hour === '08' || h.hour === '16' ? 'border-l-2 border-slate-300' : 'border-l border-slate-100']">{{ h.io.iv || '' }}</td>
              </tr>
              <tr class="border-t border-slate-100 bg-sky-50/40">
                <th class="sticky left-0 z-10 whitespace-nowrap bg-sky-50 px-2 py-1 text-left font-medium text-slate-600">輸出</th>
                <td v-for="h in fs.hours" :key="h.hour" :class="['px-1 py-1 text-center', h.hour === '08' || h.hour === '16' ? 'border-l-2 border-slate-300' : 'border-l border-slate-100']">{{ h.io.output || '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 欄數看這個區塊的寬度（auto-fill），不看視窗寬：護理站右側在病人清單旁邊 -->
        <dl class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
          <div v-for="(s, i) in fs.shifts" :key="s.shift" class="rounded-md border border-slate-200 px-3 py-2">
            <dt class="text-xs text-slate-500">{{ s.shift }}（{{ ['00–08', '08–16', '16–24'][i] }}）</dt>
            <dd class="tabular">入 {{ s.intake }}・出 {{ s.output }}・<span :class="['font-semibold', s.balance > 0 ? 'text-sky-700' : s.balance < 0 ? 'text-amber-700' : '']">{{ sign(s.balance) }}</span></dd>
          </div>
          <div class="rounded-md border-2 border-slate-300 px-3 py-2">
            <dt class="text-xs text-slate-500">24 小時平衡（ml）</dt>
            <dd class="tabular">入 {{ fs.day.intake }}・出 {{ fs.day.output }}・<span :class="['font-semibold', fs.day.balance > 0 ? 'text-sky-700' : fs.day.balance < 0 ? 'text-amber-700' : '']">{{ sign(fs.day.balance) }}</span></dd>
          </div>
        </dl>
        <p class="text-xs text-slate-500">紅字：超出正常範圍、MAP &lt;{{ MAP_LOW }}、GCS ≤8、瞳孔不等大（差 ≥1 mm）。瞳孔光反射 + 靈敏、± 遲鈍、− 無反應。</p>
      </template>
    </UQueryState>
  </div>
</template>
