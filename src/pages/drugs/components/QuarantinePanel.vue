<script setup lang="ts">
// 待報廢區（藥庫底下）：退回藥庫時選「待報廢」的過期、破損品。不算可用庫存（開藥、撥補、FEFO 都不會用到），
// 只能「報廢」（寫原因、扣帳）或「放回可用」（沒過期的，移回藥庫）。規則在服務層（inventory.scrapQuarantine / releaseQuarantine）。
import { computed, ref } from 'vue'
import { PackageX, RotateCcw, Trash2 } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UEmpty, UQueryState } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { inventoryApi, type QuarantineRow } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data: rows, loading } = useQuery(() => inventoryApi.listQuarantine())
const total = computed(() => (rows.value ?? []).reduce((n, r) => n + r.qty, 0))
const md = (s?: string) => (s ? s.slice(5, 16).replace('-', '/') : '')

const acting = ref<{ row: QuarantineRow; kind: 'scrap' | 'release' } | null>(null)
const actOpen = computed({ get: () => !!acting.value, set: (v) => !v && (acting.value = null) })
const scrap = useAction(inventoryApi.scrapQuarantine, { success: (t) => `已報廢 ${-t.qty}` })
const release = useAction(inventoryApi.releaseQuarantine, { success: (r) => `已放回${r.to} ${r.qty}` })
async function confirm(reason: string) {
  const a = acting.value
  if (!a) return
  const ok = a.kind === 'scrap' ? await scrap.run(a.row.lotId, reason) : await release.run(a.row.lotId, reason)
  if (ok) acting.value = null
}
</script>

<template>
  <UCard :padded="false">
    <template #title>
      <div class="flex items-center gap-2 text-sm font-semibold text-slate-800"><PackageX class="h-4 w-4 text-red-600" />待報廢區<UBadge v-if="rows?.length" tone="red">{{ rows.length }} 批・{{ total }}</UBadge></div>
      <div class="text-xs text-slate-500">退回藥庫時選「待報廢」的藥：不算可用庫存（開藥、撥補都不會用到），全院總量仍算，報廢了才扣</div>
    </template>
    <UQueryState :loading="loading && !rows" :ready="!!rows">
      <UEmpty v-if="!rows?.length" :icon="PackageX" title="待報廢區是空的" description="藥局退回藥庫時，藥庫簽收可以把過期、破損的批號放到這裡" class="py-8" />
      <ul v-else class="divide-y divide-slate-100">
        <li v-for="r in rows" :key="r.lotId" class="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
          <div class="min-w-0 flex-1">
            <div class="font-medium text-slate-800">{{ r.drugName }}・批號 {{ r.lotNo }}<UBadge v-if="r.expired" tone="red" class="ml-1">已過期</UBadge></div>
            <div class="text-xs text-slate-500">效期 {{ r.expiry }}・{{ r.locationName }}<template v-if="r.ref">・{{ r.ref }} {{ md(r.at) }} {{ r.reason }}</template></div>
          </div>
          <span class="tabular">{{ r.qty }} <span class="text-xs text-slate-500">{{ r.unit }}</span></span>
          <UButton size="sm" variant="danger" :icon="Trash2" @click="acting = { row: r, kind: 'scrap' }">報廢</UButton>
          <UButton size="sm" variant="ghost" :icon="RotateCcw" :disabled="r.expired" :title="r.expired ? '已過期只能報廢' : '確認可用：移回藥庫'" @click="acting = { row: r, kind: 'release' }">放回可用</UButton>
        </li>
      </ul>
    </UQueryState>
    <ReasonDialog
      v-model="actOpen"
      :title="acting?.kind === 'scrap' ? '報廢' : '放回可用'"
      :subject="acting ? `${acting.row.drugName} 批號 ${acting.row.lotNo}・${acting.row.qty} ${acting.row.unit}` : ''"
      :label="acting?.kind === 'scrap' ? '報廢原因' : '放回的原因'"
      :presets="acting?.kind === 'scrap' ? ['過期', '破損', '包裝已拆無法再用'] : ['確認包裝完好', '判斷錯誤']"
      :ok-text="acting?.kind === 'scrap' ? '報廢' : '放回可用'"
      :danger="acting?.kind === 'scrap'"
      :pending="scrap.pending.value || release.pending.value"
      :error="scrap.fieldErrors.value.reason || release.fieldErrors.value.reason"
      @confirm="confirm"
    />
  </UCard>
</template>
