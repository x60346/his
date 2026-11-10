<script setup lang="ts">
// 生命徵象：輸入 → 趨勢圖 → 歷史紀錄。
// 兩種「範圍」要分清楚（都定義在 vitalSpecs）：
//   limit  合理範圍，超出就是打錯字（體溫 52 度）→ 服務層擋下，存不進去
//   normal 正常範圍，超出是「異常」（體溫 38.5 度）→ 照常記錄，但畫面標紅提醒
// 趨勢圖每個指標各一張（小倍數圖），不把體溫和脈搏擠在同一張雙 Y 軸圖上。
import { computed, reactive, watch } from 'vue'
import { UButton, UInput, ULineChart, UQueryState, UTable, type Column, type LinePoint } from '@/components/ui'
import { isAbnormal, nursingApi, vitalInputProblem, vitalSpecs, type AdmissionView, type VitalKey } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import type { VitalRecord } from '@/types'

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
watch(() => props.admission.id, () => Object.assign(form, blank()))

const save = useAction(nursingApi.addVitals, { success: '已記錄生命徵象' })
async function submit() {
  if (await save.run({ admissionId: props.admission.id, ...form })) Object.assign(form, blank())
}
/** 輸入當下就提示「異常」：與服務層、圖表用同一條 isAbnormal 規則 */
/** 先看「能不能存」（打錯字），再看「正常不正常」（病人異常）——和服務層同一套規則 */
const errorOf = (k: VitalKey) => vitalInputProblem(k, form[k]) ?? save.fieldErrors.value[k]
const hintOf = (k: VitalKey) => {
  const { normal: n, unit } = vitalSpecs[k]
  if (!vitalInputProblem(k, form[k]) && isAbnormal(k, form[k])) return '⚠ 超出正常範圍'
  return n ? `${unit}・正常 ${n[0]}–${n[1]}` : unit
}

// ---------- 趨勢圖：最近 3 天 ----------
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
  { key: 'io', label: '輸入/輸出', align: 'right' },
]
const history = computed(() => [...(vitals.value ?? [])].reverse())
</script>

<template>
  <div class="space-y-5 p-4">
    <form class="rounded-md border border-slate-200 bg-slate-50 p-3" @submit.prevent="submit">
      <div class="mb-2 text-sm font-semibold text-slate-700">記錄生命徵象</div>
      <div class="grid grid-cols-3 gap-x-3 gap-y-2 md:grid-cols-5">
        <UInput
          v-for="k in fields"
          :key="k"
          v-model="form[k]"
          type="number"
          step="any"
          :label="vitalSpecs[k].label"
          :error="errorOf(k)"
          :hint="hintOf(k)"
          :class="!vitalInputProblem(k, form[k]) && isAbnormal(k, form[k]) && '[&_input]:!border-red-400 [&_input]:!text-red-700'"
        />
      </div>
      <div class="mt-2 text-right"><UButton type="submit" size="sm" :loading="save.pending.value">儲存</UButton></div>
    </form>

    <UQueryState :loading="loading && !vitals" :ready="!!vitals" empty-title="尚無生命徵象紀錄">
      <section>
        <h3 class="mb-2 text-sm font-semibold text-slate-700">趨勢（最近 {{ recent.length }} 筆）</h3>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
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
          <template v-for="k in fields.slice(0, 7)" :key="k" #[`cell-${k}`]="{ row }">
            <span :class="['tabular', isAbnormal(k, row[k]) && 'font-semibold text-red-600']">{{ row[k] ?? '—' }}</span>
          </template>
          <template #cell-io="{ row }"><span class="tabular">{{ row.intake ?? '—' }} / {{ row.output ?? '—' }}</span></template>
        </UTable>
      </section>
    </UQueryState>
  </div>
</template>
