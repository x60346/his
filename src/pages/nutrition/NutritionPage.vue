<script setup lang="ts">
// 營養（營養師；護理師只看送餐清單）：
//   - 待評估：營養篩檢 ≥3 分、之後還沒評估的住院病人（篩得早的在前）→ 寫評估與建議（建議熱量、蛋白質；不開醫囑，主治已閱）
//   - 送餐清單：選病房、日期、餐別 → 以那一餐時間有效的飲食醫囑列出每床的飲食（禁食標「不送」、過敏標紅），各種飲食份數，可列印
import { computed, reactive, ref } from 'vue'
import { Printer } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UPageHeader, UQueryState, USelect, UTabs, UTextarea } from '@/components/ui'
import NutritionPanel from '@/components/NutritionPanel.vue'
import { masterApi, MEALS, nutritionApi, tubeApi, tubeNutrients, tubePlanText, type MealKey, type NutritionWorkItem } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { now, today } from '@/utils/date'

const auth = useAuth()
const isDiet = computed(() => auth.user?.role === 'diet' || auth.user?.role === 'admin')
const tab = ref(isDiet.value ? 'work' : 'meal')
const tabs = computed(() => [...(isDiet.value ? [{ key: 'work', label: '待評估' }] : []), { key: 'meal', label: '送餐清單' }])

// ---------- 待評估 ----------
const { data: work, loading } = useQuery(async () => (isDiet.value ? nutritionApi.listNutritionWork() : undefined))
const target = ref<NutritionWorkItem>()
const open = computed({ get: () => !!target.value, set: (x) => !x && (target.value = undefined) })
const form = reactive({ kcal: undefined as number | undefined, protein: undefined as number | undefined, assessment: '', recommendation: '' })
// 管灌建議（選填）：主治在「營養」分頁一鍵帶入成醫囑
const withTube = ref(false)
const tube = reactive({ formulaId: '' as string | number | undefined, totalMl: 1500 as number | undefined, mode: 'bolus' as 'bolus' | 'continuous', feeds: 6 as number | undefined, rateMlH: 60 as number | undefined })
const { data: formulas } = useQuery(() => tubeApi.listTubeFormulas())
const tubePlan = computed(() => ({ formulaId: String(tube.formulaId ?? ''), totalMl: Number(tube.totalMl), mode: tube.mode, ...(tube.mode === 'bolus' ? { feeds: Number(tube.feeds) } : { rateMlH: Number(tube.rateMlH) }) }))
const tubeFormula = computed(() => formulas.value?.find((x) => x.id === tube.formulaId))
function openAssess(i: NutritionWorkItem) {
  Object.assign(form, { kcal: undefined, protein: undefined, assessment: '', recommendation: '' })
  withTube.value = false
  Object.assign(tube, { formulaId: '', totalMl: 1500, mode: 'bolus', feeds: 6, rateMlH: 60 })
  save.fieldErrors.value = {}
  target.value = i
}
const save = useAction(nutritionApi.saveNutritionAssessment, { success: '已寫營養評估（主治首頁會看到待已閱）' })
async function submit() {
  if (target.value && (await save.run(target.value.admissionId, { ...form, ...(withTube.value ? { tube: tubePlan.value } : {}) }))) target.value = undefined
}

