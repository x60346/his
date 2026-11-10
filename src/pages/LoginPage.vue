<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Hospital, LogIn } from 'lucide-vue-next'
import { UButton, UInput } from '@/components/ui'
import { authApi } from '@/services'
import { useQuery, useAction } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { roleLabel } from '@/utils/labels'
import { safeRedirect } from '@/utils/redirect'
import type { Role } from '@/types'

const auth = useAuth()
const route = useRoute()
const router = useRouter()

const username = ref('')
const password = ref('')
/** 送出時才檢查的「沒填」：直接標在欄位下方，不必先送到服務層再跳錯誤 */
const missing = ref<{ username?: string; password?: string }>({})

// HTML 的 autofocus 只在瀏覽器第一次載入頁面時有效；單頁應用程式的登入頁是之後才掛上去的
// （登出回到登入頁時也不會重新載入），所以要自己把游標放進帳號欄
const form = ref<HTMLFormElement>()
onMounted(() => nextTick(() => form.value?.querySelector<HTMLInputElement>('input')?.focus()))

const { data: accounts } = useQuery(() => authApi.demoAccounts())
const roleOrder: Role[] = ['doctor', 'nurse', 'clerk', 'pharmacist', 'admin']
const grouped = computed(() => roleOrder.map((role) => ({ role, list: (accounts.value ?? []).filter((a) => a.role === role) })).filter((g) => g.list.length))

const doLogin = useAction((u: string, p: string) => auth.login(u, p), { success: (u) => `歡迎，${u.name}` })

async function submit(u = username.value, p = password.value) {
  missing.value = { username: u.trim() ? undefined : '請輸入帳號', password: p ? undefined : '請輸入密碼' }
  if (missing.value.username || missing.value.password) return
  const user = await doLogin.run(u, p)
  if (user) router.replace(safeRedirect(route.query.redirect))
}

/** 展示帳號：點一下直接登入（展示資料的密碼皆為 1234） */
function quick(u: string) {
  username.value = u
  password.value = '1234'
  submit(u, '1234')
}
</script>

<template>
  <div class="flex min-h-full items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-brand-900 p-4">
    <div class="grid grid-cols-1 w-full max-w-4xl overflow-hidden rounded-xl bg-white shadow-2xl md:grid-cols-2">
      <form ref="form" class="space-y-4 p-8" @submit.prevent="submit()">
        <div class="mb-6 flex items-center gap-2">
          <Hospital class="h-8 w-8 text-brand-600" />
          <div>
            <h1 class="text-xl font-bold text-slate-800">HIS 展示系統</h1>
            <p class="text-xs text-slate-500">醫院資訊系統前端展示（資料皆為虛構）</p>
          </div>
        </div>
        <UInput v-model="username" label="帳號" autocomplete="username" :error="missing.username" @input="missing.username = undefined" />
        <UInput v-model="password" label="密碼" type="password" autocomplete="current-password" :error="missing.password" @input="missing.password = undefined" />
        <UButton type="submit" block :icon="LogIn" :loading="doLogin.pending.value">登入</UButton>
        <p class="text-xs text-slate-400">展示帳號密碼皆為 1234，或直接點右側帳號登入。</p>
      </form>

      <div class="max-h-[80vh] overflow-y-auto border-t border-slate-200 bg-slate-50 p-6 md:border-l md:border-t-0">
        <h2 class="mb-3 text-sm font-semibold text-slate-700">快速登入（依角色）</h2>
        <div v-for="g in grouped" :key="g.role" class="mb-4">
          <div class="mb-1.5 text-xs font-medium text-slate-500">{{ roleLabel[g.role] }}</div>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="a in g.list"
              :key="a.username"
              type="button"
              :disabled="doLogin.pending.value"
              class="rounded-md border border-slate-200 bg-white px-3 py-2 text-left text-sm hover:border-brand-400 hover:bg-brand-50 disabled:opacity-50"
              @click="quick(a.username)"
            >
              <div class="font-medium text-slate-800">{{ a.name }}</div>
              <div class="text-xs text-slate-500">{{ a.username }}</div>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
