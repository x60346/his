<script setup lang="ts">
// 撥補單（大型醫院）：清單（和目前地點有關的：請領方或撥出方）＋從藥局發起請領。
// 請領中 → 藥庫撥發（運送中）→ 藥局簽收；點一張在右側打開（TransferOrderView）。
// 反方向「退回藥庫」（ReturnToWarehouse）：藥局逐批申請（不扣帳）→ 藥庫審核 → 藥局送出才扣（運送中）→ 藥庫簽收。
import { ref } from 'vue'
import { ArrowLeftRight, Plus, Undo2 } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UEmpty } from '@/components/ui'
import { transferApi } from '@/services'
import { useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import TransferOrderView from './TransferOrderView.vue'
import ReturnToWarehouse from './ReturnToWarehouse.vue'
import { transferStatusOf } from './transferStatus'

const props = defineProps<{ locationId: string; locationName?: string; isPharmacy: boolean }>()
const auth = useAuth()
const { data: list, loading } = useQuery(() => transferApi.listTransfers({ locationId: props.locationId || undefined }), [() => props.locationId])
const selectedId = ref<string>()
</script>

<template>
  <div class="grid grid-cols-1 gap-4 xl:grid-cols-[22rem_1fr]">
    <UCard :padded="false" class="self-start">
      <template #title><span class="text-sm font-semibold">撥補單<template v-if="locationName">・{{ locationName }}</template></span></template>
      <template #actions>
        <div v-if="auth.user?.role === 'pharmacist' && isPharmacy" class="flex gap-1.5">
          <UButton size="sm" variant="secondary" :icon="Undo2" @click="selectedId = 'return'">退回藥庫</UButton>
          <UButton size="sm" :icon="Plus" @click="selectedId = 'new'">向藥庫請領</UButton>
        </div>
      </template>
      <p v-if="!isPharmacy" class="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">藥庫是撥出的一方：請領由各藥局發起，這裡處理撥發。</p>
      <UEmpty v-if="!loading && !list?.length" :icon="ArrowLeftRight" title="沒有撥補單" description="藥局缺藥時向藥庫請領；藥庫撥發後藥局簽收才入帳" />
      <ul v-else class="max-h-[calc(100vh-14rem)] divide-y divide-slate-100 overflow-y-auto">
        <li v-for="t in list" :key="t.id">
          <button type="button" :class="['flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50', t.id === selectedId && '!bg-brand-50']" @click="selectedId = t.id">
            <span class="min-w-0 flex-1">
              <span class="tabular block font-medium text-slate-800">{{ t.no }}<UBadge v-if="t.kind === 'return'" tone="gray" class="ml-1.5">退回</UBadge></span>
              <span class="block truncate text-xs text-slate-500">{{ t.fromName }} → {{ t.toName }}・{{ t.lines.length }} 項・{{ t.requestedAt.slice(5, 16).replace('-', '/') }}</span>
              <span v-if="t.note || t.returnReason" class="block truncate text-xs text-slate-500">{{ t.returnReason ?? t.note }}</span>
            </span>
            <UBadge :tone="transferStatusOf(t).tone">{{ transferStatusOf(t).label }}</UBadge>
          </button>
        </li>
      </ul>
    </UCard>

    <UCard class="self-start">
      <UEmpty v-if="!selectedId" :icon="ArrowLeftRight" title="請選擇一張撥補單" description="請領中由藥庫撥發；運送中由藥局逐批簽收" />
      <ReturnToWarehouse v-else-if="selectedId === 'return'" :from-location-id="locationId" :from-location-name="locationName" @created="(id) => (selectedId = id)" />
      <TransferOrderView v-else :key="selectedId" :transfer-id="selectedId === 'new' ? undefined : selectedId" :to-location-id="locationId" :to-location-name="locationName" @created="(id) => (selectedId = id)" />
    </UCard>
  </div>
</template>
