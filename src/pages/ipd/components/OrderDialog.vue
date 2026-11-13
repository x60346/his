<script setup lang="ts">
// 新增住院醫囑。表單欄位依「類別」改變：
//   給藥 → 藥品、劑量、頻率、途徑；處置檢驗 → 醫令項目；飲食、護理 → 文字
// 送出時「依類別組裝」要送的欄位，而不是把整個表單丟出去——
// 否則切換類別後殘留的欄位（例如先選了藥又改成飲食）會被一起送出。
// 長期給藥：服用時機預設照主檔、可另外指定；下方預覽「每天幾點給」（和服務層排程同一個 marTimes）。
import { computed, reactive, watch } from 'vue'
import { UBadge, UButton, UDialog, UInput, USearchSelect, USelect, UTextarea } from '@/components/ui'
import { doseLevel, doseNote, doseStrengthText, doseUnitOf, residualOf, DRUG_TIMINGS, effectiveTiming, ipdApi, marTimes, masterApi, opdApi, timingApplies, TIMING_SHORT, type AdmissionView } from '@/services'
import type { OrderInput } from '@/services/ipd'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import type { Drug, DrugTiming, IpdOrderCategory, Procedure } from '@/types'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ admission?: AdmissionView }>()
const ui = useUi()

const categories: { key: IpdOrderCategory; label: string }[] = [
  { key: 'medication', label: '給藥' },
  { key: 'procedure', label: '處置・檢驗' },
  { key: 'diet', label: '飲食' },
  { key: 'nursing', label: '護理' },
]
const dietPresets = ['普通飲食', '軟質飲食', '流質飲食', '禁食', '糖尿病飲食 1800 kcal', '低鹽飲食', '低蛋白飲食']

const form = reactive({
  type: 'long' as 'long' | 'stat',
  category: 'medication' as IpdOrderCategory,
  drug: null as Drug | null,
  dose: 1 as number | undefined,
  freq: 'QD' as string | number | undefined,
  route: 'PO' as string | number | undefined,
  /** 空＝照主檔 */
  timing: '' as string | number | undefined,
  proc: null as Procedure | null,
  content: '',
})

watch(open, (v) => {
  if (v) Object.assign(form, { type: 'long', category: 'medication', drug: null, dose: 1, freq: 'QD', route: 'PO', timing: '', proc: null, content: '' })
})
// 檢驗、處置通常是臨時醫囑；飲食、護理通常是長期醫囑
watch(() => form.category, (c) => {
  if (c === 'procedure') form.type = 'stat'
  if (c === 'diet' || c === 'nursing') form.type = 'long'
})

const { data: freqList } = useQuery(() => masterApi.listFrequencies())
// 長期醫囑不可用 STAT；臨時給藥固定為 STAT
const freqOptions = computed(() => (freqList.value ?? []).filter((f) => (form.type === 'long' ? f.code !== 'STAT' : f.code === 'STAT' || f.code === 'PRN')).map((f) => ({ label: `${f.code}　${f.label}`, value: f.code })))
watch(() => form.type, (t) => {
  if (t === 'stat') form.freq = 'STAT'
  else if (form.freq === 'STAT') form.freq = 'QD'
})
const routeOptions = masterApi.staticCodes.routes.map((r) => ({ label: `${r.code}　${r.name}`, value: r.code }))

/** 長期給藥、口服、非睡前／需要時：才有服用時機可選 */
const showTiming = computed(() => !!form.drug && form.type === 'long' && timingApplies(String(form.freq), String(form.route)))
const timingOptions = computed(() => {
  const master = form.drug?.timing ?? 'ANY'
  return [{ label: `照主檔（${TIMING_SHORT[master]}）`, value: '' }, ...DRUG_TIMINGS.filter((t) => t !== master).map((t) => ({ label: TIMING_SHORT[t], value: t }))]
})
/** 每天的給藥時間預覽（長期、有固定時間的） */
const schedulePreview = computed(() => {
  if (!form.drug || form.type !== 'long') return []
  const f = (freqList.value ?? []).find((x) => x.code === form.freq)
  if (!f) return []
  const rx = showTiming.value && form.timing ? (String(form.timing) as DrugTiming) : undefined
  return marTimes(f.code, f.times, effectiveTiming(form.drug.timing, rx), String(form.route))
})

function pickDrug(d: Drug) {
  form.drug = d
  form.dose = d.defaultDose
  form.route = d.defaultRoute
  form.timing = ''
  if (form.type === 'long') form.freq = d.defaultFreq === 'PRN' ? 'PRN' : d.defaultFreq
}

