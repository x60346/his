<script setup lang="ts">
// 生命徵象：輸入 → 趨勢圖 → 歷史紀錄。
// 兩種「範圍」要分清楚（都定義在 vitalSpecs）：
//   limit  合理範圍，超出就是打錯字（體溫 52 度）→ 服務層擋下，存不進去
//   normal 正常範圍，超出是「異常」（體溫 38.5 度）→ 照常記錄，但畫面標紅提醒
// 趨勢圖每個指標各一張（小倍數圖），不把體溫和脈搏擠在同一張雙 Y 軸圖上。
import { computed, reactive, ref, watch } from 'vue'
import { UBadge, UButton, UInput, ULineChart, UQueryState, USelect, UTable, type Column, type LinePoint } from '@/components/ui'
import NewsPanel from '@/components/NewsPanel.vue'
import { AVPU_LEVELS, checkNewsExtra, isAbnormal, isNews, NEWS_LEVEL_LABEL, newsScore, O2_RANGE, nursingApi, PAIN_ACT_FROM, PAIN_ACTIONS, PAIN_REASSESS_MIN, vitalInputProblem, vitalSpecs, type AdmissionView, type VitalKey } from '@/services'
import { UTextarea } from '@/components/ui'
import { useAction, useQuery } from '@/composables/useService'
import type { Avpu, VitalRecord } from '@/types'

const props = defineProps<{ admission: AdmissionView }>()

const { data, loading } = useQuery(
  async () => {
    const id = props.admission.id
    return { id, list: await nursingApi.listVitals(id) }
  },
  [() => props.admission.id],
)
const vitals = computed(() => (data.value?.id === props.admission.id ? data.value.list : undefined))

// ---------- 輸入 ----------
const fields: VitalKey[] = ['temp', 'pulse', 'resp', 'sbp', 'dbp', 'spo2', 'pain', 'intake', 'output']
const blank = () => Object.fromEntries(fields.map((k) => [k, undefined])) as Record<VitalKey, number | undefined>
const form = reactive(blank())
// 疼痛 ≥4 要寫處置（服務層也擋），1 小時內重評：下一次再記疼痛分數就算重評
const painAction = ref('')
// NEWS2 要的另外兩項：給氧（L/min，0＝室內空氣）、意識 ACVPU
const o2 = ref<number | undefined>()
const avpu = ref<Avpu | ''>('')
const num = (x: unknown) => (x === undefined || x === null || x === '' ? undefined : Number(x))
/** 輸入當下就算 NEWS2（和服務層同一個 newsScore）：七項都有才算 */
const preview = computed(() => newsScore({ id: '', admissionId: '', at: '', nurseId: '', ...Object.fromEntries(fields.map((k) => [k, num(form[k])])), o2: num(o2.value), ...(avpu.value ? { avpu: avpu.value } : {}) }))
const o2Error = computed(() => checkNewsExtra({ o2: num(o2.value) }).o2 ?? save.fieldErrors.value.o2)
const newsRefresh = ref(0)
const needAction = computed(() => form.pain !== undefined && form.pain !== null && (form.pain as unknown) !== '' && Number(form.pain) >= PAIN_ACT_FROM)
watch(() => props.admission.id, () => {
  Object.assign(form, blank())
  painAction.value = ''
  o2.value = undefined
  avpu.value = ''
})

const save = useAction(nursingApi.addVitals, { success: (v) => (v.rrtCalled ? '已記錄生命徵象：NEWS2 ≥7，已自動呼叫快速反應小組' : '已記錄生命徵象') })
// 今日輸入輸出：生命徵象記的輸入量＋管灌灌入量
const { data: io, reload: reloadIo } = useQuery(async () => ({ id: props.admission.id, v: await nursingApi.ioToday(props.admission.id) }), [() => props.admission.id])
async function submit() {
  if (await save.run({ admissionId: props.admission.id, ...form, ...(num(o2.value) !== undefined ? { o2: num(o2.value) } : {}), ...(avpu.value ? { avpu: avpu.value } : {}), ...(needAction.value ? { painAction: painAction.value } : {}) })) {
    reloadIo()
    Object.assign(form, blank())
    painAction.value = ''
    o2.value = undefined
    avpu.value = ''
    newsRefresh.value++
  }
}
/** 輸入當下就提示「異常」：與服務層、圖表用同一條 isAbnormal 規則 */
/** 先看「能不能存」（打錯字），再看「正常不正常」（病人異常）——和服務層同一套規則 */
const errorOf = (k: VitalKey) => vitalInputProblem(k, form[k]) ?? save.fieldErrors.value[k]
const hintOf = (k: VitalKey) => {
  const { normal: n, unit } = vitalSpecs[k]
  if (!vitalInputProblem(k, form[k]) && isAbnormal(k, form[k])) return '⚠ 超出正常範圍'
  return n ? `${unit}・正常 ${n[0]}–${n[1]}` : unit
}

