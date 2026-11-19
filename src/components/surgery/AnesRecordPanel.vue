<script setup lang="ts">
// 術中麻醉紀錄：麻醉開始、結束；生命徵象、用藥、輸液、輸出、事件；時間軸（SVG）。
// 欄位檢查、空窗（超過 15 分鐘沒記生命徵象）、術中低血壓低血氧、輸入輸出合計都在服務層（anesthesia.ts、anesthesia-rules）
import { computed, reactive, ref } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import { UButton, UInput, UQueryState, USelect } from '@/components/ui'
import { anesthesiaApi, ANES_DRUGS, ANES_EVENT_LABEL, FLUID_LABEL, HYPOTENSION_SBP as HYPO, OUTPUT_LABEL, type AnesChart } from '@/services'
import type { AnesEntryType } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { now } from '@/utils/date'

const props = defineProps<{ surgeryId: string }>()
const emit = defineEmits<{ changed: [] }>()
const { data, loading, reload } = useQuery(() => anesthesiaApi.anesChart(props.surgeryId), [() => props.surgeryId])
const c = computed<AnesChart | undefined>(() => (data.value?.surgeryId === props.surgeryId ? data.value : undefined))

// ---------- 時間軸 ----------
const W = 640
const H = 190
const PAD = 34
const ms = (t: string) => Date.parse(t.replace(' ', 'T'))
const span = computed(() => {
  if (!c.value?.startAt) return undefined
  const a = ms(c.value.startAt)
  const b = Math.max(ms(c.value.endAt ?? now()), a + 30 * 60000)
  return { a, b }
})
const x = (t: string) => (span.value ? PAD + ((ms(t) - span.value.a) / (span.value.b - span.value.a)) * (W - PAD - 8) : 0)
// 上半：血壓、心跳（0–200）；下半：SpO2（80–100）
const yTop = (v: number) => 12 + (1 - Math.min(v, 200) / 200) * 110
const ySpo2 = (v: number) => 132 + (1 - (Math.max(80, Math.min(v, 100)) - 80) / 20) * 30
const vitals = computed(() => (c.value?.entries ?? []).filter((e) => e.type === 'vital'))
const line = (pts: [number, number][]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
const hrPath = computed(() => line(vitals.value.filter((v) => v.hr !== undefined).map((v) => [x(v.at), yTop(v.hr!)])))
const spo2Path = computed(() => line(vitals.value.filter((v) => v.spo2 !== undefined).map((v) => [x(v.at), ySpo2(v.spo2!)])))
// 用藥、事件標籤：位置太近的併成一組，由下往上疊（避免字重疊）
const marks = computed(() => (c.value?.entries ?? []).filter((e) => e.type === 'drug' || e.type === 'event'))
const clusters = computed(() => {
  const out: { x: number; labels: string[] }[] = []
  for (const m of marks.value) {
    const px = x(m.at)
    const label = m.type === 'drug' ? m.text.split(' ')[0] : m.text.split('：')[0]
    const last = out.at(-1)
    if (last && px - last.x < 52) last.labels.push(label)
    else out.push({ x: px, labels: [label] })
  }
  return out
})
const ticks = computed(() => {
  if (!span.value) return []
  const out: { x: number; label: string }[] = []
  const step = (span.value.b - span.value.a) / 60000 > 120 ? 30 : 15
  const first = Math.ceil(span.value.a / (step * 60000)) * step * 60000
  for (let t = first; t <= span.value.b; t += step * 60000) {
    const d = new Date(t)
    out.push({ x: PAD + ((t - span.value.a) / (span.value.b - span.value.a)) * (W - PAD - 8), label: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` })
  }
  return out
})

// ---------- 開始、結束、記錄 ----------
const startAt = ref('')
const endAt = ref('')
const startAct = useAction(anesthesiaApi.startAnes, { success: '麻醉開始' })
const endAct = useAction(anesthesiaApi.endAnes, { success: '麻醉結束' })
async function start() {
  if (await startAct.run(props.surgeryId, { at: startAt.value.replace('T', ' ') })) after()
}
async function end() {
  if (await endAct.run(props.surgeryId, { at: endAt.value.replace('T', ' ') })) after()
}
function after() {
  reload()
  emit('changed')
}
const TYPES: { value: AnesEntryType; label: string }[] = [
  { value: 'vital', label: '生命徵象' }, { value: 'drug', label: '用藥' }, { value: 'fluid', label: '輸液／血品' }, { value: 'output', label: '失血／尿量' }, { value: 'event', label: '事件' },
]
const f = reactive({
  type: 'vital' as AnesEntryType, at: '', sbp: '' as string | number, dbp: '' as string | number, hr: '' as string | number, spo2: '' as string | number, etco2: '' as string | number,
  drug: '' as string | number | undefined, dose: '' as string | number, fluid: 'crystalloid' as string | number | undefined, output: 'blood' as string | number | undefined, ml: '' as string | number, event: '' as string | number | undefined, note: '',
})
const addAct = useAction(anesthesiaApi.addAnesEntry, { success: '已記錄' })
const opt = (v: string | number) => (v === '' || v === undefined ? undefined : Number(v))
async function add() {
  const base = { type: f.type, at: f.at.replace('T', ' ') }
  const input =
    f.type === 'vital' ? { ...base, sbp: opt(f.sbp), dbp: opt(f.dbp), hr: opt(f.hr), spo2: opt(f.spo2), etco2: opt(f.etco2) }
    : f.type === 'drug' ? { ...base, drug: String(f.drug ?? ''), dose: opt(f.dose) }
    : f.type === 'fluid' ? { ...base, fluid: String(f.fluid ?? ''), ml: opt(f.ml) }
    : f.type === 'output' ? { ...base, output: String(f.output ?? ''), ml: opt(f.ml) }
    : { ...base, event: String(f.event ?? ''), note: f.note }
  if (await addAct.run(props.surgeryId, input)) {
    Object.assign(f, { at: '', sbp: '', dbp: '', hr: '', spo2: '', etco2: '', dose: '', ml: '', note: '' })
    reload()
  }
}
const delAct = useAction(anesthesiaApi.removeAnesEntry, { success: '已刪除' })
async function del(id: string) {
  if (await delAct.run(props.surgeryId, id)) reload()
}
const e = (k: string) => addAct.fieldErrors.value[k]
</script>

<template>
  <section class="space-y-2 rounded-md border border-slate-200 p-3 text-sm">
    <UQueryState :loading="loading && !c" :ready="!!c">
      <template v-if="c">
        <div class="flex flex-wrap items-center gap-2">
          <h4 class="font-semibold text-slate-700">麻醉紀錄</h4>
          <span v-if="!c.required" class="text-xs text-slate-500">局部麻醉：不需要麻醉紀錄</span>
          <template v-else>
            <span class="tabular text-xs text-slate-600">{{ c.startAt ? `${c.startAt.slice(11)} 開始` : '還沒開始' }}{{ c.endAt ? `・${c.endAt.slice(11)} 結束` : c.startAt ? '・進行中' : '' }}</span>
            <span v-if="c.startAt" class="text-xs text-slate-600">輸液 {{ c.totals.fluid }}・血品 {{ c.totals.blood }}・失血 {{ c.totals.bloodLoss }}・尿量 {{ c.totals.urine }} mL</span>
            <span class="ml-auto flex flex-wrap items-end gap-2">
              <template v-if="c.canEdit && !c.startAt">
                <input v-model="startAt" type="datetime-local" class="form-control w-48 py-1 text-xs" aria-label="麻醉開始時間（空白＝現在）" />
                <UButton size="sm" :loading="startAct.pending.value" @click="start">麻醉開始</UButton>
              </template>
              <template v-if="c.canEdit && c.startAt && !c.endAt">
                <input v-model="endAt" type="datetime-local" class="form-control w-48 py-1 text-xs" aria-label="麻醉結束時間（空白＝現在）" />
                <UButton size="sm" variant="secondary" :loading="endAct.pending.value" @click="end">麻醉結束</UButton>
              </template>
            </span>
          </template>
        </div>
        <p v-if="startAct.fieldErrors.value.at || endAct.fieldErrors.value.at" class="text-xs text-red-700">{{ startAct.fieldErrors.value.at || endAct.fieldErrors.value.at }}</p>

        <template v-if="c.startAt">
          <svg :viewBox="`0 0 ${W} ${H}`" class="w-full rounded border border-slate-100 bg-white" role="img" aria-label="麻醉時間軸">
            <rect v-for="(g, i) in c.gaps" :key="`g${i}`" :x="x(g.from)" y="8" :width="Math.max(2, x(g.to) - x(g.from))" height="160" class="fill-amber-100" />
            <g class="text-slate-300">
              <line v-for="t in ticks" :key="t.x" :x1="t.x" :x2="t.x" y1="10" y2="166" stroke="currentColor" stroke-width="0.5" />
              <line :x1="PAD" :x2="W - 8" :y1="yTop(HYPO)" :y2="yTop(HYPO)" stroke="currentColor" stroke-dasharray="3 3" />
            </g>
            <text v-for="t in ticks" :key="`l${t.x}`" :x="t.x" :y="H - 6" text-anchor="middle" class="fill-slate-500 text-[9px]">{{ t.label }}</text>
            <text x="2" :y="yTop(200) + 8" class="fill-slate-400 text-[8px]">200</text>
            <text x="2" :y="yTop(100) + 3" class="fill-slate-400 text-[8px]">100</text>
            <text x="2" :y="ySpo2(100) + 6" class="fill-slate-400 text-[8px]">SpO2</text>
            <!-- 血壓：收縮壓▼、舒張壓▲，中間連線 -->
            <g v-for="v in vitals.filter((v) => v.sbp !== undefined)" :key="`bp${v.id}`" :class="v.sbp! < HYPO ? 'text-red-600' : 'text-blue-700'">
              <line v-if="v.dbp !== undefined" :x1="x(v.at)" :x2="x(v.at)" :y1="yTop(v.sbp!)" :y2="yTop(v.dbp)" stroke="currentColor" stroke-width="1" />
              <path :d="`M${x(v.at) - 3},${yTop(v.sbp!) - 3} L${x(v.at) + 3},${yTop(v.sbp!) - 3} L${x(v.at)},${yTop(v.sbp!) + 2} Z`" fill="currentColor" />
              <path v-if="v.dbp !== undefined" :d="`M${x(v.at) - 3},${yTop(v.dbp) + 3} L${x(v.at) + 3},${yTop(v.dbp) + 3} L${x(v.at)},${yTop(v.dbp) - 2} Z`" fill="currentColor" />
            </g>
            <path :d="hrPath" fill="none" class="stroke-rose-500" stroke-width="1.2" />
            <circle v-for="v in vitals.filter((v) => v.hr !== undefined)" :key="`hr${v.id}`" :cx="x(v.at)" :cy="yTop(v.hr!)" r="1.8" class="fill-rose-500" />
            <path :d="spo2Path" fill="none" class="stroke-emerald-600" stroke-width="1.2" />
            <circle v-for="v in vitals.filter((v) => v.spo2 !== undefined)" :key="`o${v.id}`" :cx="x(v.at)" :cy="ySpo2(v.spo2!)" r="1.8" :class="v.spo2! < 90 ? 'fill-red-600' : 'fill-emerald-600'" />
            <line v-for="m in marks" :key="`m${m.id}`" :x1="x(m.at)" :x2="x(m.at)" y1="164" y2="168" class="stroke-violet-600" />
            <g v-for="g in clusters" :key="`c${g.x}`">
              <text v-for="(l, j) in g.labels" :key="j" :x="g.x" :y="127 - (g.labels.length - 1 - j) * 9" :text-anchor="g.x < PAD + 20 ? 'start' : g.x > W - 40 ? 'end' : 'middle'" class="fill-violet-700 text-[8px]">{{ l }}</text>
            </g>
          </svg>
          <p class="flex flex-wrap gap-x-3 text-[11px] text-slate-500">
            <span><span class="text-blue-700">▼▲</span> 收縮壓／舒張壓（紅＝低於 {{ HYPO }}）</span><span><span class="text-rose-500">●</span> 心跳</span><span><span class="text-emerald-600">●</span> SpO2</span><span><span class="text-violet-700">｜</span> 用藥、事件</span><span><span class="bg-amber-100 px-1">　</span> 超過 15 分鐘沒記生命徵象</span>
          </p>

          <ul v-if="c.alerts.length" class="space-y-0.5 rounded bg-red-50 px-3 py-1.5 text-xs text-red-800">
            <li v-for="a in c.alerts" :key="a.at + a.kind">術中{{ a.text }}</li>
          </ul>
          <p v-for="g in c.gaps" :key="g.from" class="text-xs text-amber-800">
            {{ g.from.slice(11) }} 之後 {{ g.minutes }} 分鐘沒記生命徵象{{ g.open ? '（到現在）' : `（到 ${g.to.slice(11)}）` }}
          </p>

          <form v-if="c.canEdit" class="grid grid-cols-2 gap-2 rounded bg-slate-50 p-2 sm:grid-cols-4" @submit.prevent="add">
            <USelect v-model="f.type" label="類別" :options="TYPES" />
            <UInput v-model="f.at" type="datetime-local" label="時間（空白＝現在）" :error="e('at')" />
            <template v-if="f.type === 'vital'">
              <UInput v-model="f.sbp" type="number" label="收縮壓" :error="e('sbp')" />
              <UInput v-model="f.dbp" type="number" label="舒張壓" :error="e('dbp')" />
              <UInput v-model="f.hr" type="number" label="心跳" :error="e('hr')" />
              <UInput v-model="f.spo2" type="number" label="SpO2" :error="e('spo2')" />
              <UInput v-model="f.etco2" type="number" label="EtCO2" :error="e('etco2')" />
            </template>
            <template v-else-if="f.type === 'drug'">
              <USelect v-model="f.drug" label="藥品" :options="Object.entries(ANES_DRUGS).map(([k, d]) => ({ label: `${d.label}（${d.unit}）`, value: k }))" placeholder="選擇" :error="e('drug')" />
              <UInput v-model="f.dose" type="number" label="劑量" :error="e('dose')" />
            </template>
            <template v-else-if="f.type === 'fluid' || f.type === 'output'">
              <USelect v-if="f.type === 'fluid'" v-model="f.fluid" label="種類" :options="Object.entries(FLUID_LABEL).map(([k, l]) => ({ label: l, value: k }))" :error="e('fluid')" />
              <USelect v-else v-model="f.output" label="種類" :options="Object.entries(OUTPUT_LABEL).map(([k, l]) => ({ label: l, value: k }))" :error="e('output')" />
              <UInput v-model="f.ml" type="number" label="mL" :error="e('ml')" />
            </template>
            <template v-else>
              <USelect v-model="f.event" label="事件" :options="Object.entries(ANES_EVENT_LABEL).map(([k, l]) => ({ label: l, value: k }))" placeholder="選擇" :error="e('event')" />
              <UInput v-model="f.note" label="說明" :error="e('note')" />
            </template>
            <div class="col-span-full flex justify-end"><UButton type="submit" size="sm" :loading="addAct.pending.value">記錄</UButton></div>
          </form>

          <details class="text-xs">
            <summary class="cursor-pointer text-slate-600">全部紀錄 {{ c.entries.length }} 筆</summary>
            <ul class="mt-1 divide-y divide-slate-100">
              <li v-for="x2 in c.entries" :key="x2.id" class="flex items-center gap-2 py-0.5">
                <span class="tabular w-10">{{ x2.at.slice(11) }}</span><span class="min-w-0 flex-1">{{ x2.text }}</span><span class="text-slate-400">{{ x2.byName }}</span>
                <button v-if="c.canEdit" type="button" class="text-slate-400 hover:text-red-600" :aria-label="`刪除 ${x2.at.slice(11)} ${x2.text}`" @click="del(x2.id)"><Trash2 class="h-3.5 w-3.5" /></button>
              </li>
            </ul>
          </details>
        </template>
      </template>
    </UQueryState>
  </section>
</template>
