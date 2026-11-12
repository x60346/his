<script setup lang="ts">
// 藥品庫存明細：批號、近 30 天用量、異動紀錄。盤點一律走盤點單（另一人覆核才過帳），這裡不能直接改數量。
// 正在盤點時（盲盤）服務層不給數量：顯示「盤點中」，批號只列批號效期、異動不列。
// 異動紀錄就是「庫存為什麼是這個數字」的答案：每一筆增減都查得到時間、人、單據、原因。
import { computed, ref } from 'vue'
import { ClipboardList, PackagePlus, Trash2 } from 'lucide-vue-next'
import { UBadge, UBarChart, UButton, UDialog, UInput, UQueryState, type BarDatum } from '@/components/ui'
import ReceiveStockDialog from '@/components/ReceiveStockDialog.vue'
import RestockRequestDialog from '@/components/RestockRequestDialog.vue'
import { inventoryApi, isExpiringSoon } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import { today } from '@/utils/date'
import type { DrugLot, StockTxnType } from '@/types'

/** locationId：哪個地點的批號與異動；locationName：多地點時才給（顯示在標題，單一藥局不必提） */
const props = defineProps<{ drugId: string; locationId?: string; locationName?: string }>()
const ui = useUi()

const { data, loading } = useQuery(
  async () => {
    const id = props.drugId
    const loc = props.locationId || undefined
    return { id, loc, ledger: await inventoryApi.getDrugLedger(id, loc) }
  },
  [() => props.drugId, () => props.locationId],
)
// 換藥、換地點的瞬間，舊的明細不能冒充新的（藥對、地點也要對）
const ledger = computed(() => (data.value?.id === props.drugId && data.value.loc === (props.locationId || undefined) ? data.value.ledger : undefined))
const row = computed(() => ledger.value?.row)

const bars = computed<BarDatum[]>(() => (ledger.value?.daily ?? []).map((d) => ({ label: d.date.slice(8), value: d.qty, title: d.date })))

const typeView: Record<StockTxnType, { label: string; tone: 'gray' | 'green' | 'blue' | 'yellow' }> = {
  opening: { label: '期初', tone: 'gray' },
  receive: { label: '進貨', tone: 'green' },
  dispense: { label: '發藥', tone: 'blue' },
  'transfer-out': { label: '撥出', tone: 'gray' },
  'transfer-in': { label: '撥入', tone: 'green' },
  return: { label: '退藥', tone: 'green' },
  adjust: { label: '盤點調整', tone: 'yellow' },
}
const lotState = (l: DrugLot) => (l.expiry < today() ? { label: '已過期', tone: 'red' as const } : isExpiringSoon(l.expiry, today()) ? { label: '即將到期', tone: 'yellow' as const } : null)

const receiveOpen = ref(false)

// ---------- 補貨申請（U25） ----------
const restock = computed(() => ledger.value?.restock)
const requestOpen = ref(false)
const cancelOpen = ref(false)
const cancelReason = ref('')
const cancel = useAction(inventoryApi.cancelRestock, { success: (r) => `已取消 ${r.drugName} 的補貨申請` })
function startCancel() {
  cancelReason.value = ''
  cancel.fieldErrors.value = {}
  cancelOpen.value = true
}
async function confirmCancel() {
  if (restock.value && (await cancel.run(restock.value.id, cancelReason.value))) cancelOpen.value = false
}
const md = (t: string) => t.slice(5, 16).replace('-', '/')

// ---------- 各地點安全庫存（大型醫院） ----------
const safetyOpen = ref(false)
const safetyQty = ref<number | undefined>()
function openSafety() {
  safetyQty.value = row.value?.safetyStock
  setSafety.fieldErrors.value = {}
  safetyOpen.value = true
}
const setSafety = useAction(inventoryApi.setSafetyStock, { success: (r) => `${props.locationName}的安全庫存改為 ${r.qty}` })
async function onSafety() {
  if (row.value && props.locationId && (await setSafety.run(row.value.id, props.locationId, safetyQty.value as number))) safetyOpen.value = false
}

const scrap = useAction(inventoryApi.scrapExpired, { success: (t) => `已報廢 ${t.length} 個過期批號` })
async function onScrap() {
  if (!row.value) return
  const ok = await ui.confirm({ title: '報廢過期藥品', message: `${row.value.name} 已過期 ${row.value.expiredQty} ${row.value.unit}，確定報廢？\n報廢會寫入盤點調整紀錄。`, okText: '報廢', danger: true })
  if (ok) scrap.run(row.value.id, props.locationId || undefined)
}
</script>

