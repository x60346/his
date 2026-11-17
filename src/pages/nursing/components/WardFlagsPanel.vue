<script setup lang="ts">
// 隔離與 DNR（病房層級）：這個病房隔離中（類別、原因、第幾天、要不要檢討、床合不合）與有 DNR 的病人。
// 交班、穿戴防護、急救時要知道的事集中在一張表；點一列到那位病人的「隔離與 DNR」分頁
import { UBadge, UQueryState } from '@/components/ui'
import { flagApi, ISOLATION_KIND_LABEL, ISOLATION_REVIEW_TEXT } from '@/services'
import { useQuery } from '@/composables/useService'

const props = defineProps<{ ward: string }>()
const emit = defineEmits<{ open: [admissionId: string, tab: string] }>()
const { data: rows, loading } = useQuery(() => flagApi.wardFlags(props.ward), [() => props.ward])
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <UQueryState :loading="loading && !rows" :ready="!!rows?.length" empty-title="這個病房沒有隔離中或有 DNR 的病人">
      <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
        <li v-for="r in rows" :key="r.admissionId">
          <button type="button" class="w-full space-y-1 px-3 py-2 text-left hover:bg-slate-50" @click="emit('open', r.admissionId, 'flags')">
            <div class="flex flex-wrap items-center gap-2">
              <span class="tabular rounded bg-slate-100 px-1.5 text-xs font-medium text-slate-700">{{ r.bedNo }}</span>
              <span class="font-medium text-slate-800">{{ r.patientName }}</span>
              <span class="text-xs text-slate-500">{{ r.bedClass }}</span>
              <span v-if="r.dnr" class="ml-auto rounded bg-slate-800 px-1.5 py-0.5 text-xs font-semibold text-white" :title="r.dnr.title">{{ r.dnr.label }}</span>
            </div>
            <div v-for="i in r.isolations" :key="i.id" class="flex flex-wrap items-center gap-2 text-xs">
              <UBadge :tone="i.kind === 'airborne' ? 'red' : i.kind === 'droplet' ? 'cyan' : 'yellow'">{{ ISOLATION_KIND_LABEL[i.kind] }}</UBadge>
              <span class="text-slate-700">{{ i.organism }}</span>
              <span class="tabular text-slate-500">第 {{ i.days }} 天</span>
              <span v-if="i.review" class="font-semibold text-amber-800">{{ ISOLATION_REVIEW_TEXT[i.review] }}</span>
            </div>
            <p v-if="r.placementWarning" class="text-xs font-semibold text-red-700">請安排轉床：{{ r.placementWarning }}</p>
          </button>
        </li>
      </ul>
    </UQueryState>
  </div>
</template>
