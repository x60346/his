<script setup lang="ts">
// 安寧（權限「安寧共同照護」，示範 dr01）：待收案的照會、收案中的病人（訪視到期、逾時在前；最近一次症狀）、30 天的訪視與家屬會議。
// 點病人到那位病人的住院醫囑「安寧」分頁處理
import { useRouter } from 'vue-router'
import { UBadge, UCard, UPageHeader, UQueryState } from '@/components/ui'
import { palliativeApi, SYMPTOM_SEVERE, SYMPTOMS } from '@/services'
import { useQuery } from '@/composables/useService'

const router = useRouter()
const { data, loading } = useQuery(() => palliativeApi.listPalliative())
const hm = (s?: string) => s?.slice(5, 16).replace('-', '/') ?? ''
const open = (id: string) => router.push({ name: 'ipd', query: { admission: id, tab: 'palliative' } })
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="安寧" description="安寧共同照護：照會收案（末期評估）、每週訪視（症狀評估）、家屬會議" />
    <UQueryState :loading="loading && !data" :ready="!!data">
      <div v-if="data" class="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_18rem]">
        <div class="space-y-4">
          <UCard :padded="false">
            <div class="border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">待收案 {{ data.requested.length }}</div>
            <p v-if="!data.requested.length" class="px-4 py-4 text-center text-sm text-slate-400">沒有待收案的照會</p>
            <button v-for="c in data.requested" :key="c.id" type="button" class="block w-full border-b border-slate-100 px-4 py-2 text-left text-sm last:border-b-0 hover:bg-slate-50" @click="open(c.admissionId)">
              <b>{{ c.patientName }}</b> <span class="text-xs text-slate-500">{{ c.ward }} {{ c.bedNo }}・{{ c.diagnosis }}・主治 {{ c.attendingName }}</span>
              <div class="text-slate-700">{{ c.reason }}</div>
              <div class="text-xs text-slate-500">{{ hm(c.requestedAt) }} {{ c.requestedByName }}照會</div>
            </button>
          </UCard>
          <UCard :padded="false">
            <div class="border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">收案中 {{ data.enrolled.length }}</div>
            <p v-if="!data.enrolled.length" class="px-4 py-4 text-center text-sm text-slate-400">沒有收案中的病人</p>
            <button v-for="c in data.enrolled" :key="c.id" type="button" class="block w-full border-b border-slate-100 px-4 py-2 text-left text-sm last:border-b-0 hover:bg-slate-50" @click="open(c.admissionId)">
              <div class="flex flex-wrap items-center gap-2">
                <b>{{ c.patientName }}</b><span class="text-xs text-slate-500">{{ c.ward }} {{ c.bedNo }}・{{ c.terminal?.disease }}</span>
                <UBadge v-if="c.visitDue" :tone="c.visitDue.status === 'overdue' ? 'red' : c.visitDue.status === 'due' ? 'yellow' : 'gray'">訪視{{ c.visitDue.status === 'overdue' ? '逾時' : c.visitDue.status === 'due' ? '到期' : '' }} {{ hm(c.visitDue.dueAt) }}</UBadge>
              </div>
              <div v-if="c.latest" class="tabular mt-0.5 flex flex-wrap gap-1 text-xs">
                <span v-for="s in SYMPTOMS" :key="s.key" :class="['rounded px-1.5', c.latest[s.key] >= SYMPTOM_SEVERE ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600']">{{ s.label }} {{ c.latest[s.key] }}</span>
              </div>
              <div class="text-xs text-slate-500">目標：{{ c.goals }}</div>
            </button>
          </UCard>
        </div>
        <UCard class="self-start">
          <div class="text-sm font-semibold text-slate-700">最近 30 天</div>
          <dl class="tabular mt-2 grid grid-cols-[1fr_auto] gap-y-1 text-sm">
            <dt class="text-slate-500">收案中</dt><dd>{{ data.stats.enrolled }}</dd>
            <dt class="text-slate-500">訪視次數</dt><dd>{{ data.stats.visits30 }}</dd>
            <dt class="text-slate-500">家屬會議</dt><dd>{{ data.stats.meetings30 }}</dd>
          </dl>
        </UCard>
      </div>
    </UQueryState>
  </div>
</template>
