<script setup lang="ts">
// 盤點：輸入「實際清點到的數量」，差異由系統算。人填事實，機器算差——避免心算出錯。
// 帳上數量等清點完才顯示比較：若一開始就讓人看到「帳上 100」，很容易不數就直接填 100（錨定效應）。
import { computed, reactive, watch } from 'vue'
import { UButton, UDialog, UInput } from '@/components/ui'
import { inventoryApi } from '@/services'
import { checkStocktakeActual } from '@/services/stock-rules'
import { useAction } from '@/composables/useService'
import type { DrugLot } from '@/types'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ lot?: DrugLot; drugName?: string; unit?: string }>()

const form = reactive({ actual: undefined as number | undefined, reason: '' })
watch(open, (v) => v && Object.assign(form, { actual: undefined, reason: '' }))

// 與服務層同一條規則：輸入不合法時不算差異（以前輸入 -3 會同時出現錯誤和「差異 -23（盤虧）」）。
// 還沒輸入時不顯示錯誤（剛打開就一片紅很吵），輸入了但不合法才即時提示。
const actualError = computed(() => (form.actual === undefined ? null : checkStocktakeActual(form.actual)))
const diff = computed(() => (form.actual === undefined || actualError.value || !props.lot ? null : form.actual - props.lot.qty))
const presets = ['破損', '過期報廢', '計數錯誤', '退回廠商']

const save = useAction(inventoryApi.stocktake, { success: (t) => (t ? `已調整 ${t.qty > 0 ? '+' : ''}${t.qty}，結存 ${t.balance}` : '帳實相符，不需調整') })
async function submit() {
  if (!props.lot || form.actual === undefined || actualError.value) return // 按鈕已停用；這裡擋住 Enter 送出
  const ok = await save.run({ lotId: props.lot.id, actual: form.actual, reason: form.reason })
  if (ok !== undefined) open.value = false
}
</script>

<template>
  <UDialog v-model="open" @submit="submit" :title="`盤點：${drugName ?? ''}`" size="sm">
    <div v-if="lot" class="space-y-3 text-sm">
      <div class="rounded-md bg-slate-50 px-3 py-2">批號 <b class="tabular">{{ lot.lotNo }}</b>・效期 <span class="tabular">{{ lot.expiry }}</span></div>
      <UInput v-model="form.actual" label="實際清點數量" type="number" min="0" required :hint="unit" :error="actualError ?? save.fieldErrors.value.actual" />
      <template v-if="diff !== null">
        <div :class="['rounded-md px-3 py-2', diff === 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900']">
          帳上 <b class="tabular">{{ lot.qty }}</b>，實際 <b class="tabular">{{ form.actual }}</b>：
          <template v-if="diff === 0">帳實相符</template>
          <template v-else>差異 <b class="tabular">{{ diff > 0 ? '+' : '' }}{{ diff }}</b>（{{ diff > 0 ? '盤盈' : '盤虧' }}）</template>
        </div>
        <template v-if="diff !== 0">
          <div class="flex flex-wrap gap-1.5">
            <UButton v-for="p in presets" :key="p" size="sm" variant="secondary" @click="form.reason = p">{{ p }}</UButton>
          </div>
          <UInput v-model="form.reason" label="差異原因" required :error="save.fieldErrors.value.reason" />
        </template>
      </template>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton :loading="save.pending.value" :disabled="diff === null" type="submit">確認盤點</UButton>
    </template>
  </UDialog>
</template>
