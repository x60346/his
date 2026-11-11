<script setup lang="ts">
// 變更自己的密碼：右上角的「變更密碼」對話框、管理員設定密碼後的強制變更畫面共用。
// 規則（passwordProblem）與服務層同一個；「確認新密碼」只是防打錯字，畫面檢查就好。
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { UButton, UInput } from '@/components/ui'
import { PASSWORD_RULE, passwordProblem } from '@/services'
import { useAction } from '@/composables/useService'
import { useAuth } from '@/stores/auth'

defineProps<{ submitText?: string }>()
const emit = defineEmits<{ done: [] }>()

const auth = useAuth()
const form = reactive({ current: '', next: '', confirm: '' })
// 按過送出才顯示錯誤：一打開就整排紅字，使用者會以為自己做錯了什麼
const touched = ref(false)
const nextProblem = computed(() => (touched.value || form.next ? passwordProblem(form.next, { username: auth.user?.username ?? '' }) : null))
const confirmProblem = computed(() => ((touched.value || form.confirm) && form.confirm !== form.next ? '兩次輸入的新密碼不一致' : null))

const change = useAction((c: string, n: string) => auth.changePassword(c, n), { success: '密碼已變更；其他已登入的分頁需要重新登入' })
async function submit() {
  touched.value = true
  // 新密碼的規則問題不擋送出：服務層會把「目前密碼錯」和「新密碼不合規則」一起回報，不會改一個冒一個。
  // 只有兩次輸入不一致才不送——那時送出去，萬一其他都對，就把打錯的密碼存進去了
  if (confirmProblem.value || !form.current) {
    change.fieldErrors.value = form.current ? {} : { current: '請輸入目前的密碼' }
    return
  }
  if (await change.run(form.current, form.next)) emit('done')
}

const root = ref<HTMLElement>()
onMounted(() => nextTick(() => root.value?.querySelector('input')?.focus()))
</script>

<template>
  <form ref="root" class="space-y-3" @submit.prevent="submit">
    <UInput v-model="form.current" type="password" label="目前的密碼" autocomplete="current-password" :error="change.fieldErrors.value.current" />
    <UInput v-model="form.next" type="password" label="新密碼" autocomplete="new-password" :hint="PASSWORD_RULE" :error="nextProblem ?? change.fieldErrors.value.next" />
    <UInput v-model="form.confirm" type="password" label="確認新密碼" autocomplete="new-password" :error="confirmProblem ?? undefined" />
    <UButton type="submit" block :loading="change.pending.value">{{ submitText ?? '變更密碼' }}</UButton>
  </form>
</template>
