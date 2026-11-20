<script setup lang="ts">
// 次診斷（出院病摘、編碼審查共用）：ICD 主檔搜尋加入、移除，最多 8 個；病史裡屬於 DRG 合併症的列成「建議加入」，勾了才算。
// 能不能加（啟用、重複、和主診斷同碼、上限）在服務層檢查（ipd.checkSecondary）
import { computed } from 'vue'
import { Plus, X } from 'lucide-vue-next'
import { USearchSelect } from '@/components/ui'
import { masterApi, SECONDARY_MAX } from '@/services'
import type { IcdCode } from '@/types'

const rows = defineModel<{ icd: string; name: string }[]>({ required: true })
const props = defineProps<{ suggestions?: { icd: string; name: string }[]; error?: string; readonly?: boolean }>()
const add = (c: { icd: string; name: string }) => {
  if (rows.value.some((x) => x.icd === c.icd) || rows.value.length >= SECONDARY_MAX) return
  rows.value = [...rows.value, c]
}
const remove = (icd: string) => (rows.value = rows.value.filter((x) => x.icd !== icd))
const pending = computed(() => (props.suggestions ?? []).filter((s) => !rows.value.some((x) => x.icd === s.icd)))
</script>

<template>
  <div class="space-y-1.5 text-sm">
    <div class="text-sm font-medium text-slate-700">次診斷<span class="ml-1 text-xs font-normal text-slate-500">（最多 {{ SECONDARY_MAX }} 個；DRG 合併症看這裡）</span></div>
    <div class="flex flex-wrap gap-1.5">
      <span v-for="x in rows" :key="x.icd" class="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs">
        <b class="tabular">{{ x.icd }}</b> {{ x.name }}
        <button v-if="!readonly" type="button" class="text-slate-400 hover:text-red-600" :aria-label="`移除 ${x.icd}`" @click="remove(x.icd)"><X class="h-3 w-3" /></button>
      </span>
      <span v-if="!rows.length" class="text-xs text-slate-400">沒有次診斷</span>
    </div>
    <div v-if="!readonly && pending.length" class="flex flex-wrap items-center gap-1.5 text-xs">
      <span class="text-amber-800">病史裡的合併症，建議加入：</span>
      <button v-for="s in pending" :key="s.icd" type="button" class="inline-flex items-center gap-0.5 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-amber-900 hover:bg-amber-100" @click="add(s)"><Plus class="h-3 w-3" />{{ s.icd }} {{ s.name }}</button>
    </div>
    <USearchSelect
      v-if="!readonly && rows.length < SECONDARY_MAX"
      placeholder="加入次診斷：輸入 ICD 代碼或名稱"
      :search="(kw) => masterApi.searchIcd(kw)"
      :item-key="(c: IcdCode) => c.code"
      :item-label="(c: IcdCode) => `${c.code}　${c.name}`"
      @select="(c: IcdCode) => add({ icd: c.code, name: c.name })"
    />
    <p v-if="error" class="text-xs text-red-600">{{ error }}</p>
  </div>
</template>
