<script setup lang="ts">
// 系統管理：帳號、權限、科別・醫師、排班、收費設定、主檔、稽核紀錄、展示資料。
// 目前分頁記在網址（?tab=users），重新整理或把網址傳給同事，都會停在同一個分頁。
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { BookOpen, Building2, CalendarDays, Database, KeyRound, Receipt, ScrollText, Users } from 'lucide-vue-next'
import { UCard } from '@/components/ui'
import UsersPanel from './components/UsersPanel.vue'
import PermissionsPanel from './components/PermissionsPanel.vue'
import OrgPanel from './components/OrgPanel.vue'
import AuditPanel from './components/AuditPanel.vue'
import SchedulePanel from './components/SchedulePanel.vue'
import BillingPanel from './components/BillingPanel.vue'
import MasterPanel from './components/MasterPanel.vue'
import DataPanel from './components/DataPanel.vue'

const sections = [
  { key: 'users', label: '帳號', icon: Users, comp: UsersPanel },
  { key: 'perms', label: '權限', icon: KeyRound, comp: PermissionsPanel },
  { key: 'org', label: '科別・醫師', icon: Building2, comp: OrgPanel },
  { key: 'schedule', label: '排班', icon: CalendarDays, comp: SchedulePanel },
  { key: 'billing', label: '收費設定', icon: Receipt, comp: BillingPanel },
  { key: 'master', label: '主檔', icon: BookOpen, comp: MasterPanel },
  { key: 'audit', label: '稽核紀錄', icon: ScrollText, comp: AuditPanel },
  { key: 'data', label: '展示資料', icon: Database, comp: DataPanel },
]

const route = useRoute()
const router = useRouter()
const current = computed(() => sections.find((s) => s.key === route.query.tab) ?? sections[0])
const go = (key: string) => router.replace({ query: { ...route.query, tab: key } })
</script>

<template>
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-[11rem_1fr]">
    <nav class="flex gap-1 overflow-x-auto lg:flex-col" aria-label="系統管理分類">
      <button
        v-for="s in sections"
        :key="s.key"
        :class="['flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm', current.key === s.key ? 'bg-brand-600 font-medium text-white' : 'text-slate-600 hover:bg-white']"
        :aria-current="current.key === s.key ? 'page' : undefined"
        @click="go(s.key)"
      >
        <component :is="s.icon" class="h-4 w-4" />{{ s.label }}
      </button>
    </nav>
    <UCard class="min-w-0">
      <h2 class="mb-4 text-base font-semibold text-slate-800">{{ current.label }}</h2>
      <component :is="current.comp" />
    </UCard>
  </div>
</template>
