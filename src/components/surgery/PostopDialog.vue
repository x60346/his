<script setup lang="ts">
// 術後醫囑（主刀或本科醫師）：選這個術式的組套 → 逐項預覽（要確認的、不能套的）→ 套用；或沿用術前醫囑（寫原因）。
// 執行中的禁食醫囑要選停或保留。也可以把病人現在的醫囑存成這個術式的組套（個人或科室共用）。
// 檢查都在服務層（postop.ts，套用時每一項走住院醫囑同一份檢查）；這裡只收選擇
import { computed, reactive, ref, watch } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import { postopApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ surgeryId?: string }>()
const open = defineModel<boolean>({ default: false })

const { data: plan, loading } = useQuery(() => (props.surgeryId && open.value ? postopApi.postopPlan(props.surgeryId) : Promise.resolve(undefined)), [() => props.surgeryId, open])
const mode = ref<'set' | 'keep'>('set')
const setId = ref<string | number | undefined>('')
const picked = ref<number[]>([])
const confirmed = ref<number[]>([])
const npo = reactive<Record<string, 'stop' | 'keep' | ''>>({})
const note = ref('')
watch([open, () => props.surgeryId], () => {
  if (!open.value) return
  mode.value = 'set'
  setId.value = ''
  note.value = ''
  for (const k of Object.keys(npo)) delete npo[k]
  apply.fieldErrors.value = {}
  saving.value = false
})
watch(plan, (p) => {
  if (p && !setId.value && p.sets.length) setId.value = p.sets[0].id
  for (const o of p?.npoOrders ?? []) if (!(o.id in npo)) npo[o.id] = ''
})
const { data: preview, loading: pvLoading } = useQuery(
  () => (props.surgeryId && setId.value && mode.value === 'set' && plan.value?.canWrite ? postopApi.postopPreview(props.surgeryId, String(setId.value)) : Promise.resolve(undefined)),
  [() => props.surgeryId, setId, mode, () => plan.value?.canWrite],
)
watch(preview, (pv) => {
  picked.value = (pv ?? []).filter((x) => x.status !== 'blocked').map((x) => x.idx)
  confirmed.value = []
})
const togglePick = (i: number, on: boolean) => (picked.value = on ? [...new Set([...picked.value, i])] : picked.value.filter((x) => x !== i))
const toggleConfirm = (i: number, on: boolean) => (confirmed.value = on ? [...new Set([...confirmed.value, i])] : confirmed.value.filter((x) => x !== i))
const chosen = computed(() => plan.value?.sets.find((x) => x.id === setId.value))

const apply = useAction(postopApi.applyPostop, { success: (r) => `已開術後醫囑：${r.doneText}` })
async function submit() {
  if (!props.surgeryId) return
  const r = await apply.run(props.surgeryId, {
    ...(mode.value === 'set' && setId.value ? { setId: String(setId.value), items: picked.value, confirmed: confirmed.value } : {}),
    npo: Object.fromEntries(Object.entries(npo).filter(([, v]) => v)) as Record<string, 'stop' | 'keep'>,
    note: note.value,
  })
  if (r) open.value = false
}

// ---------- 存成組套 ----------
const saving = ref(false)
const sf = reactive({ name: '', scope: 'personal' as string | number | undefined, orderIds: [] as string[] })
function openSave() {
  Object.assign(sf, { name: plan.value ? `${plan.value.procName}術後` : '', scope: 'personal', orderIds: [] })
  saveAct.fieldErrors.value = {}
  saving.value = true
}
const saveAct = useAction(postopApi.savePostopSet, { success: (x) => `已存組套「${x.name}」（${x.items.length} 項）` })
async function saveSet() {
  if (!props.surgeryId) return
  const x = await saveAct.run(props.surgeryId, { name: sf.name, scope: String(sf.scope) as 'personal' | 'dept', orderIds: sf.orderIds })
  if (x) {
    saving.value = false
    setId.value = x.id
  }
}
const delAct = useAction(postopApi.deletePostopSet, { success: '已刪除組套' })
async function del(id: string) {
  if (await delAct.run(id)) if (setId.value === id) setId.value = ''
}
const STATUS = { ok: { label: '可套用', tone: 'green' }, confirm: { label: '要確認', tone: 'yellow' }, blocked: { label: '不能套', tone: 'red' } } as const
</script>

