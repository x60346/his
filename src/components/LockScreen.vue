<script setup lang="ts">
// 閒置鎖定畫面：整個畫面蓋住（不是半透明——病人資料不能從後面透出來）。
// 同一人輸入密碼解鎖，回到原本的畫面、沒存的內容都還在；換人使用按「切換使用者」，真正登出。
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Lock } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { UButton, UInput } from '@/components/ui'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import { errorMessage } from '@/composables/useService'
import { roleLabel } from '@/utils/labels'

const auth = useAuth()
const ui = useUi()
const router = useRouter()
const password = ref('')
const error = ref('')
const pending = ref(false)
const root = ref<HTMLElement>()

// 蓋住還不夠：鍵盤 Tab 仍可能跳到後面的輸入框、對話框（對話框 Teleport 在 body 下）。
// 把 body 底下其他東西都設為 inert（不能聚焦、不能點），解鎖時還原
const inerted: Element[] = []
onMounted(async () => {
  await nextTick()
  for (const el of Array.from(document.body.children)) {
    if (el !== root.value && !el.hasAttribute('inert')) {
      el.setAttribute('inert', '')
      inerted.push(el)
    }
  }
  root.value?.querySelector('input')?.focus()
})
onBeforeUnmount(() => inerted.forEach((el) => el.removeAttribute('inert')))

async function submit() {
  if (pending.value) return
  if (!password.value) return (error.value = '請輸入密碼')
  pending.value = true
  error.value = ''
  try {
    const r = await auth.unlock(password.value)
    if (r.ok) return
    password.value = ''
    if (r.loggedOut) {
      ui.toast.warning('解鎖密碼連續錯誤，已登出')
      router.push({ name: 'login' })
    } else error.value = `密碼錯誤，再錯 ${r.remaining} 次將自動登出`
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    pending.value = false
  }
}

async function switchUser() {
  await auth.logout()
  router.push({ name: 'login' })
}
</script>

<template>
  <!-- Teleport 到 body，才能把「其他所有東西」設為 inert；keydown 不往外傳：後面開著的對話框聽 Esc，會被這裡的按鍵關掉 -->
  <Teleport to="body">
  <div ref="root" class="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900 p-4" role="dialog" aria-modal="true" aria-label="畫面已鎖定" @keydown.stop>
    <form class="w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl" @submit.prevent="submit">
      <div class="mb-4 flex flex-col items-center gap-2 text-center">
        <span class="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100"><Lock class="h-6 w-6 text-slate-600" /></span>
        <h1 class="text-lg font-bold text-slate-800">畫面已鎖定</h1>
        <p class="text-sm text-slate-500">
          {{ auth.user?.name }}（{{ auth.user ? roleLabel[auth.user.role] : '' }}）・{{ auth.lockedAt?.slice(11) }} 因閒置鎖定
        </p>
      </div>
      <UInput v-model="password" type="password" label="密碼" autocomplete="current-password" :error="error" hint="展示帳號預設密碼為 1234" />
      <UButton type="submit" block class="mt-4" :loading="pending">解鎖</UButton>
      <button type="button" class="mt-3 w-full text-center text-sm text-slate-500 hover:text-slate-700 hover:underline" @click="switchUser">
        不是 {{ auth.user?.name }}？切換使用者（未儲存的內容會遺失）
      </button>
    </form>
  </div>
  </Teleport>
</template>
