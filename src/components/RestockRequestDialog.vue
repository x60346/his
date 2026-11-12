<script setup lang="ts">
// 補貨申請（U25）：調劑窗口缺藥、藥品庫存頁偏低時共用。
// 只問「要多少」——批號、效期要等貨到了看包裝才知道，到貨入庫時才填。
// 申請是「門診藥局的需求」：小型醫院由採購單滿足（開單時勾選帶入），大型醫院由藥庫撥補滿足（請領時勾選帶入）。
// 以前窗口的「補貨」直接開進貨單，病人在窗口等，藥師得憑空編一個批號和效期。
import { reactive, ref, watch } from 'vue'
import { UButton, UDialog, UInput, UQueryState } from '@/components/ui'
import { inventoryApi, type RestockPlan } from '@/services'
import { useAction } from '@/composables/useService'
import { useWorkLocation } from '@/composables/useWorkLocation'

const work = useWorkLocation()

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ drugId?: string; dispenseId?: string; pickupNo?: number }>()
const emit = defineEmits<{ done: [] }>()

const plan = ref<RestockPlan>()
const loadErr = ref(false)
const form = reactive({ qty: undefined as number | undefined, note: '' })
// 每次打開都重新取：建議量依「現在」的庫存、等待中的處方、已申請未到貨的量算
watch(open, async (v) => {
  if (!v || !props.drugId) return
  plan.value = undefined
  loadErr.value = false
  save.fieldErrors.value = {}
  try {
    const p = await inventoryApi.getRestockPlan(props.drugId)
    plan.value = p
    Object.assign(form, { qty: p.suggestion.qty, note: '' })
  } catch {
    loadErr.value = true
  }
})

const save = useAction(inventoryApi.requestRestock, {
  success: (r) => `${r.drugName} 補貨申請：共 ${r.qty} ${r.unit}，待到貨${r.waiting.length ? `（${r.waiting.length} 位病人等候中）` : ''}`,
})
async function submit() {
  if (!props.drugId) return
  const ok = await save.run({ drugId: props.drugId, qty: form.qty ?? 0, dispenseId: props.dispenseId, note: form.note })
  if (ok) {
    open.value = false
    emit('done')
  }
}
const hm = (t: string) => t.slice(5, 16).replace('-', '/')
</script>

<template>
  <UDialog v-model="open" @submit="submit" :title="plan?.open ? `追加補貨申請：${plan.drugName}` : `申請補貨：${plan?.drugName ?? ''}`" size="sm">
    <UQueryState :loading="!plan && !loadErr" :ready="!!plan" empty-title="無法取得庫存資料">
      <div v-if="plan" class="space-y-3 text-sm">
        <p class="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {{ work.multi.value ? '申請後到「藥品庫存 → 撥補單」向藥庫請領（需求清單會列出這張申請）；門診藥局簽收後自動結案。' : '申請後到「藥品庫存 → 採購單」開單（需求清單會列出這張申請）；到貨入庫後自動結案。' }}
        </p>
        <dl class="grid grid-cols-3 gap-2 text-center">
          <div class="rounded-md bg-slate-50 p-2">
            <dt class="text-xs text-slate-500">現有可用</dt>
            <dd v-if="plan.counting" class="text-xs text-violet-700">盤點中</dd>
            <dd v-else class="tabular font-semibold text-slate-800">{{ plan.usable }} <span class="text-xs font-normal text-slate-400">{{ plan.unit }}</span></dd>
          </div>
          <div class="rounded-md bg-slate-50 p-2">
            <dt class="text-xs text-slate-500">等待中的處方</dt>
            <dd class="tabular font-semibold text-slate-800">{{ plan.need }} <span class="text-xs font-normal text-slate-400">（{{ plan.waitingCount }} 張）</span></dd>
          </div>
          <div class="rounded-md bg-slate-50 p-2">
            <dt class="text-xs text-slate-500">安全庫存</dt>
            <dd class="tabular font-semibold text-slate-800">{{ plan.safetyStock }}</dd>
          </div>
        </dl>

        <div v-if="plan.open" class="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sky-900">
          已有一張待到貨的申請：<b class="tabular">{{ plan.open.qty }}</b> {{ plan.unit }}<template v-if="plan.open.receivedQty">（已到 {{ plan.open.receivedQty }}，尚欠 {{ plan.open.outstanding }}）</template>，
          {{ plan.open.requestedByName }} {{ hm(plan.open.requestedAt) }} 申請。
          <div class="text-xs text-sky-800">這次填的數量會<b>加到這張申請</b>，不另開一張<template v-if="pickupNo">；領藥號 {{ pickupNo }} 會加入等待名單</template>。</div>
        </div>

        <UInput
          v-model="form.qty"
          :label="plan.open ? '追加數量' : '申請數量'"
          type="number"
          :min="plan.open ? 0 : 1"
          required
          :hint="`建議：${plan.suggestion.formula}`"
          :error="save.fieldErrors.value.qty"
        />
        <UInput v-model="form.note" label="備註（選填）" placeholder="例：請藥商下午送達" />
        <p v-if="pickupNo" class="text-xs text-slate-500">申請後，領藥號 {{ pickupNo }} 要等到貨入庫才能核對、發藥；也可以請醫師改開替代藥。</p>
      </div>
    </UQueryState>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :loading="save.pending.value" :disabled="!plan" type="submit">{{ plan?.open ? '追加申請' : '送出申請' }}</UButton>
    </template>
  </UDialog>
</template>
