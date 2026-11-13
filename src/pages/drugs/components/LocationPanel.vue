<script setup lang="ts">
// 庫存地點：新增、改名、停用；三項工作（門診發藥、住院調劑與病房常備、採購入庫）由哪個地點負責。
// 能不能停用、能不能接某項工作都由服務層判斷（inventory.locationBlockers、setLocationRole），畫面只把原因先列出來。
// 改負責地點影響大：服務層先回 CONFLICT 說明「之後從哪裡扣」，這裡確認後帶 confirm 重送。
import { useCan } from '@/composables/useCan'
import { computed, reactive, ref } from 'vue'
import { Pencil, Plus, Warehouse } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UCheckbox, UDialog, UEmpty, UInput, UQueryState, USelect } from '@/components/ui'
import { inventoryApi, LOCATION_ROLES, ServiceError, type LocationRole, type StockLocationInput, type StockLocationView } from '@/services'
import { Cancelled, useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'

const ui = useUi()
const can = useCan()
const { data, loading } = useQuery(() => inventoryApi.listStockLocations({ includeInactive: true }))
const locations = computed(() => data.value?.locations ?? [])
const kindLabel = (k: StockLocationView['kind']) => (k === 'warehouse' ? '藥庫' : k === 'quarantine' ? '待報廢區' : k === 'ward' ? '病房常備' : '藥局')
const roleLabel = (r: LocationRole) => LOCATION_ROLES.find((x) => x.key === r)!.label

// ---------- 新增／編輯 ----------
const open = ref(false)
const form = reactive<StockLocationInput>({ name: '', kind: 'pharmacy', active: true })
const editing = computed(() => locations.value.find((l) => l.id === form.id))
function edit(l?: StockLocationView) {
  Object.assign(form, l ? { id: l.id, name: l.name, kind: l.kind, active: l.active } : { id: undefined, name: '', kind: 'pharmacy', active: true })
  save.fieldErrors.value = {}
  open.value = true
}
const save = useAction(inventoryApi.saveStockLocation, { success: (l) => `已儲存庫存地點：${l.name}` })
async function submit() {
  if (await save.run({ ...form })) open.value = false
}

// ---------- 負責的工作 ----------
const picks = reactive<Record<LocationRole, string>>({ opd: '', ipd: '', receiving: '' })
const holderOf = (r: (typeof LOCATION_ROLES)[number]) => locations.value.find((l) => l.active && l[r.flag])
const optionsFor = (r: (typeof LOCATION_ROLES)[number]) =>
  locations.value.filter((l) => l.active && !l[r.flag] && l.kind !== 'quarantine' && l.kind !== 'ward' && (!r.pharmacyOnly || l.kind === 'pharmacy')).map((l) => ({ label: `${l.name}（${kindLabel(l.kind)}）`, value: l.id }))
async function moveRole(input: { role: LocationRole; locationId: string }) {
  try {
    return await inventoryApi.setLocationRole(input)
  } catch (e) {
    if (!(e instanceof ServiceError && e.code === 'CONFLICT' && e.field === 'confirm')) throw e
    const ok = await ui.confirm({ title: `改由別的地點負責${roleLabel(input.role)}`, message: e.message, okText: '確定改', danger: true })
    if (!ok) throw new Cancelled()
    return inventoryApi.setLocationRole({ ...input, confirm: true })
  }
}
const move = useAction(moveRole, { success: (r) => `已改由「${r.to}」負責` })
async function onMove(role: LocationRole) {
  if (!picks[role]) return
  if (await move.run({ role, locationId: picks[role] })) picks[role] = ''
}
</script>

<template>
  <div class="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr))]">
    <UCard :padded="false" class="self-start">
      <template #title><span class="text-sm font-semibold">庫存地點</span></template>
      <template #actions><UButton v-if="can('location.edit')" size="sm" :icon="Plus" @click="edit()">新增地點</UButton></template>
      <UQueryState :loading="loading && !data" :ready="!!data">
        <UEmpty v-if="!locations.length" :icon="Warehouse" title="沒有庫存地點" />
        <ul v-else class="divide-y divide-slate-100">
          <li v-for="l in locations" :key="l.id" :class="['flex items-start gap-3 px-4 py-2.5', !l.active && 'text-slate-400']">
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-center gap-1 font-medium">
                {{ l.name }}<UBadge :tone="l.kind === 'warehouse' ? 'blue' : l.kind === 'quarantine' ? 'red' : 'gray'">{{ kindLabel(l.kind) }}</UBadge><UBadge v-if="!l.active">停用</UBadge>
              </p>
              <p class="text-xs text-slate-500">
                {{ l.drugCount }} 種藥有庫存<template v-if="l.roles.length">・負責{{ l.roles.map(roleLabel).join('、') }}</template>
              </p>
              <p v-if="l.active && l.blockers?.length" class="mt-0.5 text-xs text-slate-400" title="停用前要先處理">不能停用：{{ l.blockers.join('；') }}</p>
            </div>
            <UButton v-if="can('location.edit')" size="sm" variant="ghost" :icon="Pencil" @click="edit(l)">編輯</UButton>
          </li>
        </ul>
      </UQueryState>
    </UCard>

    <UCard title="負責的工作" subtitle="每一項同一時間只由一個地點負責" class="self-start">
      <div class="space-y-4 text-sm">
        <div v-for="r in LOCATION_ROLES" :key="r.key" class="space-y-1">
          <p class="font-medium text-slate-700">
            {{ r.label }}：<span class="text-brand-700">{{ holderOf(r)?.name ?? '（無）' }}</span>
          </p>
          <div v-if="can('location.edit')" class="flex flex-wrap items-end gap-2">
            <div class="w-56">
              <USelect v-model="picks[r.key]" :options="optionsFor(r)" placeholder="改由…" />
            </div>
            <UButton size="sm" variant="secondary" :disabled="!picks[r.key]" :loading="move.pending.value" @click="onMove(r.key)">改由此地點負責</UButton>
          </div>
        </div>
        <p class="text-xs text-slate-500">
          門診發藥：醫師開藥看的可用量、門診領藥扣這裡。住院調劑與病房常備：UD 調劑、PRN／STAT 給藥扣這裡。採購入庫：採購單核准時決定到貨進哪裡。
          藥庫不直接發藥給病人，前兩項只能由藥局負責。改了之後，已經開出的單據（已訂購的採購單、已調劑的 UD、撥補單）照原地點處理。
        </p>
      </div>
    </UCard>

    <UDialog v-model="open" :title="form.id ? `編輯庫存地點：${editing?.name ?? ''}` : '新增庫存地點'" size="sm" @submit="submit">
      <div class="space-y-3">
        <UInput v-model="form.name" label="名稱" required placeholder="例：急診藥局" :error="save.fieldErrors.value.name" hint="改名只改名稱，舊單據顯示新名稱（單據記的是地點本身）" />
        <USelect
          v-if="!form.id"
          v-model="form.kind"
          label="類別"
          required
          :options="[{ label: '藥局（可負責發藥）', value: 'pharmacy' }, { label: '藥庫（採購入庫、撥補給藥局）', value: 'warehouse' }]"
          :error="save.fieldErrors.value.kind"
        />
        <p v-else class="text-xs text-slate-500">類別：{{ kindLabel(form.kind!) }}（建立後不能改）</p>
        <UCheckbox v-if="form.id" v-model="form.active" label="啟用中" />
        <p v-if="form.id && !form.active && editing?.active && editing.blockers?.length && !save.fieldErrors.value.active" class="text-xs text-amber-700">要先處理：{{ editing.blockers.join('；') }}</p>
        <p v-if="save.fieldErrors.value.active" class="text-xs text-red-600">{{ save.fieldErrors.value.active }}</p>
        <p v-if="!form.id" class="text-xs text-slate-500">新地點一開始不負責任何工作、也沒有庫存：藥局可向藥庫請領（撥補單），或在右邊改由它負責某項工作。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton :loading="save.pending.value" type="submit">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
