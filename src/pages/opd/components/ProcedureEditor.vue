<script setup lang="ts">
// 處置、檢驗、影像醫令。診察費由批價自動計入，所以搜尋時排除「診察」類別，避免重複收費。
import { Trash2 } from 'lucide-vue-next'
import { UBadge, UEmpty, USearchSelect } from '@/components/ui'
import { masterApi } from '@/services'
import { useUi } from '@/stores/ui'
import type { Procedure, ProcedureOrder } from '@/types'

const rows = defineModel<ProcedureOrder[]>({ required: true })
defineProps<{ procs: Map<string, Procedure>; readonly?: boolean }>()
const ui = useUi()

async function search(kw: string) {
  return (await masterApi.listProcedures({ keyword: kw })).filter((p) => p.category !== '診察')
}
function add(p: Procedure) {
  if (rows.value.some((r) => r.procId === p.id)) return ui.toast.warning(`${p.name} 已在醫令中`)
  // 健保點數為 0 的項目（證明書、自費疫苗）預設勾自費
  rows.value.push({ procId: p.id, qty: 1, selfPay: p.points === 0 })
}
</script>

<template>
  <div class="space-y-3">
    <USearchSelect
      v-if="!readonly"
      placeholder="輸入檢驗、影像、處置名稱或代碼，例：CBC、X 光、換藥"
      :search="search"
      :search-empty="true"
      :item-key="(p) => p.id"
      :item-label="(p) => `${p.code}　${p.name}`"
      :item-sub="(p) => `${p.category}・${p.points ? `${p.points} 點` : `自費 ${p.selfPrice} 元`}`"
      @select="add"
    />
    <UEmpty v-if="!rows.length" title="尚未開立處置或檢驗" />
    <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
      <li v-for="(r, i) in rows" :key="r.procId" class="flex items-center gap-3 px-3 py-2 text-sm">
        <UBadge>{{ procs.get(r.procId)?.category }}</UBadge>
        <span class="flex-1 text-slate-800">{{ procs.get(r.procId)?.name ?? r.procId }}</span>
        <span class="tabular text-xs text-slate-500">
          {{ r.selfPay || !procs.get(r.procId)?.points ? `自費 ${procs.get(r.procId)?.selfPrice} 元` : `${procs.get(r.procId)?.points} 點` }}
        </span>
        <input v-model.number="r.qty" type="number" min="1" class="form-control w-16 px-2" :disabled="readonly" aria-label="數量" />
        <label class="flex items-center gap-1 text-xs text-slate-600">
          <input v-model="r.selfPay" type="checkbox" class="h-4 w-4 rounded border-slate-300 text-brand-600" :disabled="readonly || !procs.get(r.procId)?.points" />自費
        </label>
        <button v-if="!readonly" class="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="刪除" @click="rows.splice(i, 1)"><Trash2 class="h-4 w-4" /></button>
      </li>
    </ul>
  </div>
</template>
