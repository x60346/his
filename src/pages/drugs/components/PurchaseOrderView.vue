<script setup lang="ts">
// 一張採購單：
//   新單／草稿（藥師）：供應商（主檔裡啟用中的）、預計到貨日、品項（可從「需求清單」勾選帶入補貨申請與低於安全庫存的藥）→ 存草稿、送出
//   選了供應商，每一行顯示「這家上次的進價」（供應商主檔的價格紀錄，supplierPrices）
//   待核准（管理員）：核准或退回（寫原因）
//   已訂購（藥師）：每一行「到貨入庫」（批號效期照實物，可分批）；短交結案、取消
// 金額、尚未到貨數量、誰能做什麼都由服務層判斷；這裡照資料顯示。
import { computed, reactive, ref, watch } from 'vue'
import { Check, PackageCheck, Plus, Send, Trash2 } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState, USelect, UTextarea } from '@/components/ui'
import ReceiveStockDialog from '@/components/ReceiveStockDialog.vue'
import { masterApi, purchaseApi, purchaseTotal, type PurchaseLineView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import { PURCHASE_STATUS } from './purchaseStatus'

const props = defineProps<{ orderId?: string }>()
const emit = defineEmits<{ created: [id: string] }>()
const auth = useAuth()
const ui = useUi()
const role = computed(() => auth.user?.role)

const { data, loading } = useQuery(async () => (props.orderId ? purchaseApi.getPurchaseOrder(props.orderId) : undefined), [() => props.orderId])
const po = computed(() => data.value)
const editable = computed(() => role.value === 'pharmacist' && (!props.orderId || po.value?.status === 'draft'))

// ---------- 草稿表單 ----------
type FormLine = { drugId: string | number; qty?: number; unitCost?: number; restockId?: string }
const form = reactive({ supplierId: '' as string | number, expectedDate: '', note: '', lines: [] as FormLine[] })
watch(po, (p) => {
  if (!p) return
  Object.assign(form, { supplierId: p.supplierId, expectedDate: p.expectedDate ?? '', note: p.note ?? '', lines: p.lines.map((l) => ({ drugId: l.drugId, qty: l.qty, unitCost: l.unitCost, restockId: l.restockId })) })
}, { immediate: true })
const { data: drugs } = useQuery(() => masterApi.listDrugs())
const drugOptions = computed(() => (drugs.value ?? []).map((d) => ({ label: `${d.name}（${d.nameZh}）`, value: d.id })))
const unitOf = (id: string | number) => drugs.value?.find((d) => d.id === id)?.unit ?? ''
// 供應商選單：啟用中的；草稿上的供應商若已停用，也列出來（標停用）讓藥師看得到、改選
const { data: suppliers } = useQuery(() => purchaseApi.listSuppliers({ includeInactive: true }))
const supplierOptions = computed(() =>
  (suppliers.value ?? []).filter((x) => x.active || x.id === po.value?.supplierId).map((x) => ({ label: x.active ? x.name : `${x.name}（已停用）`, value: x.id })),
)
const activeSupplier = (id?: string) => suppliers.value?.find((x) => x.id === id && x.active)
// 這家以前的進價：每一行提示「這家上次 X 元」
const { data: prices } = useQuery(async () => (editable.value && form.supplierId ? purchaseApi.supplierPrices(String(form.supplierId)) : []), [editable, () => form.supplierId])
const priceOf = (drugId: string | number) => prices.value?.find((x) => x.drugId === drugId)
const draftTotal = computed(() => purchaseTotal(form.lines.map((l) => ({ qty: l.qty ?? 0, unitCost: l.unitCost ?? 0 }))))

// 需求清單：待處理的補貨申請＋採購入庫地點低於安全庫存的藥（建議量由服務層算）
const { data: candidates } = useQuery(async () => (editable.value ? purchaseApi.purchaseCandidates() : []), [editable])
const inForm = (drugId: string) => form.lines.some((l) => l.drugId === drugId)
function toggleCandidate(c: NonNullable<typeof candidates.value>[number], on: boolean) {
  // 還沒選供應商：帶入上次買這種藥的那家（還在往來的才帶）
  if (on && !form.supplierId && c.last && activeSupplier(c.last.supplierId)) form.supplierId = c.last.supplierId
  // 進價：已選的那家買過就用它上次的價格，否則用上次（不論哪家）的
  if (on && !inForm(c.drugId)) form.lines.push({ drugId: c.drugId, qty: c.suggestedQty || undefined, unitCost: priceOf(c.drugId)?.unitCost ?? c.last?.unitCost, restockId: c.restock?.id })
  if (!on) form.lines = form.lines.filter((l) => l.drugId !== c.drugId)
}

function candNote(c: NonNullable<typeof candidates.value>[number]) {
  if (c.restock) return `補貨申請尚欠 ${c.restock.outstanding}${c.restock.waiting ? `（${c.restock.waiting} 人等）` : ''}`
  return `低於安全庫存（可用 ${c.usable}／安全 ${c.safetyStock}）`
}

const save = useAction(purchaseApi.savePurchaseDraft, { success: (p) => `已儲存 ${p.no}` })
const payload = () => ({
  id: props.orderId,
  supplierId: String(form.supplierId ?? ''),
  expectedDate: form.expectedDate || undefined,
  note: form.note,
  lines: form.lines.map((l) => ({ drugId: String(l.drugId ?? ''), qty: l.qty as number, unitCost: l.unitCost as number, ...(l.restockId ? { restockId: l.restockId } : {}) })),
})
async function onSave() {
  const p = await save.run(payload())
  if (p && !props.orderId) emit('created', p.id)
  return p
}
const submit = useAction(purchaseApi.submitPurchase, { success: (p) => `已送出 ${p.no}，等管理員核准` })
async function onSubmit() {
  const p = await save.run(payload())
  if (!p) return
  if (await ui.confirm({ title: '送出採購單', message: `${p.supplier}，${p.lines.length} 項，共 ${p.total.toLocaleString()} 元。送出後由管理員核准才算訂購。`, okText: '送出' })) await submit.run(p.id)
  if (!props.orderId) emit('created', p.id)
}

// ---------- 核准／退回、結案、取消 ----------
const approve = useAction(purchaseApi.approvePurchase, { success: (p) => `已核准 ${p.no}，可向 ${p.supplier} 訂購` })
async function onApprove() {
  const p = po.value
  if (p && (await ui.confirm({ title: '核准採購單', message: `${p.no} ${p.supplier}：${p.lines.length} 項，共 ${p.total.toLocaleString()} 元。`, okText: '核准' }))) await approve.run(p.id)
}
const reject = useAction(purchaseApi.rejectPurchase, { success: (p) => `已退回 ${p.no}` })
const close = useAction(purchaseApi.closePurchase, { success: (p) => `${p.no} 已短交結案` })
const cancel = useAction(purchaseApi.cancelPurchase, { success: (p) => `已取消 ${p.no}` })
const reasonFor = ref<'' | 'reject' | 'close' | 'cancel'>('')
const reasonText = ref('')
const reasonAction = computed(() => (reasonFor.value === 'reject' ? reject : reasonFor.value === 'close' ? close : cancel))
function openReason(k: 'reject' | 'close' | 'cancel') {
  reasonText.value = ''
  reject.fieldErrors.value = {}
  close.fieldErrors.value = {}
  cancel.fieldErrors.value = {}
  reasonFor.value = k
}
async function onReason() {
  const p = po.value
  if (p && (await reasonAction.value.run(p.id, reasonText.value))) reasonFor.value = ''
}
const REASON_TITLE = { reject: '退回採購單', close: '短交結案', cancel: '取消採購單' } as const

// ---------- 到貨 ----------
const receiving = ref<PurchaseLineView>()
const receiveOpen = ref(false)
function startReceive(l: PurchaseLineView) {
  receiving.value = l
  receiveOpen.value = true
}
const anyReceived = computed(() => (po.value?.lines ?? []).some((l) => l.receivedQty > 0))
const md = (t?: string) => (t ? t.slice(5, 16).replace('-', '/') : '')
</script>

<template>
  <UQueryState :loading="!!orderId && loading && !po" :ready="!orderId || !!po">
    <div class="space-y-3">
      <header class="flex flex-wrap items-start gap-2">
        <div class="min-w-0 flex-1">
          <h2 class="tabular flex items-center gap-2 text-lg font-bold text-slate-800">
            {{ po?.no ?? '新採購單' }}<UBadge v-if="po" :tone="PURCHASE_STATUS[po.status].tone">{{ PURCHASE_STATUS[po.status].label }}</UBadge>
          </h2>
          <template v-if="po">
            <p class="text-xs text-slate-500">{{ po.createdByName }} {{ md(po.createdAt) }} 開單・入{{ po.locationName }}</p>
            <p v-if="po.approvedByName" class="text-xs text-slate-500">{{ po.approvedByName }} {{ md(po.approvedAt) }} 核准</p>
            <p v-for="(r, i) in po.rejections ?? []" :key="i" class="text-xs text-amber-700">曾被退回（{{ md(r.at) }}）：{{ r.reason }}</p>
            <p v-if="po.closeReason" class="text-xs text-slate-500">{{ po.closedByName }} {{ PURCHASE_STATUS[po.status].label }}：{{ po.closeReason }}</p>
          </template>
        </div>
        <template v-if="po?.status === 'pending' && role === 'admin'">
          <UButton size="sm" variant="secondary" @click="openReason('reject')">退回</UButton>
          <UButton size="sm" :icon="Check" :loading="approve.pending.value" @click="onApprove">核准</UButton>
        </template>
        <UButton v-if="po?.status === 'ordered' && anyReceived" size="sm" variant="ghost" @click="openReason('close')">短交結案</UButton>
        <UButton v-if="po && ['draft', 'pending', 'ordered'].includes(po.status) && !anyReceived" size="sm" variant="ghost" @click="openReason('cancel')">取消採購單</UButton>
      </header>
      <p v-if="po?.status === 'pending' && role !== 'admin'" class="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">待管理員核准；核准後才算正式訂購，貨到了在這裡對品項入庫。</p>

      <!-- 草稿：可編輯 -->
      <template v-if="editable">
        <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          <USelect v-model="form.supplierId" label="供應商" required :options="supplierOptions" placeholder="選擇供應商" hint="主檔在「供應商」分頁維護" :error="save.fieldErrors.value.supplierId" />
          <UInput v-model="form.expectedDate" label="預計到貨日（選填）" type="date" :error="save.fieldErrors.value.expectedDate" />
          <UInput v-model="form.note" label="備註（選填）" />
        </div>

        <section v-if="candidates?.length" class="rounded-md border border-sky-200 bg-sky-50/60 p-3">
          <h3 class="mb-1 text-sm font-semibold text-sky-900">需求清單（勾選帶入，數量為建議量，可改）</h3>
          <div class="max-h-48 space-y-1 overflow-y-auto">
            <UCheckbox v-for="c in candidates" :key="c.drugId" :model-value="inForm(c.drugId)" @update:model-value="(v) => toggleCandidate(c, v)">
              <span class="font-medium">{{ c.drugName }}</span>
              <span class="text-xs text-slate-600">
                ・{{ candNote(c) }}・建議 {{ c.suggestedQty }} {{ c.unit }}<template v-if="c.onOrder">（已訂購 {{ c.onOrder }} 未到）</template>
                <template v-if="c.last">・上次 {{ c.last.supplier }} {{ c.last.unitCost }} 元</template>
              </span>
            </UCheckbox>
          </div>
        </section>

        <div class="overflow-x-auto rounded-md border border-slate-200">
          <table class="tabular w-full text-sm">
            <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500">
              <tr><th class="px-3 py-1.5 text-left font-medium">藥品</th><th class="px-2 text-right font-medium">數量</th><th class="px-2 text-right font-medium">進價（元）</th><th class="px-2 text-right font-medium">金額</th><th></th></tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="(l, i) in form.lines" :key="i">
                <td class="min-w-56 px-3 py-1.5">
                  <USelect v-model="l.drugId" :options="drugOptions" placeholder="選擇藥品" :aria-label="`第 ${i + 1} 項藥品`" />
                  <div v-if="l.restockId" class="mt-0.5 text-xs text-sky-700">由補貨申請帶入</div>
                  <div v-if="priceOf(l.drugId)" class="mt-0.5 text-xs text-slate-500">
                    這家上次 {{ priceOf(l.drugId)!.unitCost }} 元（{{ priceOf(l.drugId)!.date.slice(5).replace('-', '/') }}）<template v-if="priceOf(l.drugId)!.other">・{{ priceOf(l.drugId)!.other!.supplier }} {{ priceOf(l.drugId)!.other!.unitCost }} 元</template>
                  </div>
                  <div v-if="save.fieldErrors.value[`line-${i}`]" class="text-xs text-red-600">{{ save.fieldErrors.value[`line-${i}`] }}</div>
                </td>
                <td class="whitespace-nowrap px-2 text-right"><input v-model.number="l.qty" type="number" min="1" step="1" class="form-control w-24 text-right" :aria-label="`第 ${i + 1} 項數量`" /> <span class="text-xs text-slate-400">{{ unitOf(l.drugId) }}</span></td>
                <td class="px-2 text-right"><input v-model.number="l.unitCost" type="number" min="0" step="0.01" class="form-control w-24 text-right" :aria-label="`第 ${i + 1} 項進價`" /></td>
                <td class="px-2 text-right text-slate-600">{{ Math.round((l.qty ?? 0) * (l.unitCost ?? 0)).toLocaleString() }}</td>
                <td class="px-2 text-right"><UButton size="sm" variant="ghost" :icon="Trash2" :aria-label="`刪除第 ${i + 1} 項`" @click="form.lines.splice(i, 1)" /></td>
              </tr>
              <tr v-if="!form.lines.length"><td colspan="5" class="px-3 py-4 text-center text-sm text-slate-400">從上方需求清單勾選，或按「加品項」</td></tr>
            </tbody>
          </table>
        </div>
        <p v-if="save.fieldErrors.value.lines" class="text-xs text-red-600">{{ save.fieldErrors.value.lines }}</p>
        <div class="flex flex-wrap items-center gap-2">
          <UButton size="sm" variant="secondary" :icon="Plus" @click="form.lines.push({ drugId: '' })">加品項</UButton>
          <span class="ml-auto text-sm text-slate-600">合計 <b class="tabular text-slate-800">{{ draftTotal.toLocaleString() }}</b> 元</span>
          <UButton size="sm" variant="secondary" :loading="save.pending.value" @click="onSave">存草稿</UButton>
          <UButton size="sm" :icon="Send" :loading="submit.pending.value" @click="onSubmit">送出核准</UButton>
        </div>
      </template>

      <!-- 唯讀（含已訂購的到貨） -->
      <template v-else-if="po">
        <p class="text-sm text-slate-700">供應商：<b>{{ po.supplier }}</b><template v-if="po.expectedDate">・預計到貨 {{ po.expectedDate }}</template><template v-if="po.note">・{{ po.note }}</template></p>
        <div class="overflow-x-auto rounded-md border border-slate-200">
          <table class="tabular w-full text-sm">
            <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500">
              <tr><th class="px-3 py-1.5 text-left font-medium">藥品</th><th class="px-2 text-right font-medium">訂購</th><th class="px-2 text-right font-medium">已到</th><th class="px-2 text-right font-medium">進價</th><th class="px-2 text-right font-medium">金額</th><th></th></tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="l in po.lines" :key="l.id">
                <td class="px-3 py-1.5">
                  <div class="font-medium text-slate-800">{{ l.drugName }}</div>
                  <div class="text-xs text-slate-500">{{ l.drugNameZh }}・{{ l.spec }}<template v-if="l.restockId">・補貨申請</template></div>
                </td>
                <td class="px-2 text-right">{{ l.qty }} <span class="text-xs text-slate-400">{{ l.unit }}</span></td>
                <td :class="['px-2 text-right', l.remaining ? 'text-slate-600' : 'font-medium text-emerald-700']">{{ l.receivedQty }}</td>
                <td class="px-2 text-right text-slate-600">{{ l.unitCost }}</td>
                <td class="px-2 text-right text-slate-600">{{ Math.round(l.amount).toLocaleString() }}</td>
                <td class="px-2 text-right">
                  <UButton v-if="po.status === 'ordered' && l.remaining && role === 'pharmacist'" size="sm" :icon="PackageCheck" @click="startReceive(l)">到貨入庫</UButton>
                  <UBadge v-else-if="!l.remaining" tone="green">到齊</UBadge>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="text-right text-sm text-slate-600">合計 <b class="tabular text-slate-800">{{ po.total.toLocaleString() }}</b> 元</p>
      </template>

      <ReceiveStockDialog
        v-if="po && receiving"
        v-model="receiveOpen"
        :po-id="po.id"
        :line-id="receiving.id"
        :po-no="po.no"
        :remaining="receiving.remaining"
        :drug-id="receiving.drugId"
        :drug-name="receiving.drugName"
        :unit="receiving.unit"
        :location-name="po.locationName"
      />
      <UDialog :model-value="!!reasonFor" :title="reasonFor ? REASON_TITLE[reasonFor] : ''" size="sm" @update:model-value="(v) => !v && (reasonFor = '')" @submit="onReason">
        <UTextarea v-model="reasonText" label="原因" :rows="2" :placeholder="reasonFor === 'reject' ? '例：數量太多、換供應商' : reasonFor === 'close' ? '例：廠商缺貨，剩餘不再出貨' : ''" :error="reasonAction.fieldErrors.value.reason" />
        <template #footer>
          <UButton variant="secondary" @click="reasonFor = ''">返回</UButton>
          <UButton type="submit" :variant="reasonFor === 'reject' ? 'primary' : 'danger'" :loading="reasonAction.pending.value">確定</UButton>
        </template>
      </UDialog>
    </div>
  </UQueryState>
</template>