// ---------- 送餐清單 ----------
const wards = [...masterApi.staticCodes.wards, masterApi.staticCodes.obsWard]
// 預設：現在之後的下一餐（晚餐後就是明天早餐）
const nextMeal = (() => {
  const hm = now().slice(11, 16)
  const m = MEALS.find((x) => x.at > hm)
  return m ? { date: today(), meal: m.key } : { date: new Date(Date.parse(today()) + 86400000).toISOString().slice(0, 10), meal: 'breakfast' as MealKey }
})()
const q = reactive({ ward: wards[0], date: nextMeal.date, meal: nextMeal.meal as MealKey })
const { data: meal, loading: mealLoading } = useQuery(() => nutritionApi.mealList(q.ward, q.date, q.meal), [() => q.ward, () => q.date, () => q.meal])
const print = () => window.print()
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="營養" :description="isDiet ? '營養篩檢有風險的病人評估、送餐清單' : '每餐依病房的送餐清單'" class="print:hidden" />
    <UTabs v-model="tab" :tabs="tabs" class="print:hidden" />

    <template v-if="tab === 'work'">
      <UQueryState :loading="loading && !work" :ready="!!work">
        <template v-if="work">
          <p v-if="!work.toAssess.length" class="rounded-md border border-slate-200 bg-white px-3 py-6 text-center text-sm text-slate-400">目前沒有待評估的病人</p>
          <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white text-sm">
            <li v-for="i in work.toAssess" :key="i.admissionId" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <UBadge tone="red">{{ i.score }} 分</UBadge>
              <div class="min-w-0 flex-[1_1_10rem]">
                <div><b class="text-slate-800">{{ i.patientName }}</b> <span class="text-xs text-slate-500">{{ i.chartNo }}・{{ i.ward }} {{ i.bedNo }}・{{ i.deptName }} {{ i.doctorName }}</span><UBadge v-if="i.reassess" tone="gray" class="ml-1">重評</UBadge></div>
                <div class="text-xs text-slate-500">{{ i.diagnosis }}・目前飲食：{{ i.diet ?? '沒有飲食醫囑' }}・篩檢 {{ i.screenedAt.slice(5) }}</div>
              </div>
              <UButton size="sm" @click="openAssess(i)">評估</UButton>
            </li>
          </ul>
          <details v-if="work.recent.length" class="rounded-md border border-slate-200 bg-white p-3 text-sm">
            <summary class="cursor-pointer text-slate-600">最近 7 天寫的評估 {{ work.recent.length }} 筆</summary>
            <ul class="mt-2 divide-y divide-slate-100 text-xs text-slate-600">
              <li v-for="x in work.recent" :key="x.id" class="py-1">{{ x.at.slice(5) }} {{ x.bedNo }} {{ x.patientName }}・{{ x.recommendation }}<UBadge :tone="x.seenAt ? 'green' : 'yellow'" class="ml-1">{{ x.seenAt ? '主治已閱' : '主治未閱' }}</UBadge></li>
            </ul>
          </details>
        </template>
      </UQueryState>
    </template>

    <template v-else>
      <div class="flex flex-wrap items-end gap-3 print:hidden">
        <USelect v-model="q.ward" label="病房" :options="wards.map((w) => ({ label: w, value: w }))" class="w-44" />
        <UInput v-model="q.date" type="date" label="日期" class="w-40" />
        <USelect v-model="q.meal" label="餐別" :options="MEALS.map((m) => ({ label: `${m.label}（${m.at}）`, value: m.key }))" class="w-36" />
        <UButton variant="secondary" :icon="Printer" @click="print">列印</UButton>
      </div>
      <UQueryState :loading="mealLoading && !meal" :ready="!!meal">
        <article v-if="meal" class="rounded-md border border-slate-200 bg-white p-4 text-sm print:border-0 print:p-0">
          <h2 class="text-base font-bold text-slate-900">送餐清單・{{ meal.ward }}・{{ meal.date }} {{ meal.mealLabel }}</h2>
          <p class="mb-2 text-xs text-slate-600">{{ Object.entries(meal.counts).map(([k, n]) => `${k} ${n}`).join('・') || '沒有病人' }}（以 {{ MEALS.find((m) => m.key === meal!.meal)?.at }} 有效的飲食醫囑為準）</p>
          <table class="w-full text-left">
            <thead class="whitespace-nowrap border-b border-slate-300 text-xs text-slate-500"><tr><th class="py-1 pr-3">床號</th><th class="py-1 pr-3">病人</th><th class="py-1 pr-3">飲食</th><th class="py-1">過敏</th></tr></thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="r in meal.rows" :key="r.bedNo" :class="r.npo && 'text-slate-400'">
                <td class="tabular py-1 pr-3">{{ r.bedNo }}</td>
                <td class="py-1 pr-3">{{ r.patientName }} <span class="text-xs text-slate-400">{{ r.chartNo }}</span></td>
                <td class="py-1 pr-3"><b v-if="r.npo" class="text-red-700">禁食（不送）</b><template v-else><b v-if="r.tube" class="text-violet-700">送配方：</b>{{ r.dietText }}</template></td>
                <td class="py-1 text-red-700">{{ r.allergies.join('、') }}</td>
              </tr>
            </tbody>
          </table>
        </article>
      </UQueryState>
    </template>

    <UDialog v-model="open" :title="`營養評估：${target?.patientName ?? ''}`" size="lg" @submit="submit">
      <div v-if="target" class="space-y-3 text-sm">
        <NutritionPanel :admission-id="target.admissionId" class="-m-4 mb-0" />
        <div class="grid grid-cols-2 gap-3">
          <UInput v-model="form.kcal" type="number" label="建議熱量 kcal／日（選填）" :error="save.fieldErrors.value.kcal" />
          <UInput v-model="form.protein" type="number" label="建議蛋白質 g／日（選填）" :error="save.fieldErrors.value.protein" />
        </div>
        <UTextarea v-model="form.assessment" label="評估" :rows="3" required placeholder="飲食攝取、體重變化、咀嚼吞嚥、生化值" :error="save.fieldErrors.value.assessment" />
        <label class="flex items-center gap-2"><input v-model="withTube" type="checkbox" class="h-4 w-4" />建議管灌（主治可一鍵帶入成醫囑）</label>
        <div v-if="withTube" class="space-y-2 rounded-md border border-slate-200 p-3">
          <div class="grid grid-cols-2 gap-2">
            <USelect v-model="tube.formulaId" label="配方" required placeholder="選擇配方" :options="(formulas ?? []).map((x) => ({ label: x.name, value: x.id }))" :error="save.fieldErrors.value.formulaId" />
            <UInput v-model="tube.totalMl" type="number" label="每天總量 ml" :error="save.fieldErrors.value.totalMl" />
          </div>
          <fieldset class="flex gap-4">
            <label class="flex items-center gap-1.5"><input v-model="tube.mode" type="radio" value="bolus" class="h-4 w-4" />分次</label>
            <label class="flex items-center gap-1.5"><input v-model="tube.mode" type="radio" value="continuous" class="h-4 w-4" />連續</label>
          </fieldset>
          <UInput v-if="tube.mode === 'bolus'" v-model="tube.feeds" type="number" label="一天幾餐" :error="save.fieldErrors.value.feeds" />
          <UInput v-else v-model="tube.rateMlH" type="number" label="每小時 ml" :error="save.fieldErrors.value.rateMlH" />
          <p v-if="tubeFormula" class="text-xs text-slate-600">{{ tubePlanText(tubePlan, tubeFormula) }}・約 {{ tubeNutrients(tubePlan, tubeFormula).kcal }} kcal、蛋白質 {{ tubeNutrients(tubePlan, tubeFormula).protein }} g</p>
        </div>
        <UTextarea v-model="form.recommendation" label="建議" :rows="3" required placeholder="飲食種類、熱量、蛋白質、補充品、管灌（由主治開醫囑）" :error="save.fieldErrors.value.recommendation" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton type="submit" :loading="save.pending.value">送出</UButton>
      </template>
    </UDialog>
  </div>
</template>