// ---------- 趨勢圖：最近 9 筆（一天量三次約三天；畫面標題「最近 N 筆」） ----------
const charts: { key: VitalKey; domain?: [number, number] }[] = [
  { key: 'temp', domain: [35, 41] },
  { key: 'pulse' },
  { key: 'sbp' },
  { key: 'spo2', domain: [85, 100] },
]
const recent = computed(() => (vitals.value ?? []).slice(-9))
const pointsOf = (k: VitalKey): LinePoint[] => recent.value.filter((v) => v[k] !== undefined).map((v) => ({ x: v.at.slice(5), y: v[k]! }))
// 跨好幾天的資料，X 軸只寫「20:00」會出現好幾個一模一樣的標籤，分不出是哪一天——日期要留著
const shortX = (x: string) => x.replace('-', '/') // MM-DD HH:mm → MM/DD HH:mm

// ---------- 歷史紀錄 ----------
const columns: Column<VitalRecord>[] = [
  { key: 'at', label: '時間', width: '8rem', format: (r) => r.at.slice(5) },
  ...fields.slice(0, 7).map((k) => ({ key: k, label: vitalSpecs[k].label, align: 'right' as const })),
  { key: 'o2', label: '給氧', align: 'right' },
  { key: 'avpu', label: '意識', align: 'center' },
  { key: 'news', label: 'NEWS2', align: 'right' },
  { key: 'io', label: '輸入/輸出', align: 'right' },
]
const newsOf = (r: VitalRecord) => { const x = newsScore(r); return isNews(x) ? x : undefined }
const history = computed(() => [...(vitals.value ?? [])].reverse())
</script>

