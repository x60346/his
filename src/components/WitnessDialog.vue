<script setup lang="ts">
// 第二人當場確認（共用）：優免主管核准、管制藥點班見證、報廢覆核。
// 第二人輸入**自己的**帳號密碼；規則（不能是自己、資格、一次性、綁定對象、10 分鐘有效）全在服務層 witness-core。
// 這裡只負責：叫 approve 拿確認、帳密錯就清掉密碼讓他重打、成功就 emit approved（token、第二人姓名）。
import { ref, watch } from 'vue'
import { UButton, UDialog, UInput } from '@/components/ui'
import { useAction } from '@/composables/useService'

type Result = { ok: true; token: string; witnessName: string } | { ok: false; field: 'username' | 'password'; message: string }

const open = defineModel<boolean>({ default: false })
const props = defineProps<{
  title: string
  /** 第二人怎麼稱呼：主管、見證護理師、覆核藥師（帳號欄名、說明都用它） */
  who: string
  /** 確認的是什麼（例：藥名、批號、數量） */
  subject?: string
  /** 補充說明（例：只用於這一次結帳） */
  note?: string
  okText?: string
  danger?: boolean
  approve: (cred: { username: string; password: string }) => Promise<Result>
}>()
const emit = defineEmits<{ approved: [token: string, witnessName: string] }>()

const form = ref({ username: '', password: '' })
const err = ref<{ username?: string; password?: string }>({})
const act = useAction((cred: { username: string; password: string }) => props.approve(cred))
watch(open, (v) => {
  if (!v) return
  form.value = { username: '', password: '' }
  err.value = {}
  act.fieldErrors.value = {}
})
async function onSubmit() {
  err.value = {}
  const r = await act.run({ ...form.value })
  if (!r) return
  if (!r.ok) {
    err.value = { [r.field]: r.message }
    form.value.password = ''
    return
  }
  // 先通知、再關：呼叫端常在「關閉」時清掉暫存的動作（例：要報廢哪一批、要給哪一劑），先關的話拿到見證時已經找不到要做什麼
  emit('approved', r.token, r.witnessName)
  open.value = false
}
</script>

<template>
  <UDialog v-model="open" :title="title" size="sm" @submit="onSubmit">
    <div class="space-y-3 text-sm">
      <div v-if="subject" class="whitespace-pre-line rounded-md bg-slate-50 px-3 py-2 font-medium text-slate-700">{{ subject }}</div>
      <slot />
      <p class="text-xs text-slate-500">請{{ who }}輸入<b>自己的</b>帳號密碼（不是目前登入的人）。{{ note }}</p>
      <UInput v-model="form.username" :label="`${who}帳號`" required autocomplete="off" :error="err.username ?? act.fieldErrors.value.username" />
      <UInput v-model="form.password" label="密碼" type="password" required autocomplete="off" :error="err.password ?? act.fieldErrors.value.password" />
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton type="submit" :variant="danger ? 'danger' : 'primary'" :loading="act.pending.value">{{ okText ?? '確認' }}</UButton>
    </template>
  </UDialog>
</template>
