<script setup lang="ts">
// 藥品醫令。重點：
//   - 總量 = 劑量 × 每日次數 × 天數，自動計算（與服務層同一個 autoQty）
//   - 醫師手動改過總量後不再自動覆蓋，可按「↺」恢復自動
//   - 給藥單位與調劑單位不同（Insulin 每次 10 U、調劑 1 PEN；眼藥水每次 1 滴、調劑 1 BTL）時
//     無法換算，總量由醫師填寫
//   - 過敏：顯示警示但不阻擋，最終由醫師判斷；庫存不足、高警訊藥品也標示出來
import { AlertTriangle, RotateCcw, Trash2 } from 'lucide-vue-next'
import { UBadge, UEmpty, USearchSelect } from '@/components/ui'
import { autoQty, checkDays, doseLevel, doseUnitOf, MAX_RX_DAYS, masterApi, type AllergyWarning } from '@/services'
import { useUi } from '@/stores/ui'
import type { Drug, Frequency, MedicationOrder } from '@/types'

/** 畫面用的列：多一個「總量是否手動修改」旗標，送出前會移除 */
export type MedRow = MedicationOrder & { _manual?: boolean }

const rows = defineModel<MedRow[]>({ required: true })
const props = defineProps<{
  drugs: Map<string, Drug>
  freqs: Frequency[]
  warnings: AllergyWarning[]
  defaultDays: number
  readonly?: boolean
}>()
const ui = useUi()
const routes = masterApi.staticCodes.routes

const timesOf = (freq: string) => props.freqs.find((f) => f.code === freq)?.timesPerDay ?? 1

/** 這列的總量能否自動換算 */
const convertible = (r: MedRow) => {
  const d = props.drugs.get(r.drugId)
  return !!d && doseUnitOf(d) === d.unit
}

function recalc(r: MedRow) {
  if (r._manual) return
  const d = props.drugs.get(r.drugId)
  const q = d ? autoQty(d, r.dose || 0, timesOf(r.freq), r.days || 0) : null
  if (q !== null) r.qty = q
}

function add(d: Drug) {
  if (rows.value.some((r) => r.drugId === d.id)) return ui.toast.warning(`${d.name} 已在處方中`)
  const q = autoQty(d, d.defaultDose, timesOf(d.defaultFreq), props.defaultDays)
  // 無法換算的藥：總量預設 1（支、瓶），標示為手動，請醫師確認
  rows.value.push({ drugId: d.id, dose: d.defaultDose, freq: d.defaultFreq, route: d.defaultRoute, days: props.defaultDays, qty: q ?? 1, selfPay: false, _manual: q === null })
}

function onQty(r: MedRow) {
  r._manual = true
}
function resetQty(r: MedRow) {
  r._manual = false
  recalc(r)
}

const warningOf = (drugId: string) => props.warnings.filter((w) => w.drugId === drugId).map((w) => w.allergen)
</script>

