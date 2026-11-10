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
  // 效期預設兩年後：最常見的情況，仍需依實物包裝核對修改
  Object.assign(form, { qty: props.suggestedQty, lotNo: '', expiry: addDays(today(), 730), ref: '' })
})

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
  <UDialog v-model="open" :title="`進貨：${drugName ?? ''}`" size="sm">
    <div class="space-y-3 text-sm">
      <p v-if="usable !== undefined" class="text-slate-600">目前可用庫存 <b class="tabular text-slate-800">{{ usable }}</b> {{ unit }}</p>
      <UInput v-model="form.qty" label="進貨數量" type="number" min="1" required :hint="unit" :error="save.fieldErrors.value.qty" />
      <div class="grid grid-cols-2 gap-3">
        <UInput v-model="form.lotNo" label="批號" required placeholder="例：A24051" :error="save.fieldErrors.value.lotNo" />
        <UInput v-model="form.expiry" label="效期" type="date" required :error="save.fieldErrors.value.expiry" />
      </div>
      <UInput v-model="form.ref" label="進貨單號（選填）" />
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :loading="save.pending.value" @click="submit">確認進貨</UButton>
    </template>
  </UDialog>
</template>