<template>
  <UDialog v-model="open" :title="`術後醫囑：${plan?.patientName ?? ''}`" size="lg" @submit="submit">
    <UQueryState :loading="loading && !plan" :ready="!!plan">
      <div v-if="plan" class="space-y-3 text-sm">
        <p class="text-slate-600">{{ plan.procName }}・術後醫囑由主刀或本科醫師開；套用時每一項照住院醫囑的檢查（停用、過敏、重複、劑量、交互作用）。</p>
        <p v-if="plan.doneText" class="rounded bg-emerald-50 px-3 py-2 text-emerald-800">已開：{{ plan.doneText }}</p>
        <template v-else-if="plan.canWrite">
          <fieldset class="flex flex-wrap gap-4">
            <label class="flex items-center gap-1.5"><input v-model="mode" type="radio" value="set" class="h-4 w-4 text-brand-600" />套用組套</label>
            <label class="flex items-center gap-1.5"><input v-model="mode" type="radio" value="keep" class="h-4 w-4 text-brand-600" />不套組套，沿用術前醫囑</label>
          </fieldset>

          <template v-if="mode === 'set'">
            <div class="flex flex-wrap items-end gap-2">
              <div class="min-w-[16rem] flex-1">
                <USelect v-model="setId" label="組套" :options="plan.sets.map((x) => ({ label: `${x.name}（${x.scope === 'dept' ? `${x.deptName}科室` : '個人'}・${x.items.length} 項）`, value: x.id, group: x.scope === 'dept' ? '科室組套' : '我的組套' }))" placeholder="選擇" />
              </div>
              <UButton v-if="chosen" size="sm" variant="ghost" class="text-red-700" :icon="Trash2" :loading="delAct.pending.value" @click="del(chosen.id)">刪除這個組套</UButton>
            </div>
            <p v-if="!plan.sets.length" class="text-xs text-amber-800">這個術式還沒有您能用的組套：可以先開好醫囑，再用下面的「存成組套」，或選「沿用術前醫囑」。</p>
            <p v-if="chosen?.updatedByName" class="text-xs text-slate-500">最後修改：{{ chosen.updatedByName }} {{ chosen.updatedAt.slice(5) }}</p>
            <UQueryState :loading="pvLoading && !preview" :ready="!!preview || !setId">
              <ul v-if="preview" class="divide-y divide-slate-100 rounded border border-slate-200">
                <li v-for="x in preview" :key="x.idx" class="flex flex-wrap items-start gap-2 px-3 py-1.5" :class="x.status === 'blocked' ? 'bg-slate-50 text-slate-500' : ''">
                  <UCheckbox :model-value="picked.includes(x.idx)" :disabled="x.status === 'blocked'" :label="x.text" @update:model-value="(on: boolean) => togglePick(x.idx, on)" />
                  <UBadge :tone="STATUS[x.status].tone">{{ STATUS[x.status].label }}</UBadge>
                  <div v-if="x.notes.length" class="w-full pl-6 text-xs" :class="x.status === 'blocked' ? 'text-red-700' : 'text-amber-800'">
                    {{ x.notes.join('；') }}
                    <UCheckbox v-if="x.status === 'confirm' && picked.includes(x.idx)" class="mt-0.5" :model-value="confirmed.includes(x.idx)" label="已評估，仍要開" @update:model-value="(on: boolean) => toggleConfirm(x.idx, on)" />
                  </div>
                </li>
              </ul>
            </UQueryState>
          </template>
          <p v-if="apply.fieldErrors.value.items" class="text-xs text-red-700">{{ apply.fieldErrors.value.items }}</p>

          <fieldset v-if="plan.npoOrders.length" class="space-y-1 rounded border border-amber-200 bg-amber-50/40 p-2">
            <legend class="px-1 text-xs font-semibold text-amber-900">術前禁食醫囑（要停還是保留）</legend>
            <div v-for="o in plan.npoOrders" :key="o.id" class="flex flex-wrap items-center gap-3">
              <span class="text-slate-700">{{ o.text }}</span>
              <label class="flex items-center gap-1"><input v-model="npo[o.id]" type="radio" value="stop" class="h-4 w-4" />停止</label>
              <label class="flex items-center gap-1"><input v-model="npo[o.id]" type="radio" value="keep" class="h-4 w-4" />保留</label>
              <span v-if="apply.fieldErrors.value[`npo.${o.id}`]" class="text-xs text-red-700">{{ apply.fieldErrors.value[`npo.${o.id}`] }}</span>
            </div>
          </fieldset>
          <UInput v-model="note" :label="mode === 'keep' ? '沿用術前醫囑的原因' : '備註（選填）'" :required="mode === 'keep'" :error="apply.fieldErrors.value.note" />
        </template>
        <p v-else class="text-slate-500">還不能開（手術完成後、住院中，由主刀或本科醫師開）。</p>

        <section v-if="plan.canWrite || plan.doneText" class="rounded border border-slate-200 p-2">
          <div class="flex items-center gap-2">
            <span class="text-xs font-semibold text-slate-600">存成組套</span>
            <span class="text-xs text-slate-500">把這位病人現在的醫囑存成「{{ plan.procName }}」的術後組套</span>
            <UButton v-if="!saving" size="sm" variant="secondary" class="ml-auto" @click="openSave">選醫囑</UButton>
          </div>
          <div v-if="saving" class="mt-2 space-y-2">
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <UInput v-model="sf.name" label="組套名稱" required :error="saveAct.fieldErrors.value.name" />
              <USelect v-model="sf.scope" label="給誰用" :options="[{ label: '我個人', value: 'personal' }, { label: '本科室共用', value: 'dept' }]" :error="saveAct.fieldErrors.value.scope" />
            </div>
            <div class="max-h-48 space-y-0.5 overflow-auto rounded bg-slate-50 p-2">
              <UCheckbox v-for="o in plan.orderOptions" :key="o.id" :model-value="sf.orderIds.includes(o.id)" :label="o.text" @update:model-value="(on: boolean) => (sf.orderIds = on ? [...sf.orderIds, o.id] : sf.orderIds.filter((x) => x !== o.id))" />
              <p v-if="!plan.orderOptions.length" class="text-xs text-slate-500">沒有可以存的醫囑。</p>
            </div>
            <p v-if="saveAct.fieldErrors.value.orderIds" class="text-xs text-red-700">{{ saveAct.fieldErrors.value.orderIds }}</p>
            <div class="flex justify-end gap-2">
              <UButton size="sm" variant="secondary" @click="saving = false">取消</UButton>
              <UButton size="sm" :loading="saveAct.pending.value" @click="saveSet">存組套</UButton>
            </div>
          </div>
        </section>
      </div>
    </UQueryState>
    <template #footer>
      <UButton variant="secondary" @click="open = false">{{ plan?.canWrite ? '取消' : '關閉' }}</UButton>
      <UButton v-if="plan?.canWrite" type="submit" :loading="apply.pending.value">{{ mode === 'set' ? `套用 ${picked.length} 項` : '確定沿用' }}</UButton>
    </template>
  </UDialog>
</template>
