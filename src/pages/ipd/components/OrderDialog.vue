<script setup lang="ts">
// 新增住院醫囑。表單欄位依「類別」改變：
//   給藥 → 藥品、劑量、頻率、途徑；處置檢驗 → 醫令項目；飲食、護理 → 文字
// 送出時「依類別組裝」要送的欄位，而不是把整個表單丟出去——
// 否則切換類別後殘留的欄位（例如先選了藥又改成飲食）會被一起送出。
// 長期給藥：服用時機預設照主檔、可另外指定；下方預覽「每天幾點給」（和服務層排程同一個 marTimes）。
// 管制性抗生素：多一區填使用理由、感染部位（依培養結果要寫菌種）——先用後審，感染科 48 小時內審核。
// 臨時檢驗：有同管別、已收件、還在時限內的檢體，可以選「用現有檢體加做」（不用再抽血；規則在 specimen-rules.addonCheck）。
import { computed, reactive, ref, watch } from 'vue'
import { UBadge, UButton, UCheckbox, UDialog, UInput, USearchSelect, USelect, UTextarea } from '@/components/ui'
import { DIET_KINDS, hoursPerBag, tubeApi, tubeNutrients, tubePlanText, ABX_REASON_LABEL, ABX_REVIEW_HOURS, ABX_SITES, abxStewardApi, renalApi, LAB_EVERY_LABEL, type LabEvery, doseLevel, doseNote, doseStrengthText, doseUnitOf, residualOf, DRUG_TIMINGS, effectiveTiming, ipdApi, marTimes, masterApi, opdApi, specimenApi, timingApplies, TIMING_SHORT, type AdmissionView } from '@/services'
import type { OrderInput } from '@/services/ipd'
import RxAlertList from '@/components/RxAlertList.vue'
import RxAlertConfirm from '@/components/RxAlertConfirm.vue'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import type { AbxReason, Drug, DrugTiming, IpdOrderCategory, Procedure, DietKind } from '@/types'

const open = defineModel<boolean>({ default: false })
// preset：從別處帶入的給藥（例：用藥整合「續用」帶入居家用藥的藥、劑量、頻率），打開時填好，醫師確認後開立
// 長期檢驗的排程（只有處置・檢驗選「長期」時用）
const labSched = reactive({ every: 'daily' as string | number | undefined, time: '06:00' })
const props = defineProps<{ admission?: AdmissionView; preset?: { drugId: string; dose?: number; freq?: string; route?: string } }>()
const ui = useUi()

const categories: { key: IpdOrderCategory; label: string }[] = [
  { key: 'medication', label: '給藥' },
  { key: 'procedure', label: '處置・檢驗' },
  { key: 'diet', label: '飲食' },
  { key: 'nursing', label: '護理' },
]
// 飲食選種類（伙食費、送餐清單、術前禁食都看種類），細節寫在備註（例：糖尿病 1800 kcal）
const dietKind = ref<DietKind | ''>('')
// 點滴（長期、注射）：每瓶容量（從規格帶入）、每小時流速、加藥一種（例：KCl）；不排給藥時間，護理師接上換瓶
const iv = reactive({ on: false, volumeMl: 500 as number | undefined, rateMlH: 80 as number | undefined, add: null as Drug | null, addDose: 1 as number | undefined })
const canIv = computed(() => form.type === 'long' && form.drug?.category === '注射' && !form.drug.pca)
// 管灌：配方、每天總量、分次（幾餐）或連續（每小時 ml）；熱量蛋白質即時算（和服務層同一份 tubeNutrients）
const tube = reactive({ formulaId: '' as string | number | undefined, totalMl: 1500 as number | undefined, mode: 'bolus' as 'bolus' | 'continuous', feeds: 6 as number | undefined, rateMlH: 60 as number | undefined })
const { data: formulas } = useQuery(() => tubeApi.listTubeFormulas())
const tubeFormula = computed(() => formulas.value?.find((x) => x.id === tube.formulaId))
const tubePlan = computed(() => ({ formulaId: String(tube.formulaId ?? ''), totalMl: Number(tube.totalMl), mode: tube.mode, ...(tube.mode === 'bolus' ? { feeds: Number(tube.feeds) } : { rateMlH: Number(tube.rateMlH) }) }))

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
// 加做：選了臨時檢驗就查這位病人有沒有可以加做的檢體；有的話預設用它（少抽一次血）
const addonUse = ref(true)
const { data: addon } = useQuery(
  async () => (form.category === 'procedure' && form.type === 'stat' && form.proc?.labItems?.length && props.admission ? specimenApi.addonOptions(props.admission.id, form.proc.id) : undefined),
  [() => form.category, () => form.type, () => form.proc?.id, () => props.admission?.id],
)
watch(() => form.proc?.id, () => (addonUse.value = true))
const abx = reactive({ reason: '' as AbxReason | '', site: '' as string | number | undefined, organism: '', note: '' })
const ABX_REASONS = Object.keys(ABX_REASON_LABEL) as AbxReason[]

