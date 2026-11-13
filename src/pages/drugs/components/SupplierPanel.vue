<script setup lang="ts">
// 供應商主檔：清單（含停用的）＋右側明細與「以前的進價」。藥師與管理員都能維護。
// 統一編號的檢查碼與服務層同一個 taxIdProblem（輸入時就提示打錯）；停用前服務層檢查還有沒有進行中的採購單。
import { useCan } from '@/composables/useCan'
import { computed, reactive, ref } from 'vue'
import { Pencil, Plus, Truck } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UCheckbox, UDialog, UEmpty, UInput, UQueryState, UTextarea } from '@/components/ui'
import { purchaseApi, taxIdProblem, type SupplierInput, type SupplierView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const can = useCan()
const showInactive = ref(false)
const { data: suppliers, loading } = useQuery(() => purchaseApi.listSuppliers({ includeInactive: true }))
const rows = computed(() => (suppliers.value ?? []).filter((x) => showInactive.value || x.active))
const inactiveCount = computed(() => (suppliers.value ?? []).filter((x) => !x.active).length)

const selectedId = ref<string>()
const selected = computed(() => suppliers.value?.find((x) => x.id === selectedId.value))
const { data: prices, loading: pLoading } = useQuery(async () => (selectedId.value ? purchaseApi.supplierPrices(selectedId.value) : []), [selectedId])

// ---------- 新增／編輯 ----------
const open = ref(false)
const form = reactive<SupplierInput>({ name: '', taxId: '', contact: '', phone: '', note: '', active: true })
function edit(s?: SupplierView) {
  Object.assign(form, s ? { id: s.id, name: s.name, taxId: s.taxId ?? '', contact: s.contact ?? '', phone: s.phone ?? '', note: s.note ?? '', active: s.active } : { id: undefined, name: '', taxId: '', contact: '', phone: '', note: '', active: true })
  save.fieldErrors.value = {}
  open.value = true
}
/** 統編輸入時就提示（和服務層同一條）；送出後以服務層的錯誤為準 */
const taxHint = computed(() => taxIdProblem(form.taxId))
const editing = computed(() => suppliers.value?.find((x) => x.id === form.id))
const save = useAction(purchaseApi.saveSupplier, { success: (s) => `已儲存供應商：${s.name}` })
async function submit() {
  const s = await save.run({ ...form })
  if (s) {
    open.value = false
    selectedId.value = s.id
  }
}
const md = (d?: string) => (d ? d.slice(5).replace('-', '/') : '')
</script>

<template>
  <div class="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr))]">
    <UCard :padded="false" class="self-start">
      <template #title><span class="text-sm font-semibold">供應商</span></template>
      <template #actions><UButton v-if="can('supplier.edit')" size="sm" :icon="Plus" @click="edit()">新增供應商</UButton></template>
      <UQueryState :loading="loading && !suppliers" :ready="!!suppliers">
        <UEmpty v-if="!rows.length" :icon="Truck" title="還沒有供應商" description="採購單只能選這裡有的供應商" />
        <ul v-else class="max-h-[calc(100vh-16rem)] divide-y divide-slate-100 overflow-y-auto">
          <li v-for="s in rows" :key="s.id">
            <button type="button" :class="['flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50', s.id === selectedId && '!bg-brand-50', !s.active && 'text-slate-400']" @click="selectedId = s.id">
              <span class="min-w-0 flex-1">
                <span class="block font-medium">{{ s.name }}</span>
                <span class="tabular block text-xs text-slate-500">
                  <template v-if="s.taxId">統編 {{ s.taxId }}・</template>{{ s.orderCount }} 張採購單<template v-if="s.lastOrderAt">・最近 {{ md(s.lastOrderAt) }}</template>
                </span>
              </span>
              <UBadge v-if="!s.active">停用</UBadge>
              <UBadge v-else-if="s.openOrders.length" tone="blue">{{ s.openOrders.length }} 張進行中</UBadge>
            </button>
          </li>
        </ul>
        <div v-if="inactiveCount" class="border-t border-slate-100 px-4 py-2">
          <UCheckbox v-model="showInactive" :label="`顯示已停用（${inactiveCount}）`" />
        </div>
      </UQueryState>
    </UCard>

    <UCard class="self-start">
      <UEmpty v-if="!selected" :icon="Truck" title="請選擇一家供應商" description="看聯絡資料與以前的進價（每種藥最近一次，和其他供應商比較）" />
      <div v-else class="space-y-3">
        <header class="flex flex-wrap items-start gap-2">
          <div class="min-w-0 flex-1">
            <h2 class="flex items-center gap-2 text-lg font-bold text-slate-800">{{ selected.name }}<UBadge v-if="!selected.active">停用</UBadge></h2>
            <p class="tabular text-sm text-slate-600">
              <template v-if="selected.taxId">統編 {{ selected.taxId }}</template>
              <template v-if="selected.contact">・聯絡人 {{ selected.contact }}</template>
              <template v-if="selected.phone">・{{ selected.phone }}</template>
            </p>
            <p v-if="selected.note" class="text-xs text-slate-500">{{ selected.note }}</p>
            <p v-if="selected.openOrders.length" class="text-xs text-sky-700">進行中的採購單：{{ selected.openOrders.join('、') }}</p>
          </div>
          <UButton v-if="can('supplier.edit')" size="sm" variant="secondary" :icon="Pencil" @click="edit(selected)">編輯</UButton>
        </header>

        <h3 class="text-sm font-semibold text-slate-700">以前的進價</h3>
        <!-- 換一家時舊結果還在：載入中一律顯示載入，不然會閃「還沒有向這家採購過」 -->
        <UQueryState :loading="pLoading" :ready="!!prices && !pLoading">
          <p v-if="!prices?.length" class="text-sm text-slate-400">還沒有向這家採購過（核准訂購過的才算；草稿、待核准、取消的不算）</p>
          <div v-else class="overflow-x-auto rounded-md border border-slate-200">
            <table class="tabular w-full text-sm">
              <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th class="px-3 py-1.5 text-left font-medium">藥品</th>
                  <th class="px-2 text-right font-medium">最近進價</th>
                  <th class="px-2 text-left font-medium">日期・單號</th>
                  <th class="px-2 text-right font-medium">買過</th>
                  <th class="px-3 text-left font-medium">其他供應商最近</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                <tr v-for="p in prices" :key="p.drugId">
                  <td class="px-3 py-1.5 font-medium text-slate-800">{{ p.drugName }}</td>
                  <td class="whitespace-nowrap px-2 text-right">{{ p.unitCost }} 元<span class="text-xs text-slate-400">／{{ p.unit }}</span></td>
                  <td class="whitespace-nowrap px-2 text-xs text-slate-500">{{ md(p.date) }}・{{ p.poNo }}</td>
                  <td class="whitespace-nowrap px-2 text-right text-slate-600">{{ p.times }} 次</td>
                  <td class="px-3 text-xs">
                    <template v-if="p.other">
                      <span :class="p.other.unitCost < p.unitCost ? 'font-medium text-amber-700' : 'text-slate-500'">{{ p.other.unitCost }} 元</span>
                      <span class="text-slate-400">（{{ p.other.supplier }}・{{ md(p.other.date) }}）</span>
                    </template>
                    <span v-else class="text-slate-400">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="mt-1 text-xs text-slate-500">每種藥列出這家最近一次的進價；其他供應商較便宜的標橘色。進價只記在採購單上，不做庫存成本計價。</p>
        </UQueryState>
      </div>
    </UCard>

    <UDialog v-model="open" :title="form.id ? `編輯供應商：${editing?.name ?? ''}` : '新增供應商'" size="sm" @submit="submit">
      <div class="space-y-3">
        <UInput v-model="form.name" label="名稱" required placeholder="例：台灣藥品股份有限公司" :error="save.fieldErrors.value.name" />
        <UInput v-model="form.taxId" label="統一編號（選填）" inputmode="numeric" maxlength="8" :hint="form.taxId && !taxHint ? '檢查碼正確' : '8 碼數字'" :error="save.fieldErrors.value.taxId ?? (form.taxId?.length === 8 ? taxHint ?? undefined : undefined)" />
        <div class="grid grid-cols-2 gap-3">
          <UInput v-model="form.contact" label="聯絡人（選填）" />
          <UInput v-model="form.phone" label="電話（選填）" />
        </div>
        <UTextarea v-model="form.note" label="備註（選填）" :rows="2" />
        <UCheckbox v-model="form.active" label="往來中（停用後不能再開採購單，舊單照常顯示）" />
        <p v-if="form.id && !form.active && editing?.openOrders.length" class="text-xs text-amber-700">還有進行中的採購單（{{ editing.openOrders.join('、') }}），要先到貨結案或取消才能停用。</p>
        <p v-if="save.fieldErrors.value.active" class="text-xs text-red-600">{{ save.fieldErrors.value.active }}</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton :loading="save.pending.value" type="submit">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
