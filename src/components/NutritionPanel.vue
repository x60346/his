<script setup lang="ts">
// 營養（護理站病人分頁「營養」、住院醫囑分頁「營養」共用）：目前飲食、營養篩檢（護理師，入院 48 小時內，簡化 NRS-2002，
// 分數即時算、和服務層同一個 nutritionScore）、營養師的評估與建議（主治按已閱；營養師在「營養」頁寫）
import { computed, reactive, ref } from 'vue'
import { ClipboardCheck } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UQueryState } from '@/components/ui'
import { bmiOf, NUTRITION_IMPAIRED, NUTRITION_RISK_FROM, NUTRITION_SEVERITY, nutritionApi, nutritionScore } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ admissionId: string }>()
const { data, loading } = useQuery(() => nutritionApi.patientNutrition(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const dueText: Record<string, string> = { todo: '待篩檢', due: '快到期', overdue: '逾時' }

const open = ref(false)
const form = reactive({ impaired: undefined as number | undefined, severity: undefined as number | undefined, heightCm: undefined as number | undefined, weightKg: undefined as number | undefined })
function openScreen() {
  const last = v.value?.screens[0]
  Object.assign(form, { impaired: undefined, severity: undefined, heightCm: last?.heightCm, weightKg: last?.weightKg })
  save.fieldErrors.value = {}
  open.value = true
}
const age70 = computed(() => (v.value?.age ?? 0) >= 70)
const live = computed(() => nutritionScore({ impaired: form.impaired, severity: form.severity, age70: age70.value }))
const save = useAction(nutritionApi.saveNutritionScreen, { success: (s) => `營養篩檢 ${s.score} 分${s.risk ? '：有營養風險，已列營養師待評估' : ''}` })
async function submit() {
  if (await save.run(props.admissionId, { impaired: form.impaired as 0, severity: form.severity as 0, heightCm: form.heightCm, weightKg: form.weightKg })) open.value = false
}
const ack = useAction(nutritionApi.ackNutritionAssessment, { success: '已閱營養評估' })
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <UQueryState :loading="loading && !v" :ready="!!v">
      <template v-if="v">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-slate-500">目前飲食</span>
          <b class="text-slate-800">{{ v.diet?.content ?? '沒有飲食醫囑' }}</b>
          <UBadge v-if="v.diet?.kind === 'npo'" tone="red">禁食</UBadge>
        </div>

        <section class="rounded-md border border-slate-200 p-3">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span class="font-semibold text-slate-700">營養篩檢</span>
            <UBadge v-if="v.screenable && v.due.status !== 'done'" :tone="v.due.status === 'overdue' ? 'red' : v.due.status === 'due' ? 'yellow' : 'cyan'">{{ dueText[v.due.status] }}（{{ v.due.dueAt.slice(5) }} 前）</UBadge>
            <UBadge v-if="v.needsDietitian" tone="purple">營養師待評估</UBadge>
            <UButton v-if="v.canScreen" class="ml-auto" size="sm" variant="secondary" :icon="ClipboardCheck" @click="openScreen">{{ v.screens.length ? '重新篩檢' : '篩檢' }}</UButton>
          </div>
          <p v-if="!v.screenable && !v.screens.length" class="text-xs text-slate-500">急診留觀不做營養篩檢（收住院後再篩）。</p>
          <p v-else-if="!v.screens.length" class="text-xs text-slate-500">還沒篩檢：入院 48 小時內要做。</p>
          <ul v-else class="space-y-1 text-xs text-slate-600">
            <li v-for="s in v.screens" :key="s.id">
              <span class="tabular">{{ s.at.slice(5) }}</span> {{ s.byName }}・<b :class="s.risk ? 'text-red-700' : 'text-slate-800'">{{ s.score }} 分</b>（營養狀態 {{ s.impaired }}＋疾病 {{ s.severity }}{{ s.age70 ? '＋70 歲以上 1' : '' }}）<template v-if="s.bmi">・BMI {{ s.bmi }}</template>
            </li>
          </ul>
        </section>

        <section class="rounded-md border border-slate-200 p-3">
          <div class="mb-2 font-semibold text-slate-700">營養師評估與建議</div>
          <p v-if="!v.assessments.length" class="text-xs text-slate-500">還沒有營養評估（篩檢 ≥{{ NUTRITION_RISK_FROM }} 分才會列營養師待評估）。</p>
          <ul v-else class="divide-y divide-slate-100">
            <li v-for="x in v.assessments" :key="x.id" class="space-y-0.5 py-2">
              <div class="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span class="tabular">{{ x.at.slice(5) }}</span>{{ x.byName }}<template v-if="x.kcal || x.protein">・建議 {{ x.kcal ? `${x.kcal} kcal` : '' }}{{ x.kcal && x.protein ? '、' : '' }}{{ x.protein ? `蛋白質 ${x.protein} g` : '' }}／日</template>
                <UBadge v-if="x.seenAt" tone="green">{{ x.seenByName }} 已閱</UBadge>
                <UBadge v-else tone="yellow">主治未閱</UBadge>
                <UButton v-if="v.canAck && !x.seenAt" size="sm" class="ml-auto" :loading="ack.pending.value" @click="ack.run(x.id)">已閱</UButton>
              </div>
              <p class="text-slate-700"><span class="text-xs text-slate-500">評估：</span>{{ x.assessment }}</p>
              <p class="text-slate-800"><span class="text-xs text-slate-500">建議：</span>{{ x.recommendation }}</p>
            </li>
          </ul>
          <p class="mt-1 text-xs text-slate-500">營養師只寫建議、不開醫囑；要改飲食或加管灌請主治開飲食醫囑。</p>
        </section>
      </template>
    </UQueryState>

    <UDialog v-model="open" title="營養篩檢（簡化 NRS-2002）" @submit="submit">
      <div class="space-y-3 text-sm">
        <fieldset>
          <legend class="mb-1 font-medium text-slate-700">營養狀態受損</legend>
          <label v-for="o in NUTRITION_IMPAIRED" :key="o.score" class="flex items-start gap-2 py-0.5"><input v-model="form.impaired" type="radio" :value="o.score" class="mt-0.5 h-4 w-4" /><span><b>{{ o.score }}</b>　{{ o.text }}</span></label>
          <p v-if="save.fieldErrors.value.impaired" class="text-xs text-red-600">{{ save.fieldErrors.value.impaired }}</p>
        </fieldset>
        <fieldset>
          <legend class="mb-1 font-medium text-slate-700">疾病嚴重度</legend>
          <label v-for="o in NUTRITION_SEVERITY" :key="o.score" class="flex items-start gap-2 py-0.5"><input v-model="form.severity" type="radio" :value="o.score" class="mt-0.5 h-4 w-4" /><span><b>{{ o.score }}</b>　{{ o.text }}</span></label>
          <p v-if="save.fieldErrors.value.severity" class="text-xs text-red-600">{{ save.fieldErrors.value.severity }}</p>
        </fieldset>
        <div class="grid grid-cols-2 gap-3">
          <UInput v-model="form.heightCm" type="number" label="身高 cm（選填）" :error="save.fieldErrors.value.heightCm" />
          <UInput v-model="form.weightKg" type="number" step="0.1" label="體重 kg（選填）" :error="save.fieldErrors.value.weightKg" :hint="bmiOf(form.heightCm, form.weightKg) ? `BMI ${bmiOf(form.heightCm, form.weightKg)}` : undefined" />
        </div>
        <p :class="['rounded px-2 py-1', live >= NUTRITION_RISK_FROM ? 'bg-red-50 text-red-800' : 'bg-slate-50 text-slate-700']">
          合計 <b>{{ live }}</b> 分<template v-if="age70">（含 70 歲以上 1 分）</template>{{ live >= NUTRITION_RISK_FROM ? '：有營養風險，送出後列營養師待評估' : '' }}
        </p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton type="submit" :loading="save.pending.value">送出</UButton>
      </template>
    </UDialog>
  </div>
</template>
