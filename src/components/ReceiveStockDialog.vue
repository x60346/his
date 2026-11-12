<script setup lang="ts">
// 入庫對話框，兩種用法：
//   - 採購到貨（給 poId、lineId）：對採購單的某一行入一批，最多到「尚未到貨」的量（服務層 receivePurchase）
//   - 無單進貨（沒給 poId）：沒有採購單的入庫（緊急調貨、贈品、退藥回收…），要選原因（服務層 receiveStock）
// 兩種都一定要有批號與效期——沒有批號，日後回收、過期報廢都追不到是哪一批。
// 這種藥有待到貨的補貨申請時，入庫量由服務層自動抵掉申請。
import { computed, reactive, watch } from 'vue'
import { UButton, UDialog, UInput, USelect } from '@/components/ui'
import { inventoryApi, NO_PO_REASONS, purchaseApi } from '@/services'
import { useAction } from '@/composables/useService'
import { addDays, today } from '@/utils/date'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{
  drugId?: string
  drugName?: string
  unit?: string
  usable?: number
  suggestedQty?: number
  title?: string
  restockOutstanding?: number
  locationId?: string
  locationName?: string
  /** 採購到貨：哪張採購單、哪一行、單號、尚未到貨數量 */
  poId?: string
  lineId?: string
  poNo?: string
  remaining?: number
}>()
const emit = defineEmits<{ done: [] }>()
const isPo = computed(() => !!props.poId && !!props.lineId)

const form = reactive({ qty: undefined as number | undefined, lotNo: '', expiry: '', reason: '' as string | number, note: '' })
// 日期選擇器最早只能選明天（今天或以前到期的不能進貨）；鍵盤仍可直接輸入，服務層會再擋
const minExpiry = () => addDays(today(), 1)

const restockTail = (r?: { outstanding: number }) => (!r ? '' : r.outstanding ? `；補貨申請尚欠 ${r.outstanding}` : '；補貨申請已到齊結案')
const noPo = useAction(inventoryApi.receiveStock, { success: (t) => `${props.drugName} 無單進貨 ${t.qty}，結存 ${t.balance}${restockTail(t.restock)}` })
const po = useAction(purchaseApi.receivePurchase, {
  success: (p) => `${props.poNo} ${props.drugName} 到貨 ${form.qty}${p.status === 'received' ? '；採購單已到齊' : ''}`,
})
const errors = computed(() => (isPo.value ? po.fieldErrors.value : noPo.fieldErrors.value))
// 每次打開重設表單。immediate：對話框可能「一掛上就是打開的」（採購單點某一行時 v-if 與打開同時成立），
// 這時 open 沒有「變化」，不加 immediate 就不會帶入數量（曾經發生：到貨入庫的數量欄是空的）
watch(
  open,
  (v) => {
    if (!v) return
    // 效期留白，依實物包裝填寫：以前預設「兩年後」，沒注意就記下一個假效期，
    // 而效期決定發藥先扣哪一批（FEFO）和何時報廢——需要使用者判斷的值，不替他先填
    Object.assign(form, { qty: isPo.value ? props.remaining : props.suggestedQty, lotNo: '', expiry: '', reason: '', note: '' })
    noPo.fieldErrors.value = {}
    po.fieldErrors.value = {}
  },
  { immediate: true },
)
async function submit() {
  if (!props.drugId) return
  const ok = isPo.value
    ? await po.run(props.poId!, props.lineId!, { qty: form.qty ?? 0, lotNo: form.lotNo, expiry: form.expiry })
    : await noPo.run({ drugId: props.drugId, locationId: props.locationId || undefined, qty: form.qty ?? 0, lotNo: form.lotNo, expiry: form.expiry, reason: String(form.reason), note: form.note })
  if (ok) {
    open.value = false
    emit('done')
  }
}
</script>

<template>
  <UDialog v-model="open" @submit="submit" :title="`${title ?? (isPo ? '到貨入庫' : '無單進貨')}：${drugName ?? ''}${locationName ? `（入${locationName}）` : ''}`" size="sm">
    <div class="space-y-3 text-sm">
      <p v-if="isPo" class="rounded-md bg-slate-50 px-3 py-2 text-slate-700">採購單 <b class="tabular">{{ poNo }}</b>：尚未到貨 <b class="tabular">{{ remaining }}</b> {{ unit }}（可分批入庫）</p>
      <template v-else>
        <p class="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">一般進貨請到「採購單」開單、核准後再到貨入庫。這裡只用在沒有採購單的入庫，異動帳上會標「無單進貨」。</p>
        <p v-if="usable !== undefined" class="text-slate-600">目前可用庫存 <b class="tabular text-slate-800">{{ usable }}</b> {{ unit }}</p>
      </template>
      <p v-if="restockOutstanding" class="rounded-md bg-sky-50 px-3 py-2 text-sky-900">補貨申請尚欠 <b class="tabular">{{ restockOutstanding }}</b> {{ unit }}：這次入庫會抵掉申請，到齊就自動結案。</p>
      <div v-if="!isPo" class="grid grid-cols-2 gap-3">
        <USelect v-model="form.reason" label="原因" required placeholder="請選擇" :options="[...NO_PO_REASONS]" :error="errors.reason" />
        <UInput v-model="form.note" :label="form.reason === '其他' ? '說明（必填）' : '說明（選填）'" placeholder="例：向 OO 藥局借 2 盒" :error="errors.note" />
      </div>
      <UInput v-model="form.qty" label="數量" type="number" min="1" required :hint="unit" :error="errors.qty" />
      <div class="grid grid-cols-2 gap-3">
        <UInput v-model="form.lotNo" label="批號" required placeholder="例：A24051" :error="errors.lotNo" />
        <UInput v-model="form.expiry" label="效期" type="date" :min="minExpiry()" required hint="依包裝上的效期填寫" :error="errors.expiry" />
      </div>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :loading="noPo.pending.value || po.pending.value" type="submit">確認入庫</UButton>
    </template>
  </UDialog>
</template>