<template>
  <div class="space-y-5 p-4">
    <NewsPanel :admission-id="admission.id" :refresh="newsRefresh" />
    <form class="rounded-md border border-slate-200 bg-slate-50 p-3" @submit.prevent="submit">
      <div class="mb-2 flex flex-wrap items-baseline gap-x-3 text-sm">
        <span class="font-semibold text-slate-700">記錄生命徵象</span>
        <span v-if="io?.id === admission.id" class="tabular text-xs text-slate-500">今日輸入 {{ io.v.intake }} ml<template v-if="io.v.tubeMl || io.v.ivMl">（含{{ [io.v.ivMl && `點滴 ${io.v.ivMl}`, io.v.tubeMl && `管灌 ${io.v.tubeMl}`].filter(Boolean).join('、') }}）</template>・輸出 {{ io.v.output }} ml<template v-if="io.v.drainMl">（含引流 {{ io.v.drainMl }}）</template></span>
      </div>
      <!-- 欄數依「這個區塊實際的寬度」決定（auto-fill），不看視窗寬：護理站右側在病人清單旁邊，視窗寬不代表這裡寬 -->
      <div class="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-x-3 gap-y-2">
        <!-- 異常標紅：UInput 把 class 直接給 <input>（inheritAttrs: false），所以寫 !border-red-400 本身；
             以前寫成 [&_input]:（「裡面的 input」），input 裡面沒有東西，紅框從來沒出現過 -->
        <UInput
          v-for="k in fields"
          :key="k"
          v-model="form[k]"
          type="number"
          step="any"
          :label="vitalSpecs[k].label"
          :error="errorOf(k)"
          :hint="hintOf(k)"
          :class="!vitalInputProblem(k, form[k]) && isAbnormal(k, form[k]) && '!border-red-400 !text-red-700'"
        />
        <UInput v-model="o2" type="number" step="any" label="給氧" :error="o2Error" :hint="`L/min・0＝室內空氣（≤${O2_RANGE[1]}）`" />
        <USelect v-model="avpu" label="意識" :options="[{ label: '—', value: '' }, ...AVPU_LEVELS.map((l) => ({ label: l.label, value: l.value }))]" :error="save.fieldErrors.value.avpu" />
      </div>
      <div v-if="needAction" class="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2">
        <UTextarea v-model="painAction" :label="`疼痛 ${form.pain} 分的處置（${PAIN_REASSESS_MIN} 分鐘內重評）`" :rows="2" required :error="save.fieldErrors.value.painAction" />
        <div class="mt-1 flex flex-wrap gap-1"><button v-for="x in PAIN_ACTIONS" :key="x" type="button" class="rounded border border-amber-300 bg-white px-1.5 text-xs hover:bg-amber-100" @click="painAction = painAction ? `${painAction}；${x}` : x">{{ x }}</button></div>
      </div>
      <div class="mt-2 flex flex-wrap items-center justify-end gap-2 text-xs">
        <span v-if="isNews(preview)" class="text-slate-600">NEWS2 <UBadge :tone="preview.level === 'high' ? 'red' : preview.level === 'medium' ? 'yellow' : 'green'" class="tabular">{{ preview.total }} 分・{{ NEWS_LEVEL_LABEL[preview.level] }}</UBadge><template v-if="preview.level === 'high'">　存檔會自動呼叫快速反應小組</template></span>
        <span v-else-if="preview.missing.length < 7" class="text-slate-500">要算 NEWS2 還缺：{{ preview.missing.join('、') }}</span>
        <UButton type="submit" size="sm" :loading="save.pending.value">儲存</UButton>
      </div>
    </form>

    <UQueryState :loading="loading && !vitals" :ready="!!vitals" empty-title="尚無生命徵象紀錄">
      <section>
        <h3 class="mb-2 text-sm font-semibold text-slate-700">趨勢（最近 {{ recent.length }} 筆）</h3>
        <!-- 欄數依區塊實際寬度：每張至少 18rem（ULineChart 下限 240px 再留點空間），四張圖在一般寬度排成 2×2、很寬時一列四張。
             以前用 md:（看視窗寬），在病人清單旁的窄區塊裡硬排兩欄，圖超出邊界 -->
        <div class="grid grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] gap-4">
          <ULineChart
            v-for="c in charts"
            :key="c.key"
            :title="vitalSpecs[c.key].label"
            :unit="vitalSpecs[c.key].unit"
            :normal="vitalSpecs[c.key].normal"
            :domain="c.domain"
            :points="pointsOf(c.key)"
            :format-x="shortX"
            :height="160"
          />
        </div>
      </section>

      <section class="mt-5">
        <h3 class="mb-2 text-sm font-semibold text-slate-700">歷史紀錄</h3>
        <UTable :columns="columns" :rows="history" :row-key="(r) => r.id" dense class="max-h-80">
          <template v-for="k in fields.slice(0, 6)" :key="k" #[`cell-${k}`]="{ row }">
            <span :class="['tabular', isAbnormal(k, row[k]) && 'font-semibold text-red-600']">{{ row[k] ?? '—' }}</span>
          </template>
          <template #cell-pain="{ row }"><span :class="['tabular', (row.pain ?? 0) >= PAIN_ACT_FROM && 'font-semibold text-red-600']" :title="row.painAction">{{ row.pain ?? '—' }}<span v-if="row.painAction" class="ml-1 text-xs font-normal text-slate-500">（{{ row.painAction }}）</span></span></template>
          <template #cell-o2="{ row }"><span class="tabular">{{ row.o2 === undefined ? '—' : row.o2 === 0 ? '室內' : `${row.o2} L` }}</span></template>
          <template #cell-avpu="{ row }"><span :class="row.avpu && row.avpu !== 'A' && 'font-semibold text-red-600'">{{ row.avpu ?? '—' }}</span></template>
          <template #cell-news="{ row }"><span v-if="newsOf(row)" :class="['tabular', newsOf(row)!.level === 'high' ? 'font-semibold text-red-600' : newsOf(row)!.level === 'medium' && 'font-semibold text-amber-700']">{{ newsOf(row)!.total }}</span><span v-else class="text-slate-300">—</span></template>
          <template #cell-io="{ row }"><span class="tabular">{{ row.intake ?? '—' }} / {{ row.output ?? '—' }}</span></template>
        </UTable>
      </section>
    </UQueryState>
  </div>
</template>
