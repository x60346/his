<script setup lang="ts">
// 感染管制（權限「感染管制」，示範 dr11）：全院待判定的院內感染個案（舊的在前）、最近 30 天判定過的；點一筆在右邊判定（和病人分頁同一個元件）
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { UBadge, UCard, UPageHeader, UQueryState, UTabs } from '@/components/ui'
import IpcPanels from './components/IpcPanels.vue'
import InfectionPanel from '@/components/InfectionPanel.vue'
import { infectionApi } from '@/services'
import { useQuery } from '@/composables/useService'

const { data, loading, reload } = useQuery(() => infectionApi.listInfectionWork())
const picked = ref<string>()
// 分頁：個案判定、指標、群聚、法定傳染病
// 首頁卡片帶 ?tab= 直接到對的分頁（群聚、法定傳染病）
const route = useRoute()
const tabOf = (q: unknown) => (['cases', 'stats', 'clusters', 'notify'] as const).find((x) => x === String(q ?? ''))
const tab = ref<'cases' | 'stats' | 'clusters' | 'notify'>(tabOf(route.query.tab) ?? 'cases')
// 已經在這頁、又從首頁卡片點進來（只有網址的 tab 變）：跟著切
watch(() => route.query.tab, (q) => { const t = tabOf(q); if (t) tab.value = t })
const tabs = computed(() => [
  { key: 'cases', label: '個案判定', count: data.value?.pending.length || undefined },
  { key: 'stats', label: '指標' },
  { key: 'clusters', label: '群聚' },
  { key: 'notify', label: '法定傳染病' },
])
const sel = computed(() => [...(data.value?.pending ?? []), ...(data.value?.decided ?? [])].find((c) => c.admissionId === picked.value))
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="感染管制" description="院內感染個案判定、全院指標、群聚偵測、法定傳染病通報" />
    <UTabs v-model="tab" :tabs="tabs" />
    <IpcPanels v-if="tab !== 'cases'" :mode="tab" @changed="reload" />
    <div v-else class="grid grid-cols-1 gap-4 lg:grid-cols-[24rem_1fr]">
      <UCard :padded="false" class="self-start">
        <UQueryState :loading="loading && !data" :ready="!!data">
          <div v-if="data" class="text-sm">
            <div class="border-b border-slate-100 px-3 py-2 font-semibold text-slate-700">待判定 {{ data.pending.length }}</div>
            <p v-if="!data.pending.length" class="px-3 py-4 text-center text-slate-400">沒有待判定的個案</p>
            <button v-for="c in data.pending" :key="c.id" :class="['w-full border-b border-slate-100 px-3 py-2 text-left hover:bg-slate-50', c.admissionId === picked && '!bg-brand-50']" @click="picked = c.admissionId">
              <div class="flex flex-wrap items-center gap-1.5"><UBadge tone="yellow">{{ c.label }}</UBadge><b>{{ c.patientName }}</b><span class="text-xs text-slate-500">{{ c.ward }} {{ c.bedNo }}</span></div>
              <div class="text-xs text-slate-600">發生 {{ c.onsetAt.slice(5) }}・{{ c.culture }}</div>
            </button>
            <details v-if="data.decided.length" class="px-3 py-2">
              <summary class="cursor-pointer text-slate-600">最近 30 天判定過 {{ data.decided.length }} 筆</summary>
              <button v-for="c in data.decided" :key="c.id" class="block w-full py-1 text-left text-xs text-slate-600 hover:bg-slate-50" @click="picked = c.admissionId">
                {{ c.onsetAt.slice(5) }} {{ c.patientName }}・{{ c.label }}・{{ c.status === 'confirmed' ? '成立' : '不成立' }}
              </button>
            </details>
          </div>
        </UQueryState>
      </UCard>
      <UCard v-if="sel" :title="`${sel.patientName}（${sel.ward} ${sel.bedNo}）`" :padded="false">
        <InfectionPanel :admission-id="sel.admissionId" @changed="reload" />
      </UCard>
      <p v-else class="self-start rounded-md border border-slate-200 bg-white px-3 py-6 text-center text-sm text-slate-400">從左邊選一筆個案</p>
    </div>
  </div>
</template>