<template>
  <UQueryState :loading="loading && !ledger" :ready="!!ledger">
    <div v-if="ledger && row" class="space-y-4">
      <header class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h2 class="flex flex-wrap items-center gap-2 text-lg font-bold text-slate-800">
            {{ row.name }}<UBadge v-if="row.highAlert" tone="purple">高警訊</UBadge>
          </h2>
          <p class="text-xs text-slate-500">{{ row.nameZh }}・{{ row.id }}・{{ row.generic }}・{{ row.spec }}・{{ row.category }}</p>
        </div>
        <UButton size="sm" variant="secondary" :icon="ClipboardList" @click="requestOpen = true">{{ restock ? '追加申請' : '申請補貨' }}</UButton>
        <UButton size="sm" variant="secondary" :icon="PackagePlus" title="沒有採購單的入庫（緊急調貨、贈品、退藥回收）；一般進貨請開採購單" @click="receiveOpen = true">無單進貨</UButton>
      </header>

      <!-- 待到貨的補貨申請：貨到了按「到貨入庫」（批號、效期照實物填），到齊自動結案 -->
      <section v-if="restock" class="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
        <div class="flex flex-wrap items-center gap-2">
          <UBadge tone="blue">補貨待到貨</UBadge>
          <span>申請 <b class="tabular">{{ restock.qty }}</b><template v-if="restock.receivedQty">・已到 {{ restock.receivedQty }}・尚欠 <b class="tabular">{{ restock.outstanding }}</b></template> {{ row.unit }}</span>
          <span class="text-xs text-sky-700">{{ restock.requestedByName }} {{ md(restock.requestedAt) }} 申請</span>
        </div>
        <p v-if="restock.note" class="mt-1 text-xs text-sky-800">備註：{{ restock.note }}</p>
        <p v-if="restock.waiting.length" class="mt-1 text-xs">
          等候領藥：<span v-for="(w, i) in restock.waiting" :key="w.dispenseId">{{ i ? '、' : '' }}{{ w.date !== today() ? w.date.slice(5).replace('-', '/') + ' ' : '' }}領藥號 {{ w.pickupNo }}（{{ w.patientName }} {{ w.qty }}）</span>
        </p>
        <div class="mt-2 flex gap-2">
          <!-- 到貨一律對採購單入庫：申請只是需求，開採購單時勾選帶入 -->
          <span v-if="restock.transfer" class="text-xs">已向藥庫請領 <b class="tabular">{{ restock.transfer.no }}</b>（{{ restock.transfer.status === 'issued' ? '運送中，等簽收' : '請領中，等藥庫撥發' }}）；門診藥局簽收後結案</span>
          <span v-else-if="restock.purchase" class="text-xs">已列入採購單 <b class="tabular">{{ restock.purchase.no }}</b>（{{ { draft: '草稿', pending: '待核准', ordered: '已訂購，等到貨' }[restock.purchase.status] ?? restock.purchase.status }}）；到貨請在「採購單」入庫</span>
          <span v-else-if="locationName" class="text-xs">尚未請領：到「撥補單」向藥庫請領時會列出這張申請</span>
          <span v-else class="text-xs">尚未列入採購單：到「採購單」分頁開單時會列出這張申請</span>
          <UButton size="sm" variant="ghost" @click="startCancel">取消申請</UButton>
        </div>
      </section>

      <p v-if="ledger.counting" class="rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900" role="status">
        盤點中（{{ ledger.counting }}）：帳上數量、可用天數與異動紀錄暫不顯示，過帳或取消盤點後恢復。
      </p>
      <dl v-else class="grid grid-cols-3 gap-2 text-center">
        <div class="rounded-md bg-slate-50 p-2">
          <dt class="text-xs text-slate-500">可用庫存</dt>
          <dd :class="['tabular text-xl font-semibold', row.status === 'out' ? 'text-red-600' : row.status === 'low' ? 'text-amber-700' : 'text-slate-800']">{{ row.usable }}</dd>
          <dd class="text-xs text-slate-400">
            安全庫存 {{ row.safetyStock }} {{ row.unit }}
            <!-- 大型醫院：各地點各自設（藥庫通常存得比藥局多） -->
            <button v-if="locationName" type="button" class="ml-1 text-brand-600 hover:underline" @click="openSafety">修改</button>
          </dd>
          <dd v-if="row.inTransit" class="text-xs text-sky-700">運送中 {{ row.inTransit }}</dd>
        </div>
        <div class="rounded-md bg-slate-50 p-2">
          <dt class="text-xs text-slate-500">近 30 天用量</dt>
          <dd class="tabular text-xl font-semibold text-slate-800">{{ row.used30 }}</dd>
          <dd class="text-xs text-slate-400">日均 {{ (row.used30 / 30).toFixed(1) }}</dd>
        </div>
        <div class="rounded-md bg-slate-50 p-2">
          <dt class="text-xs text-slate-500">預估可用</dt>
          <dd :class="['tabular text-xl font-semibold', row.daysLeft !== null && row.daysLeft < 14 ? 'text-red-600' : 'text-slate-800']">{{ row.daysLeft ?? '—' }}</dd>
          <dd class="text-xs text-slate-400">{{ row.daysLeft === null ? '近期無用量' : '天' }}</dd>
        </div>
      </dl>

      <!-- 批號 -->
      <section>
        <div class="mb-2 flex items-center">
          <h3 class="text-sm font-semibold text-slate-700"><template v-if="locationName">{{ locationName }}・</template>批號（發藥依效期先後扣除）</h3>
          <UButton v-if="row.expiredQty && !ledger.counting" class="ml-auto" size="sm" variant="danger" :icon="Trash2" :loading="scrap.pending.value" @click="onScrap">報廢過期 {{ row.expiredQty }}</UButton>
        </div>
        <p v-if="!ledger.lots.length" class="text-sm text-slate-400">目前沒有庫存批號</p>
        <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
          <li v-for="l in ledger.lots" :key="l.id" :class="['flex items-center gap-3 px-3 py-2 text-sm', l.expiry < today() && 'bg-red-50/60']">
            <span class="tabular w-24 font-medium text-slate-800">{{ l.lotNo }}</span>
            <span class="tabular text-slate-600">效期 {{ l.expiry }}</span>
            <UBadge v-if="lotState(l)" :tone="lotState(l)!.tone">{{ lotState(l)!.label }}</UBadge>
            <span v-if="ledger.counting" class="ml-auto text-xs text-slate-400">盤點中</span>
            <span v-else class="tabular ml-auto font-medium text-slate-800">{{ l.qty }} {{ row.unit }}</span>
          </li>
        </ul>
      </section>

      <!-- 用量 -->
      <section>
        <UBarChart :data="bars" :title="locationName ? `近 30 天每日用量（發藥＋撥出）` : '近 30 天每日發藥量'" :unit="row.unit" :height="150" />
      </section>

      <!-- 異動紀錄（盤點中不列：結存就是帳上數量） -->
      <section v-if="!ledger.counting">
        <h3 class="mb-2 text-sm font-semibold text-slate-700">異動紀錄（最近 {{ ledger.txns.length }} 筆）</h3>
        <div class="max-h-80 overflow-y-auto rounded-md border border-slate-200">
          <table class="w-full text-sm">
            <thead class="sticky top-0 bg-slate-50 text-xs text-slate-500">
              <tr><th class="px-3 py-1.5 text-left font-medium">時間</th><th class="px-2 text-left font-medium">類別</th><th class="px-2 text-left font-medium">說明</th><th class="px-2 text-right font-medium">增減</th><th class="px-3 text-right font-medium">結存</th></tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="t in ledger.txns" :key="t.id">
                <td class="tabular whitespace-nowrap px-3 py-1.5 text-xs text-slate-500">{{ t.at.slice(5) }}</td>
                <td class="px-2"><UBadge :tone="typeView[t.type].tone">{{ typeView[t.type].label }}</UBadge></td>
                <td class="px-2 text-xs text-slate-600">
                  {{ t.ref ?? t.reason ?? '' }}<template v-if="t.ref && t.reason">・{{ t.reason }}</template>
                  <span class="text-slate-400">（{{ t.lots.map((l) => l.lotNo).join('、') }}・{{ t.userName }}）</span>
                </td>
                <td :class="['tabular px-2 text-right font-medium', t.qty > 0 ? 'text-emerald-700' : 'text-slate-700']">{{ t.qty > 0 ? '+' : '' }}{{ t.qty }}</td>
                <td class="tabular px-3 text-right text-slate-800">{{ t.balance }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <ReceiveStockDialog v-model="receiveOpen" :location-id="locationId" :location-name="locationName" :drug-id="row.id" :drug-name="row.name" :unit="row.unit" :usable="ledger.counting ? undefined : row.usable" :restock-outstanding="restock?.outstanding" />
      <RestockRequestDialog v-model="requestOpen" :drug-id="row.id" />
      <UDialog v-model="safetyOpen" :title="`安全庫存：${row.name}（${locationName}）`" size="sm" @submit="onSafety">
        <UInput v-model="safetyQty" label="安全庫存" type="number" min="0" :hint="`${row.unit}；低於它就標「偏低」、列入${locationName === '藥庫' ? '採購' : '請領'}的需求清單`" :error="setSafety.fieldErrors.value.qty" />
        <template #footer>
          <UButton variant="secondary" @click="safetyOpen = false">取消</UButton>
          <UButton type="submit" :loading="setSafety.pending.value">儲存</UButton>
        </template>
      </UDialog>
      <UDialog v-model="cancelOpen" title="取消補貨申請" size="sm" @submit="confirmCancel">
        <div class="space-y-3 text-sm">
          <p class="text-slate-600">{{ row.name }} 的補貨申請（尚欠 {{ restock?.outstanding }} {{ row.unit }}）取消後，等候中的病人需改開替代藥或另行調貨。</p>
          <UInput v-model="cancelReason" label="取消原因" required placeholder="例：醫師改開替代藥、廠商缺貨" :error="cancel.fieldErrors.value.reason" />
        </div>
        <template #footer>
          <UButton variant="secondary" @click="cancelOpen = false">返回</UButton>
          <UButton type="submit" variant="danger" :loading="cancel.pending.value">取消申請</UButton>
        </template>
      </UDialog>
    </div>
  </UQueryState>
</template>