/** 依類別組裝要送出的資料：只帶這個類別需要的欄位 */
function buildInput(): OrderInput | string {
  const a = props.admission!
  const base = { admissionId: a.id, type: form.type, category: form.category, content: form.content.trim() }
  switch (form.category) {
    case 'medication':
      if (!form.drug) return '請選擇藥品'
      if (!form.dose || form.dose <= 0) return '請輸入劑量'
      return { ...base, content: '', drugId: form.drug.id, dose: form.dose, freq: String(form.freq), route: String(form.route), ...(showTiming.value && form.timing ? { timing: String(form.timing) as DrugTiming } : {}) }
    case 'procedure':
      if (!form.proc) return '請選擇處置或檢驗項目'
      return { ...base, content: '', procId: form.proc.id }
    default:
      if (!base.content) return '請輸入醫囑內容'
      return base
  }
}

/** 劑量即時提示：與服務層同一條規則（偏高需確認、不合理直接擋） */
const doseCheck = computed(() => {
  if (!form.drug || !form.dose) return { level: 'ok' as const, text: '' }
  const level = doseLevel(form.drug, form.dose)
  return { level, text: level === 'ok' ? '' : doseNote(form.drug, form.dose) }
})

const save = useAction(ipdApi.addOrder, { success: (o) => `已開立：${o.content}${o.type === 'long' && o.category === 'medication' ? '（已產生給藥排程）' : ''}` })

async function submit() {
  const input = buildInput()
  if (typeof input === 'string') return ui.toast.warning(input)

  // 多重把關：過敏、高警訊藥品都要醫師再確認一次。
  // 判斷依據是「組裝好要送出的 input」，不是表單：表單上可能殘留切換類別前選的藥
  const drug = input.drugId ? form.drug : null
  if (drug && props.admission) {
    // 劑量：不合理的直接擋（幾乎一定是打錯）；偏高的請醫師再確認一次
    const level = doseLevel(drug, input.dose ?? 0)
    if (level === 'absurd') return ui.toast.warning(`${doseNote(drug, input.dose ?? 0)}，請確認是否打錯`)
    if (level === 'high') {
      const ok = await ui.confirm({ title: '劑量偏高', message: `${drug.name}
${doseNote(drug, input.dose ?? 0)}。

確定劑量無誤？`, okText: '劑量無誤，開立', danger: true })
      if (!ok) return
      input.confirmHighDose = true
    }
    // 已有執行中的同一種藥：列出來讓醫師判斷是忘了已開過，還是刻意加開
    const same = await ipdApi.listActiveSameDrug(props.admission.id, drug.id)
    if (same.length) {
      const list = same.map((o) => `・每次 ${o.dose} ${o.unit}、${o.freq}、${o.route}（${o.type === 'long' ? '長期' : '臨時'}，${o.startAt.slice(5)} 開立）`).join('\n')
      const ok = await ui.confirm({ title: '已有相同藥品的醫囑', message: `病人目前已有執行中的 ${drug.name}：\n${list}\n\n再開一筆會同時給藥。確定要再開立嗎？`, okText: '確定再開一筆', danger: true })
      if (!ok) return
      input.allowDuplicate = true
    }
    const warns = await opdApi.allergyWarnings(props.admission.patientId, [drug.id])
    if (warns.length && !(await ui.confirm({ title: '過敏警示', message: `病人對 ${warns.map((w) => w.allergen).join('、')} 過敏，${drug.name} 可能引起過敏反應。\n確認已評估風險，仍要開立？`, okText: '確認開立', danger: true }))) return
    if (drug.highAlert && !(await ui.confirm({ title: '高警訊藥品', message: `${drug.name} 為高警訊藥品。\n請再次確認：每次 ${input.dose} ${doseUnitOf(drug)}、${input.freq}、${input.route}`, okText: '劑量正確，開立' }))) return
  }
  if (await save.run(input)) open.value = false
}
</script>

