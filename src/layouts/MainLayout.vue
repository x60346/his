<script setup lang="ts">
// 主版面：側邊選單（依角色過濾）、頂端列、展示資料過期提示。
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Eye, Hospital, LogOut, Menu, RotateCcw, X } from 'lucide-vue-next'
import { UButton } from '@/components/ui'
import { appRoutes, menuGroups } from '@/router/routes'
import { dbVersion, masterApi } from '@/services'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import { roleLabel } from '@/utils/labels'
import { toRoc, today, weekdayLabel } from '@/utils/date'

const auth = useAuth()
const ui = useUi()
const route = useRoute()
const router = useRouter()

// 選單直接由路由表產生，並以「與路由守衛相同」的 canAccess 過濾，兩邊不會對不上
const menu = computed(() =>
  menuGroups
    .map((group) => ({
      group,
      items: appRoutes.filter((r) => r.meta?.group === group && auth.canAccess(r.meta.roles)),
    }))
    .filter((g) => g.items.length),
)

// 管理員可以進入所有頁面，但臨床操作由服務層擋下（requireUser 不再對管理員放行）。
// 進入「沒有開放給管理員角色」的頁面時先提示，免得按了按鈕才發現不能做
const adminViewOnly = computed(() => auth.user?.role === 'admin' && !!route.meta.roles?.length && !route.meta.roles.includes('admin'))
const viewOnlyRoles = computed(() => route.meta.roles?.map((r) => roleLabel[r]).join('、') ?? '')

const mobileOpen = ref(false)
watch(() => route.fullPath, () => (mobileOpen.value = false))

// 展示資料過期提示（dbVersion 變動時重新判斷，例如重置之後）
const seed = computed(() => (dbVersion.value, masterApi.seedInfo()))
const resetting = ref(false)
async function resetData() {
  const ok = await ui.confirm({
    title: '重置展示資料',
    message: '所有資料將還原為「以今天為基準」的初始展示資料，目前的操作紀錄會被清除。',
    okText: '重置',
    danger: true,
  })
  if (!ok) return
  resetting.value = true
  await masterApi.resetDemoData()
  resetting.value = false
  ui.toast.success('已重置為今天的展示資料')
}

async function logout() {
  await auth.logout()
  router.push({ name: 'login' })
}

const dateText = `${toRoc(today())}（${weekdayLabel(today())}）`
</script>

<template>
  <div class="flex h-full">
    <!-- 手機版遮罩 -->
    <div v-if="mobileOpen" class="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" @click="mobileOpen = false" />

    <aside
      :class="[
        'fixed inset-y-0 left-0 z-40 flex w-56 flex-col bg-slate-900 text-slate-300 transition-transform lg:static lg:translate-x-0',
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
      ]"
    >
      <div class="flex h-14 items-center gap-2 px-4 text-white">
        <Hospital class="h-6 w-6 text-brand-400" />
        <span class="font-bold tracking-wide">HIS 展示系統</span>
        <button class="ml-auto lg:hidden" aria-label="關閉選單" @click="mobileOpen = false"><X class="h-5 w-5" /></button>
      </div>
      <nav class="flex-1 space-y-4 overflow-y-auto px-2 py-3">
        <div v-for="g in menu" :key="g.group">
          <div class="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-slate-500">{{ g.group }}</div>
          <RouterLink
            v-for="item in g.items"
            :key="String(item.name)"
            :to="{ name: item.name }"
            class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-slate-800 hover:text-white"
            exact-active-class="!bg-brand-600 !text-white"
          >
            <component :is="item.meta?.icon" class="h-4 w-4" />
            {{ item.meta?.title }}
          </RouterLink>
        </div>
      </nav>
      <div class="border-t border-slate-800 px-4 py-3 text-xs text-slate-500">所有資料皆為虛構，僅供展示</div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="no-print flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4">
        <button class="rounded p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden" aria-label="開啟選單" @click="mobileOpen = true">
          <Menu class="h-5 w-5" />
        </button>
        <h1 class="truncate text-base font-semibold text-slate-800">{{ route.meta.title }}</h1>
        <span class="hidden text-sm text-slate-500 sm:inline">{{ dateText }}</span>
        <div class="ml-auto flex items-center gap-3">
          <div class="text-right leading-tight">
            <div class="text-sm font-medium text-slate-800">{{ auth.user?.name }}</div>
            <div class="text-xs text-slate-500">{{ auth.user ? roleLabel[auth.user.role] : '' }}</div>
          </div>
          <UButton variant="ghost" size="sm" :icon="LogOut" @click="logout">登出</UButton>
        </div>
      </header>

      <div v-if="seed.stale" class="no-print flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
        展示資料建立於 {{ seed.seededAt }}，今日的候診、住院給藥等情境可能已不連貫。
        <UButton size="sm" variant="secondary" :icon="RotateCcw" :loading="resetting" @click="resetData">重置為今天</UButton>
      </div>

      <div v-if="adminViewOnly" class="no-print flex items-center gap-2 border-b border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900" role="status">
        <Eye class="h-4 w-4 shrink-0" />
        系統管理員僅能檢視此頁；新增、修改等臨床操作請以{{ viewOnlyRoles }}帳號登入。
      </div>
      <main class="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
        <RouterView />
      </main>
    </div>
  </div>
</template>
