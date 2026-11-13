<script setup lang="ts">
// 採購單清單（進行中的在前）＋開新單。點一張在右側打開（PurchaseOrderView）。
// 採購單不分地點：到貨一律進「採購入庫」的地點（小型＝藥局、大型＝藥庫），由服務層決定。
import { ref } from 'vue'
import { Plus, ShoppingCart } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UEmpty } from '@/components/ui'
import { purchaseApi } from '@/services'
import { useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import PurchaseOrderView from './PurchaseOrderView.vue'
import { PURCHASE_STATUS } from './purchaseStatus'

const auth = useAuth()
const { data: orders, loading } = useQuery(() => purchaseApi.listPurchaseOrders())
/** 'new' ＝ 正在開新單 */
const selectedId = ref<string>()
const money = (n: number) => n.toLocaleString()
</script>

<template>
  <div class="grid grid-cols-1 gap-4 xl:grid-cols-[22rem_1fr]">
    <UCard :padded="false" class="self-start">
      <template #title><span class="text-sm font-semibold">採購單</span></template>
      <template #actions><UButton v-if="auth.user?.role === 'pharmacist'" size="sm" :icon="Plus" @click="selectedId = 'new'">開採購單</UButton></template>
      <UEmpty v-if="!loading && !orders?.length" :icon="ShoppingCart" title="還沒有採購單" description="開單時會列出待處理的補貨申請與低於安全庫存的藥" />
      <ul v-else class="max-h-[calc(100vh-14rem)] divide-y divide-slate-100 overflow-y-auto">
        <li v-for="p in orders" :key="p.id">
          <button type="button" :class="['flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50', p.id === selectedId && '!bg-brand-50']" @click="selectedId = p.id">
            <span class="min-w-0 flex-1">
              <span class="tabular block font-medium text-slate-800">{{ p.no }}</span>
              <span class="block truncate text-xs text-slate-500">{{ p.supplier }}・{{ p.lines.length }} 項・{{ money(p.total) }} 元</span>
              <span v-if="p.status === 'ordered'" class="tabular block text-xs text-slate-500">已到 {{ p.receivedLines }} / {{ p.lines.length }} 項<template v-if="p.expectedDate">・預計 {{ p.expectedDate.slice(5).replace('-', '/') }}</template></span>
              <span v-else-if="p.status === 'draft' && p.rejections?.length" class="block text-xs text-amber-700">被退回：{{ p.rejections.at(-1)!.reason }}</span>
            </span>
            <UBadge :tone="PURCHASE_STATUS[p.status].tone">{{ PURCHASE_STATUS[p.status].label }}</UBadge>
          </button>
        </li>
      </ul>
    </UCard>

    <UCard class="self-start">
      <UEmpty v-if="!selectedId" :icon="ShoppingCart" title="請選擇一張採購單" description="草稿可修改後送出；待核准由有「採購核准」權限的人核准（預設管理員，可指定藥劑部主管）；已訂購的到貨時對品項入庫" />
      <PurchaseOrderView v-else :key="selectedId" :order-id="selectedId === 'new' ? undefined : selectedId" @created="(id) => (selectedId = id)" />
    </UCard>
  </div>
</template>