<template>
  <UDialog v-model="open" :title="`新增醫囑：${admission?.patientName ?? ''}`" size="lg">
    <div class="space-y-4">
      <div class="flex flex-wrap gap-4">
        <div>
          <div class="mb-1 text-xs font-medium text-slate-600">類別</div>
          <div class="flex gap-1">
            <button
              v-for="c in categories"
              :key="c.key"
              :class="['rounded-md border px-3 py-1.5 text-sm', form.category === c.key ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50']"
              @click="form.category = c.key"
            >{{ c.label }}</button>
          </div>
        </div>
        <div>
          <div class="mb-1 text-xs font-medium text-slate-600">醫囑類型</div>
          <div class="flex gap-1">
            <button
              v-for="t in [{ k: 'long', l: '長期' }, { k: 'stat', l: '臨時（單次）' }] as const"
              :key="t.k"
              :class="['rounded-md border px-3 py-1.5 text-sm', form.type === t.k ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50']"
              @click="form.type = t.k"
            >{{ t.l }}</button>
          </div>
        </div>
      </div>

      <!-- 給藥 -->
      <template v-if="form.category === 'medication'">
        <USearchSelect
          label="藥品"
          placeholder="藥名、中文名、作用，例：Ceftriaxone、胰島素、止痛"
          :search="(kw) => masterApi.listDrugs({ keyword: kw })"
          :item-key="(d) => d.id"
          :item-label="(d) => `${d.name}　${d.nameZh}${d.highAlert ? '　⚠ 高警訊' : ''}`"
          :item-sub="(d) => `${d.category}・${d.spec}・${d.indication}・可用 ${d.usable}`"
          :clear-on-select="false"
          @select="pickDrug"
        />
        <div v-if="form.drug" class="flex items-center gap-2 text-sm">
          已選：<b>{{ form.drug.name }}</b><UBadge v-if="form.drug.highAlert" tone="purple">高警訊</UBadge>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <UInput
            v-model="form.dose"
            label="每次劑量"
            type="number"
            min="0"
            step="0.5"
            :hint="doseCheck.level === 'high' ? `⚠ 劑量偏高：${doseCheck.text}` : form.drug ? `${doseUnitOf(form.drug)}${doseStrengthText(form.drug, form.dose) ? `（＝${doseStrengthText(form.drug, form.dose)}）` : ''}${residualOf(form.drug, form.dose) ? `・管制藥：給藥時整支扣，殘餘 ${residualOf(form.drug, form.dose)!.residual} 要見證銷毀` : ''}` : ''"
            :error="doseCheck.level === 'absurd' ? `${doseCheck.text}，請確認是否打錯` : save.fieldErrors.value.dose"
          />
          <USelect v-model="form.freq" label="頻率" :options="freqOptions" />
          <USelect v-model="form.route" label="途徑" :options="routeOptions" />
        </div>
        <div v-if="showTiming" class="grid grid-cols-3 gap-3">
          <USelect v-model="form.timing" label="服用時機" :options="timingOptions" :error="save.fieldErrors.value.timing" />
        </div>
        <p v-if="form.type === 'long' && form.freq !== 'PRN'" class="text-xs text-slate-500">
          長期給藥醫囑開立後，系統會依頻率產生今天與明天的給藥排程，護理站即可看到。
          <template v-if="schedulePreview.length"><br />每天給藥時間：<b class="tabular text-slate-700">{{ schedulePreview.join('、') }}</b><template v-if="showTiming">（依服用時機對齊病房用餐時間）</template></template>
        </p>
        <p v-if="form.freq === 'PRN'" class="text-xs text-slate-500">PRN（需要時）不產生固定排程，由護理師依病人狀況給藥並記錄原因。</p>
      </template>

      <!-- 處置・檢驗 -->
      <template v-else-if="form.category === 'procedure'">
        <USearchSelect
          label="處置・檢驗・影像"
          placeholder="例：CBC、胸部 X 光、CRP"
          :search="async (kw) => (await masterApi.listProcedures({ keyword: kw })).filter((p) => p.category !== '診察')"
          :item-key="(p) => p.id"
          :item-label="(p) => `${p.code}　${p.name}`"
          :item-sub="(p) => p.category"
          :clear-on-select="false"
          :search-empty="true"
          @select="(p) => (form.proc = p)"
        />
        <UTextarea v-model="form.content" label="備註（選填）" :rows="2" />
      </template>

      <!-- 飲食、護理 -->
      <template v-else>
        <div v-if="form.category === 'diet'" class="flex flex-wrap gap-1.5">
          <UButton v-for="p in dietPresets" :key="p" size="sm" variant="secondary" @click="form.content = p">{{ p }}</UButton>
        </div>
        <UTextarea v-model="form.content" :label="form.category === 'diet' ? '飲食醫囑' : '護理醫囑'" :rows="3" :placeholder="form.category === 'nursing' ? '例：Vital signs Q4H、翻身 Q2H、記錄輸入輸出量' : ''" />
        <p v-if="form.category === 'diet' && form.type === 'long'" class="text-xs text-slate-500">同一時間只能有一種飲食，開立後原本的飲食醫囑會自動停止。</p>
      </template>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :loading="save.pending.value" @click="submit">開立</UButton>
    </template>
  </UDialog>
</template>
