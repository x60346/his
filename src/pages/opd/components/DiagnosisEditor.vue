<script setup lang="ts">
// 診斷：ICD-10 搜尋加入、指定主診斷、移除。
import { Star, Trash2 } from 'lucide-vue-next'
import { USearchSelect, UEmpty } from '@/components/ui'
import { masterApi } from '@/services'
import { useUi } from '@/stores/ui'
import type { Diagnosis, IcdCode } from '@/types'

const rows = defineModel<Diagnosis[]>({ required: true })
defineProps<{ readonly?: boolean }>()
const ui = useUi()

function add(c: IcdCode) {
  if (rows.value.some((d) => d.icd === c.code)) return ui.toast.warning(`${c.code} 已在診斷中`)
  // 第一個加入的自動成為主診斷
  rows.value.push({ icd: c.code, name: c.name, primary: rows.value.length === 0 })
}
function setPrimary(i: number) {
  rows.value.forEach((d, k) => (d.primary = k === i))
}
function remove(i: number) {
  const wasPrimary = rows.value[i].primary
  rows.value.splice(i, 1)
  if (wasPrimary && rows.value.length) rows.value[0].primary = true
}
</script>

<template>
  <div class="space-y-3">
    <USearchSelect
      v-if="!readonly"
      placeholder="輸入 ICD 代碼、中文或英文，例：J06、高血壓、diabetes"
      :search="(kw) => masterApi.searchIcd(kw)"
      :item-key="(c) => c.code"
      :item-label="(c) => `${c.code}　${c.name}`"
      :item-sub="(c) => c.nameEn"
      @select="add"
    />
    <UEmpty v-if="!rows.length" title="尚未輸入診斷" description="完成看診前至少需要一個診斷" />
    <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
      <li v-for="(d, i) in rows" :key="d.icd" class="flex items-center gap-3 px-3 py-2 text-sm">
        <button
          :disabled="readonly"
          :title="d.primary ? '主診斷' : '設為主診斷'"
          :class="['rounded p-1', d.primary ? 'text-amber-500' : 'text-slate-300 hover:text-amber-400', readonly && 'cursor-default']"
          @click="setPrimary(i)"
        >
          <Star class="h-4 w-4" :fill="d.primary ? 'currentColor' : 'none'" />
        </button>
        <span class="tabular w-20 font-medium text-slate-700">{{ d.icd }}</span>
        <span class="flex-1 text-slate-800">{{ d.name }}</span>
        <span v-if="d.primary" class="text-xs font-medium text-amber-600">主診斷</span>
        <button v-if="!readonly" class="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="移除" @click="remove(i)">
          <Trash2 class="h-4 w-4" />
        </button>
      </li>
    </ul>
  </div>
</template>
