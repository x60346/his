<script setup lang="ts">
// 管理員設定的密碼（新帳號、重設）、或密碼過期：登入後先改密碼才能使用（過期不鎖帳號，改了就能用）。
// 和鎖定畫面一樣整個蓋住、其他元素設為 inert；服務層也擋（requireUser → PASSWORD_CHANGE），不是只有畫面。
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { KeyRound } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import PasswordChangeForm from './PasswordChangeForm.vue'
import { useAuth } from '@/stores/auth'

const auth = useAuth()
const router = useRouter()
const root = ref<HTMLElement>()
const inerted: Element[] = []
onMounted(async () => {
  await nextTick()
  for (const el of Array.from(document.body.children)) {
    if (el !== root.value && !el.hasAttribute('inert')) {
      el.setAttribute('inert', '')
      inerted.push(el)
    }
  }
})
onBeforeUnmount(() => inerted.forEach((el) => el.removeAttribute('inert')))

async function logout() {
  await auth.logout()
  router.push({ name: 'login' })
}
</script>

<template>
  <Teleport to="body">
    <div ref="root" class="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-slate-900 p-4" role="dialog" aria-modal="true" aria-label="請先變更密碼" @keydown.stop>
      <div class="w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl">
        <div class="mb-4 flex flex-col items-center gap-2 text-center">
          <span class="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100"><KeyRound class="h-6 w-6 text-amber-700" /></span>
          <h1 class="text-lg font-bold text-slate-800">{{ auth.user?.passwordExpired ? '密碼已過期' : '請先變更密碼' }}</h1>
          <p v-if="auth.user?.passwordExpired" class="text-sm text-slate-500">{{ auth.user?.name }}，這組密碼已超過使用期限，請設定新密碼再繼續（不可與最近用過的密碼相同）。</p>
          <p v-else class="text-sm text-slate-500">{{ auth.user?.name }}，目前的密碼是管理員設定的，請改成只有你知道的密碼再開始使用。</p>
        </div>
        <PasswordChangeForm submit-text="變更密碼並開始使用" />
        <button type="button" class="mt-3 w-full text-center text-sm text-slate-500 hover:text-slate-700 hover:underline" @click="logout">登出</button>
      </div>
    </div>
  </Teleport>
</template>
