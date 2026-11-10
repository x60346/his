<script setup lang="ts">
// 稽核紀錄：只能查，不能改。每個服務的寫入動作都在同一筆交易裡呼叫 audit()——
// 操作失敗、交易回滾時，稽核紀錄也一起回滾，不會留下「沒發生的事」。
import { ref } from 'vue'
import { UInput, USelect, UTable, type Column } from '@/components/ui'
import { adminApi, type AuditRow } from '@/services'
import { useDebounced, useQuery } from '@/composables/useService'

const keyword = ref('')
const kw = useDebounced(keyword)
const date = ref('')
const action = ref<string | number | undefined>('')
const userId = ref<string | number | undefined>('')

const { data: users } = useQuery(() => adminApi.listUsers())
const { data, loading } = useQuery(
  () => adminApi.listAuditLogs({ keyword: kw.value, date: date.value, action: String(action.value ?? ''), userId: String(userId.value ?? '') }),
  [kw, date, action, userId],
)

const columns: Column<AuditRow>[] = [
  { key: 'at', label: '時間', width: '9rem' },
  { key: 'userName', label: '操作者', width: '7rem' },
  { key: 'action', label: '動作', width: '9rem' },
  { key: 'detail', label: '內容' },
]
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-end gap-3">
      <UInput v-model="date" type="date" label="日期" class="w-40" />
      <USelect v-model="userId" label="操作者" :options="[{ label: '全部', value: '' }, ...(users ?? []).map((u) => ({ label: `${u.name}（${u.username}）`, value: u.id }))]" class="w-48" />
      <USelect v-model="action" label="動作" :options="[{ label: '全部', value: '' }, ...(data?.actions ?? [])]" class="w-40" />
      <UInput v-model="keyword" label="關鍵字" placeholder="病人姓名、帳號、領藥號…" class="w-56" />
      <span class="ml-auto pb-2 text-xs text-slate-500">共 {{ data?.rows.length ?? 0 }} 筆（系統保留最近 500 筆）</span>
    </div>
    <UTable :columns="columns" :rows="data?.rows" :row-key="(r) => r.id" :loading="loading && !data" dense empty-text="沒有符合條件的紀錄" class="max-h-[calc(100vh-16rem)]">
      <template #cell-at="{ row }"><span class="tabular text-xs">{{ row.at }}</span></template>
    </UTable>
  </div>
</template>
