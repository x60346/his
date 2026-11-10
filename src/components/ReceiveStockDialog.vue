<script setup lang="ts">
// 藥品進貨：藥局頁（缺藥時就地補貨）與藥品庫存頁共用。
// 進貨一定要有批號與效期——沒有批號，日後回收、過期報廢都追不到是哪一批。
import { reactive, watch } from 'vue'
import { UButton, UDialog, UInput } from '@/components/ui'
import { inventoryApi } from '@/services'
import { useAction } from '@/composables/useService'
import { addDays, today } from '@/utils/date'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ drugId?: string; drugName?: string; unit?: string; usable?: number; suggestedQty?: number }>()
const emit = defineEmits<{ done: [] }>()

const form = reactive({ qty: undefined as number | undefined, lotNo: '', expiry: '', ref: '' })
watch(open, (v) => {
  if (!v) return
  // 效期留白，依實物包裝填寫：以前預設「兩年後」，沒注意就記下一個假效期，
  // 而效期決定發藥先扣哪一批（FEFO）和何時報廢——需要使用者判斷的值，不替他先填
  Object.assign(form, { qty: props.suggestedQty, lotNo: '', expiry: '', ref: '' })
})
// 日期選擇器最早只能選明天（今天或以前到期的不能進貨）；鍵盤仍可直接輸入，服務層會再擋
const minExpiry = () => addDays(today(), 1)

const save = useAction(inventoryApi.receiveStock, { success: (t) => `${props.drugName} 進貨 ${t.qty}，結存 ${t.balance}` })
async function submit() {
  if (!props.drugId) return
  const ok = await save.run({ drugId: props.drugId, qty: form.qty ?? 0, lotNo: form.lotNo, expiry: form.expiry, ref: form.ref })
  if (ok) {
    open.value = false
    emit('done')
  }
}
</script>

<template>
  <UDialog v-model="open" @submit="submit" :title="`進貨：${drugName ?? ''}`" size="sm">
    <div class="space-y-3 text-sm">
      <p v-if="usable !== undefined" class="text-slate-600">目前可用庫存 <b class="tabular text-slate-800">{{ usable }}</b> {{ unit }}</p>
      <UInput v-model="form.qty" label="進貨數量" type="number" min="1" required :hint="unit" :error="save.fieldErrors.value.qty" />
      <div class="grid grid-cols-2 gap-3">
        <UInput v-model="form.lotNo" label="批號" required placeholder="例：A24051" :error="save.fieldErrors.value.lotNo" />
        <UInput v-model="form.expiry" label="效期" type="date" :min="minExpiry()" required hint="依包裝上的效期填寫" :error="save.fieldErrors.value.expiry" />
      </div>
      <UInput v-model="form.ref" label="進貨單號（選填）" />
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :loading="save.pending.value" type="submit">確認進貨</UButton>
    </template>
  </UDialog>
</template>