<template>
  <div class="space-y-3">
    <USearchSelect
      v-if="!readonly"
      placeholder="輸入藥名、學名或健保碼，例：Acetaminophen、Metformin"
      :search="(kw) => masterApi.listDrugs({ keyword: kw })"
      :item-key="(d) => d.id"
      :item-label="(d) => `${d.name}${d.highAlert ? '　⚠ 高警訊' : ''}`"
      :item-sub="(d) => `${d.generic}・${d.spec}・庫存 ${d.stock}`"
      @select="add"
    />
    <UEmpty v-if="!rows.length" title="尚未開立藥品" />
    <div v-else class="overflow-x-auto rounded-md border border-slate-200">
      <table class="w-full text-sm">
        <thead class="bg-slate-50 text-xs text-slate-500">
          <tr>
            <th class="px-2 py-2 text-left">藥品</th>
            <th class="px-2 py-2 text-left">劑量</th>
            <th class="px-2 py-2 text-left">頻率</th>
            <th class="px-2 py-2 text-left">途徑</th>
            <th class="px-2 py-2 text-left">天數</th>
            <th class="px-2 py-2 text-left">總量</th>
            <th class="px-2 py-2 text-center">自費</th>
            <th v-if="!readonly" class="w-8" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in rows" :key="r.drugId" :class="['border-t border-slate-100 align-top', warningOf(r.drugId).length && 'bg-red-50/60']">
            <td class="px-2 py-1.5">
              <div class="font-medium text-slate-800">{{ drugs.get(r.drugId)?.name ?? r.drugId }}</div>
              <div class="flex flex-wrap items-center gap-1 text-xs text-slate-500">
                {{ drugs.get(r.drugId)?.spec }}
                <UBadge v-if="drugs.get(r.drugId)?.highAlert" tone="purple">高警訊</UBadge>
                <UBadge v-for="a in warningOf(r.drugId)" :key="a" tone="red"><AlertTriangle class="h-3 w-3" />病人對 {{ a }} 過敏</UBadge>
                <UBadge v-if="!readonly && (drugs.get(r.drugId)?.stock ?? 0) < r.qty" tone="yellow">庫存不足（存 {{ drugs.get(r.drugId)?.stock }}）</UBadge>
                <!-- 劑量合理性：與服務層同一條規則 -->
                <UBadge v-if="!readonly && drugs.get(r.drugId) && doseLevel(drugs.get(r.drugId)!, r.dose) === 'absurd'" tone="red">劑量不合理，請確認是否打錯</UBadge>
                <UBadge v-else-if="!readonly && drugs.get(r.drugId) && doseLevel(drugs.get(r.drugId)!, r.dose) === 'high'" tone="yellow">劑量偏高（常用 {{ drugs.get(r.drugId)!.defaultDose }}）</UBadge>
              </div>
            </td>
            <td class="px-2 py-1.5">
              <div class="flex items-center gap-1">
                <input v-model.number="r.dose" type="number" min="0" step="0.5" class="form-control w-16 px-2" :disabled="readonly" @input="recalc(r)" />
                <span class="text-xs text-slate-500">{{ drugs.get(r.drugId) ? doseUnitOf(drugs.get(r.drugId)!) : '' }}</span>
              </div>
            </td>
            <td class="px-2 py-1.5">
              <select v-model="r.freq" class="form-control w-24 px-2" :disabled="readonly" @change="recalc(r)">
                <option v-for="f in freqs" :key="f.code" :value="f.code">{{ f.code }}</option>
              </select>
            </td>
            <td class="px-2 py-1.5">
              <select v-model="r.route" class="form-control w-20 px-2" :disabled="readonly">
                <option v-for="rt in routes" :key="rt.code" :value="rt.code">{{ rt.code }}</option>
              </select>
            </td>
            <td class="px-2 py-1.5">
              <input
                v-model.number="r.days"
                type="number"
                min="1"
                :max="MAX_RX_DAYS"
                :class="['form-control w-16 px-2', !readonly && checkDays(r.days) && 'form-control-error']"
                :title="checkDays(r.days) ?? ''"
                :disabled="readonly"
                @input="recalc(r)"
              />
              <div v-if="!readonly && checkDays(r.days)" class="mt-0.5 text-xs text-red-600">{{ checkDays(r.days) }}</div>
            </td>
            <td class="px-2 py-1.5">
              <div class="flex items-center gap-1">
                <input v-model.number="r.qty" type="number" min="0" :class="['form-control w-16 px-2', r._manual && 'border-amber-400']" :disabled="readonly" @input="onQty(r)" />
                <!-- 總量是「調劑單位」：幾錠、幾支、幾瓶 -->
                <span class="text-xs text-slate-500">{{ drugs.get(r.drugId)?.unit }}</span>
                <button v-if="r._manual && !readonly && convertible(r)" class="rounded p-1 text-amber-600 hover:bg-amber-50" title="已手動修改，按此恢復自動計算" @click="resetQty(r)">
                  <RotateCcw class="h-3.5 w-3.5" />
                </button>
              </div>
              <div v-if="!convertible(r) && !readonly" class="mt-0.5 text-[11px] text-amber-700">無法由劑量換算，請填寫</div>
            </td>
            <td class="px-2 py-1.5 text-center">
              <input v-model="r.selfPay" type="checkbox" class="mt-2 h-4 w-4 rounded border-slate-300 text-brand-600" :disabled="readonly" />
            </td>
            <td v-if="!readonly" class="px-1 py-1.5">
              <button class="mt-1 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="刪除" @click="rows.splice(i, 1)"><Trash2 class="h-4 w-4" /></button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