/** 給藥醫囑上次選的類型（長期／臨時），切類別回來時恢復 */
let medType: 'long' | 'stat' = 'long'
watch(open, (v) => {
  if (v) {
    medType = 'long'
    Object.assign(form, { type: 'long', category: 'medication', drug: null, dose: 1, freq: 'QD', route: 'PO', timing: '', proc: null, content: '' })
    Object.assign(abx, { reason: '', site: '', organism: '', note: '' })
    dietKind.value = ''
    Object.assign(iv, { on: false, volumeMl: 500, rateMlH: 80, add: null, addDose: 1 })
    Object.assign(tube, { formulaId: '', totalMl: 1500, mode: 'bolus', feeds: 6, rateMlH: 60 })
    save.fieldErrors.value = {}
    if (props.preset) applyPreset(props.preset)
  }
})
async function applyPreset(p: NonNullable<typeof props.preset>) {
  const d = (await masterApi.listDrugs({})).find((x) => x.id === p.drugId)
  if (!d || !open.value) return
  pickDrug(d)
  if (p.dose) form.dose = p.dose
  if (p.freq) form.freq = p.freq
  if (p.route) form.route = p.route
}
// 檢驗、處置通常是臨時醫囑；飲食、護理通常是長期醫囑
// 給藥沒有固定的預設：切到別的類別再切回來，恢復成切走前給藥用的類型（以前會停在處置的「臨時」，醫師以為開長期 BID、送出的是單次 STAT）
watch(() => form.category, (c, prev) => {
  if (prev === 'medication') medType = form.type
  if (c === 'medication') form.type = medType
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
  iv.volumeMl = Number(/([0-9]+) *ml/i.exec(d.spec)?.[1] ?? 500)
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
      return {
        ...base, content: '', drugId: form.drug.id, dose: form.dose, freq: String(form.freq), route: String(form.route), ...(showTiming.value && form.timing ? { timing: String(form.timing) as DrugTiming } : {}),
        ...(form.drug.restrictedAbx ? { abx: { reason: abx.reason as AbxReason, site: String(abx.site ?? ''), organism: abx.organism, note: abx.note } } : {}),
        ...(canIv.value && iv.on ? { dose: 1, freq: 'QD', route: 'IV', timing: undefined, infusion: { volumeMl: Number(iv.volumeMl), rateMlH: Number(iv.rateMlH), ...(iv.add ? { additives: [{ drugId: iv.add.id, dose: Number(iv.addDose) }] } : {}) } } : {}),
      }
    case 'procedure':
      if (!form.proc) return '請選擇處置或檢驗項目'
      return { ...base, content: '', procId: form.proc.id, ...(form.type === 'long' ? { labSchedule: { every: String(labSched.every) as LabEvery, time: labSched.time } } : {}), ...(form.type === 'stat' && addon.value?.ok && addonUse.value ? { addonSpecimenId: addon.value.specimen!.id } : {}) }
    case 'diet':
      if (!dietKind.value) return '請選飲食種類'
      return { ...base, content: '', diet: { kind: dietKind.value, note: form.content.trim(), ...(dietKind.value === 'tube' ? { tube: tubePlan.value } : {}) } }
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

// 抗生素：同一支 48 小時內停過（接續原療程）或換同類（抗生素療程第幾天）的提示
const { data: abxHint } = useQuery(
  async () => (open.value && props.admission && form.category === 'medication' && form.drug ? abxStewardApi.abxCourseHintOf(props.admission.id, form.drug.id) : null),
  [() => form.drug?.id, open, () => form.category, () => props.admission?.id],
)
// 腎功能：主檔有分級的藥，提示 CrCl 與建議頻率（算不出也說原因）
const { data: renalHint } = useQuery(
  async () => (open.value && props.admission && form.category === 'medication' && form.drug ? renalApi.renalHintOf(props.admission.id, form.drug.id) : null),
  [() => form.drug?.id, open, () => form.category, () => props.admission?.id],
)
// 交互作用、成分／同類重複：和這位病人執行中的其他給藥醫囑比（選了藥就提醒，送出前逐項確認）
const { data: rxAlerts } = useQuery(
  async () => (open.value && props.admission && form.category === 'medication' && form.drug ? ipdApi.orderRxAlerts(props.admission.id, form.drug.id) : []),
  [open, () => form.drug?.id, () => form.category, () => props.admission?.id],
)
const rxConfirm = ref<InstanceType<typeof RxAlertConfirm>>()

const save = useAction(ipdApi.addOrder, { success: (o) => `已開立：${o.content}${o.infusion ? '（點滴：護理站接上、換瓶）' : o.type === 'long' && o.category === 'medication' ? '（已產生給藥排程）' : ''}` })

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
      const list = same.map((o) => `・每次 ${o.dose} ${o.unit}、${o.freq}、${o.route}（${o.type === 'long' ? '長期' : '臨時'}，${o.startAt.slice(5).replace('-', '/')} 開立）`).join('\n')
      const ok = await ui.confirm({ title: '已有相同藥品的醫囑', message: `病人目前已有執行中的 ${drug.name}：\n${list}\n\n再開一筆會同時給藥。確定要再開立嗎？`, okText: '確定再開一筆', danger: true })
      if (!ok) return
      input.allowDuplicate = true
    }
    const warns = await opdApi.allergyWarnings(props.admission.patientId, [drug.id])
    if (warns.length && !(await ui.confirm({ title: '過敏警示', message: `病人對 ${warns.map((w) => w.allergen).join('、')} 過敏，${drug.name} 可能引起過敏反應。\n確認已評估風險，仍要開立？`, okText: '確認開立', danger: true }))) return
    if (warns.length) input.allergyConfirmed = true
    const alerts = await ipdApi.orderRxAlerts(props.admission.id, drug.id)
    if (alerts.length) {
      const r = await rxConfirm.value!.ask(alerts)
      if (!r) return
      input.rxAlertReasons = r
    }
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
          已選：<b>{{ form.drug.name }}</b><UBadge v-if="form.drug.highAlert" tone="purple">高警訊</UBadge><UBadge v-if="form.drug.restrictedAbx" tone="yellow">管制性抗生素</UBadge>
        </div>
        <RxAlertList :alerts="rxAlerts ?? []" />
        <p v-if="renalHint" :class="['rounded border px-2 py-1 text-xs', renalHint.advice ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-slate-200 bg-slate-50 text-slate-700']" role="status">腎功能：{{ renalHint.text }}<template v-if="renalHint.advice">。{{ renalHint.advice }}</template></p>
        <p v-if="abxHint" class="rounded border border-sky-200 bg-sky-50 px-2 py-1 text-xs text-sky-900" role="status">抗生素療程：{{ abxHint.text }}</p>
        <section v-if="canIv" class="space-y-2 rounded-md border border-sky-200 bg-sky-50/50 px-3 py-2 text-sm">
          <UCheckbox v-model="iv.on" label="點滴（連續輸注：護理師接上、換瓶，不排給藥時間）" />
          <template v-if="iv.on">
            <div class="grid grid-cols-2 gap-3">
              <UInput v-model="iv.volumeMl" type="number" label="每瓶容量 ml" :error="save.fieldErrors.value.volumeMl" />
              <UInput v-model="iv.rateMlH" type="number" label="流速 ml/小時" :error="save.fieldErrors.value.rateMlH" :hint="iv.volumeMl && iv.rateMlH ? `一瓶約 ${hoursPerBag(Number(iv.volumeMl), Number(iv.rateMlH))} 小時` : undefined" />
            </div>
            <USearchSelect label="加藥（選填）" placeholder="例：KCl" :search="(kw) => masterApi.listDrugs({ keyword: kw }).then((ds) => ds.filter((d) => d.category === '注射' && !d.pca))" :item-key="(d) => d.id" :item-label="(d) => `${d.name}　${d.nameZh}`" :clear-on-select="false" @select="(d: Drug) => (iv.add = d)" />
            <div v-if="iv.add" class="flex items-end gap-2"><span>加 <b>{{ iv.add.name }}</b></span><UInput v-model="iv.addDose" type="number" :label="`劑量（${doseUnitOf(iv.add)}）`" class="w-32" /><UButton size="sm" variant="ghost" @click="iv.add = null">不加</UButton></div>
            <p v-if="save.fieldErrors.value.additives" class="text-xs text-red-600">{{ save.fieldErrors.value.additives }}</p>
          </template>
        </section>
        <!-- 管制性抗生素：先用後審（第一劑照常給），感染科 48 小時內審核 -->
        <section v-if="form.drug?.restrictedAbx" class="space-y-2 rounded-md border border-amber-300 bg-amber-50/50 px-3 py-2">
          <div class="text-sm font-medium text-amber-900">管制性抗生素：請填使用理由（開立後照常給藥，感染科 {{ ABX_REVIEW_HOURS }} 小時內審核）</div>
          <div class="flex flex-wrap gap-4 text-sm">
            <label v-for="r in ABX_REASONS" :key="r" class="flex items-center gap-1.5">
              <input v-model="abx.reason" type="radio" name="abx-reason" :value="r" class="h-4 w-4 text-brand-600" />{{ ABX_REASON_LABEL[r] }}
            </label>
          </div>
          <p v-if="save.fieldErrors.value.abxReason" class="text-xs text-red-600">{{ save.fieldErrors.value.abxReason }}</p>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <USelect v-model="abx.site" label="感染部位" required :options="ABX_SITES" placeholder="選擇部位" :error="save.fieldErrors.value.abxSite" />
            <UInput v-if="abx.reason === 'culture'" v-model="abx.organism" label="菌種" required :error="save.fieldErrors.value.abxOrganism" />
          </div>
          <UInput v-model="abx.note" label="說明（選填，例：敗血性休克、先前 Ceftriaxone 治療 3 天無效）" />
        </section>
        <!-- 點滴：劑量（一瓶）、頻率、給藥排程都不用填（護理師接上、換瓶） -->
        <div v-if="!(canIv && iv.on)" class="grid grid-cols-3 gap-3">
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
        <div v-if="showTiming && !(canIv && iv.on)" class="grid grid-cols-3 gap-3">
          <USelect v-model="form.timing" label="服用時機" :options="timingOptions" :error="save.fieldErrors.value.timing" />
        </div>
        <p v-if="form.type === 'long' && form.freq !== 'PRN' && !(canIv && iv.on)" class="text-xs text-slate-500">
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
        <!-- 長期：只有檢驗（每日血糖、每週一三五 CBC）；每一次到期會出現在護理站「檢體」待採檢 -->
        <div v-if="form.type === 'long'" class="grid grid-cols-2 gap-3 rounded-md border border-sky-200 bg-sky-50/50 p-2">
          <USelect v-model="labSched.every" label="頻率" :options="Object.entries(LAB_EVERY_LABEL).map(([k, l]) => ({ label: l, value: k }))" :error="save.fieldErrors.value.labEvery" />
          <UInput v-model="labSched.time" type="time" label="抽血時間" :error="save.fieldErrors.value.labTime" />
          <p class="col-span-2 text-xs text-slate-600">長期的處置只能開檢驗；每一次到期會出現在護理站「檢體」待採檢，每次一份報告。</p>
        </div>
        <div v-if="form.type === 'stat' && addon" :class="['space-y-1 rounded-md border p-2 text-xs', addon.ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200 bg-slate-50']">
          <template v-if="addon.ok">
            <UCheckbox v-model="addonUse" :label="`用現有檢體加做（${addon.tubeLabel}，條碼 ${addon.specimen!.barcode}，採檢 ${addon.specimen!.collectedAt.slice(5).replace('-', '/')}）`" />
            <p class="text-slate-600">這支檢體在驗：{{ addon.specimen!.tests.join('、') }}；可加做到 {{ addon.specimen!.until.slice(5).replace('-', '/') }}。勾選就不用再抽血，檢驗科直接驗；不勾＝護理站重新採檢。</p>
          </template>
          <p v-else class="text-slate-600">不能加做：{{ addon.reason }}（護理站會重新採檢）</p>
        </div>
        <UTextarea v-model="form.content" label="備註（選填）" :rows="2" />
      </template>

      <!-- 飲食、護理 -->
      <template v-else>
        <div v-if="form.category === 'diet'" class="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          <label v-for="k in DIET_KINDS" :key="k.kind" :class="['cursor-pointer rounded-md border-2 px-2 py-1 text-sm', dietKind === k.kind ? 'border-brand-500 bg-brand-50' : 'border-slate-200']" :title="k.hint">
            <input v-model="dietKind" type="radio" :value="k.kind" class="sr-only" />{{ k.label }}
            <span class="block text-xs text-slate-500">{{ k.hint }}</span>
          </label>
        </div>
        <div v-if="form.category === 'diet' && dietKind === 'tube'" class="space-y-2 rounded-md border border-slate-200 p-3">
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <USelect v-model="tube.formulaId" label="配方" required placeholder="選擇配方" :options="(formulas ?? []).map((x) => ({ label: x.name, value: x.id }))" :error="save.fieldErrors.value.formulaId" />
            <UInput v-model="tube.totalMl" type="number" label="每天總量 ml" required :error="save.fieldErrors.value.totalMl" />
          </div>
          <fieldset class="flex flex-wrap items-center gap-4 text-sm">
            <label class="flex items-center gap-1.5"><input v-model="tube.mode" type="radio" value="bolus" class="h-4 w-4" />分次</label>
            <label class="flex items-center gap-1.5"><input v-model="tube.mode" type="radio" value="continuous" class="h-4 w-4" />連續（灌食機）</label>
          </fieldset>
          <UInput v-if="tube.mode === 'bolus'" v-model="tube.feeds" type="number" label="一天幾餐（06:00–21:00 平均分）" :error="save.fieldErrors.value.feeds" />
          <UInput v-else v-model="tube.rateMlH" type="number" label="每小時 ml" :error="save.fieldErrors.value.rateMlH" />
          <p v-if="tubeFormula && tube.totalMl" class="text-xs text-slate-600">{{ tubePlanText(tubePlan, tubeFormula) }}・約 {{ tubeNutrients(tubePlan, tubeFormula).kcal }} kcal、蛋白質 {{ tubeNutrients(tubePlan, tubeFormula).protein }} g／日</p>
          <p v-if="save.fieldErrors.value.diet" class="text-xs text-red-600">{{ save.fieldErrors.value.diet }}</p>
        </div>
        <UTextarea v-model="form.content" :label="form.category === 'diet' ? '備註（選填：熱量、質地、限水…）' : '護理醫囑'" :rows="form.category === 'diet' ? 2 : 3" :placeholder="form.category === 'nursing' ? '例：Vital signs Q4H、翻身 Q2H、記錄輸入輸出量' : form.category === 'diet' ? '例：1800 kcal、限水 1000 ml' : ''" />
        <p v-if="form.category === 'diet' && form.type === 'long'" class="text-xs text-slate-500">同一時間只能有一種飲食，開立後原本的飲食醫囑會自動停止。</p>
      </template>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :loading="save.pending.value" @click="submit">開立</UButton>
    </template>
  </UDialog>
  <RxAlertConfirm ref="rxConfirm" />
</template>
