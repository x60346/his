<script setup lang="ts">
// 盤點單清單（目前地點）＋建立。點一張就在右側打開（StocktakeSheet）。
// 範圍：全部／某劑型／指定藥品；建立時服務層把這個地點範圍內有庫存的批號展開成每批一列。
import { computed, ref, watch } from 'vue'
import { ClipboardList, Plus } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UCheckbox, UDialog, UEmpty, UInput, USelect } from '@/components/ui'
import { masterApi, matchesDrug, stocktakeApi, type StocktakeView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import StocktakeSheet from './StocktakeSheet.vue'

const props = defineProps<{ locationId: string; locationName?: string }>()
const auth = useAuth()

const { data: sheets, loading } = useQuery(() => stocktakeApi.listStocktakes({ locationId: props.locationId || undefined }), [() => props.locationId])
const selectedId = ref<string>()
watch(() => props.locationId, () => (selectedId.value = undefined))

type StatusTone = 'yellow' | 'blue' | 'green' | 'gray'
const statusView: Record<StocktakeView['status'], { label: string; tone: StatusTone }> = {
  counting: { label: '清點中', tone: 'yellow' },
  submitted: { label: '待覆核', tone: 'blue' },
  posted: { label: '已過帳', tone: 'green' },
  cancelled: { label: '已取消', tone: 'gray' },
}

// ---------- 建立 ----------
const createOpen = ref(false)
const form = ref({ kind: 'all' as 'all' | 'category' | 'drugs', category: '', drugIds: [] as string[], kw: '' })
watch(createOpen, (v) => v && (form.value = { kind: 'all', category: '', drugIds: [], kw: '' }))
const { data: drugs } = useQuery(() => masterApi.listDrugs())
const pickable = computed(() => (drugs.value ?? []).filter((d) => !form.value.kw.trim() || matchesDrug(d, form.value.kw)))
const toggleDrug = (id: string, on: boolean) => (form.value.drugIds = on ? [...form.value.drugIds, id] : form.value.drugIds.filter((x) => x !== id))
const create = useAction(stocktakeApi.createStocktake, { success: (s) => `已建立盤點單 ${s.no}（${s.total} 批）` })
async function onCreate() {
  const f = form.value
  const scope = f.kind === 'category' ? { kind: 'category' as const, category: f.category } : f.kind === 'drugs' ? { kind: 'drugs' as const, drugIds: f.drugIds } : { kind: 'all' as const }
  const s = await create.run({ locationId: props.locationId || undefined, scope })
  if (s) {
    createOpen.value = false
    selectedId.value = s.id
  }
}
const canCreate = computed(() => auth.user?.role === 'pharmacist')
</script>

<template>
  <div class="grid grid-cols-1 gap-4 xl:grid-cols-[22rem_1fr]">
    <UCard :padded="false" class="self-start">
      <template #title><span class="text-sm font-semibold">盤點單<template v-if="locationName">・{{ locationName }}</template></span></template>
      <template #actions><UButton v-if="canCreate" size="sm" :icon="Plus" @click="createOpen = true">建立盤點單</UButton></template>
      <UEmpty v-if="!loading && !sheets?.length" :icon="ClipboardList" title="還沒有盤點單" description="建立後列印清點表，照架上實物填數量（看不到帳上數量）" />
      <ul v-else class="divide-y divide-slate-100">
        <li v-for="s in sheets" :key="s.id">
          <button type="button" :class="['flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50', s.id === selectedId && '!bg-brand-50']" @click="selectedId = s.id">
            <span class="min-w-0 flex-1">
              <span class="tabular block font-medium text-slate-800">{{ s.no }}</span>
              <span class="block text-xs text-slate-500">{{ s.scopeText }}・{{ s.total }} 批・{{ s.createdByName }} {{ s.createdAt.slice(5, 16).replace('-', '/') }}</span>
              <span v-if="s.status === 'counting'" class="tabular block text-xs text-slate-500">已清點 {{ s.countedCount }} / {{ s.total }}</span>
              <span v-else-if="s.revealed && s.status !== 'cancelled'" class="block text-xs" :class="s.diffCount ? 'text-amber-700' : 'text-emerald-700'">{{ s.diffCount ? `${s.diffCount} 批有差異` : '帳實相符' }}</span>
            </span>
            <UBadge :tone="statusView[s.status].tone">{{ statusView[s.status].label }}</UBadge>
          </button>
        </li>
      </ul>
    </UCard>

    <UCard class="self-start">
      <UEmpty v-if="!selectedId" :icon="ClipboardList" title="請選擇一張盤點單" description="清點中可填數量、列印清點表；待覆核由另一位藥師或管理員過帳" />
      <StocktakeSheet v-else :sheet-id="selectedId" :status-view="statusView" />
    </UCard>

    <UDialog v-model="createOpen" title="建立盤點單" size="md" @submit="onCreate">
      <div class="space-y-3">
        <p class="text-sm text-slate-600">盤點「{{ locationName ?? '藥局' }}」：範圍內有庫存的批號各一列。清點與覆核完成前，這些藥在這裡的帳上數量會暫時不顯示（盲盤）。</p>
        <USelect v-model="form.kind" label="範圍" :options="[{ label: '全部藥品', value: 'all' }, { label: '某一劑型', value: 'category' }, { label: '指定藥品', value: 'drugs' }]" :error="create.fieldErrors.value.scope" />
        <USelect v-if="form.kind === 'category'" v-model="form.category" label="劑型" placeholder="請選擇" :options="['口服', '外用', '注射', '吸入', '眼用']" :error="create.fieldErrors.value.category" />
        <div v-if="form.kind === 'drugs'" class="space-y-2">
          <UInput v-model="form.kw" placeholder="搜尋藥名、中文名、作用" />
          <p v-if="create.fieldErrors.value.drugIds" class="text-xs text-red-600">{{ create.fieldErrors.value.drugIds }}</p>
          <div class="max-h-56 space-y-1 overflow-y-auto rounded-md border border-slate-200 px-3 py-2">
            <UCheckbox v-for="d in pickable" :key="d.id" :model-value="form.drugIds.includes(d.id)" @update:model-value="(v) => toggleDrug(d.id, v)">
              {{ d.name }} <span class="text-xs text-slate-500">{{ d.nameZh }}・{{ d.category }}</span>
            </UCheckbox>
          </div>
          <p class="text-xs text-slate-500">已選 {{ form.drugIds.length }} 種</p>
        </div>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="createOpen = false">取消</UButton>
        <UButton type="submit" :loading="create.pending.value">建立</UButton>
      </template>
    </UDialog>
  </div>
</template>
