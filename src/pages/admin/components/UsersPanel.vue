<script setup lang="ts">
// 帳號管理：新增、修改、停用（不刪除——帳號做過的事都記在稽核紀錄與病歷裡，刪掉就對不上人了）、重設密碼。
import { computed, reactive, ref } from 'vue'
import { KeyRound, Pencil, Plus } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, USelect, UTable, type Column } from '@/components/ui'
import { adminApi, masterApi, type UserRow } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { roleLabel } from '@/utils/labels'
import type { Role } from '@/types'

const auth = useAuth()
const keyword = ref('')
const roleFilter = ref<string | number | undefined>('')
const { data: users, loading } = useQuery(() => adminApi.listUsers())
const { data: doctors } = useQuery(() => masterApi.listDoctors())
const rows = computed(() =>
  (users.value ?? []).filter((u) => (!roleFilter.value || u.role === roleFilter.value) && (!keyword.value || `${u.username} ${u.name}`.includes(keyword.value.trim()))),
)

const roles = Object.entries(roleLabel).map(([value, label]) => ({ label, value }))
const columns: Column<UserRow>[] = [
  { key: 'username', label: '帳號', width: '8rem' },
  { key: 'name', label: '姓名' },
  { key: 'role', label: '角色', width: '7rem' },
  { key: 'doctorName', label: '對應醫師' },
  { key: 'lastLoginAt', label: '最近登入', width: '9rem', format: (u) => u.lastLoginAt?.slice(5) ?? '—' },
  { key: 'active', label: '狀態', width: '5rem' },
  { key: 'act', label: '', width: '13rem', align: 'right' },
]

// ---------- 新增 / 修改 ----------
const editOpen = ref(false)
const form = reactive({ id: undefined as string | undefined, username: '', name: '', role: 'clerk' as string | number | undefined, doctorId: undefined as string | number | undefined, active: true, password: '' })
const isSelf = computed(() => !!form.id && form.id === auth.user?.id)
function openEdit(u?: UserRow) {
  Object.assign(form, u ? { id: u.id, username: u.username, name: u.name, role: u.role, doctorId: u.doctorId, active: u.active, password: '' } : { id: undefined, username: '', name: '', role: 'clerk', doctorId: undefined, active: true, password: '' })
  save.fieldErrors.value = {}
  editOpen.value = true
}
// 選醫師時自動帶入姓名（省得打兩次，也避免帳號姓名和醫師姓名不一致）
function onDoctor(id: string | number | undefined) {
  form.doctorId = id
  const d = doctors.value?.find((x) => x.id === id)
  if (d && !form.name) form.name = d.name
}
const save = useAction(adminApi.saveUser, { success: (u) => `已儲存帳號 ${u.username}` })
async function submit() {
  const ok = await save.run({
    id: form.id,
    username: form.username,
    name: form.name,
    role: form.role as Role,
    doctorId: form.role === 'doctor' ? (form.doctorId as string | undefined) : undefined,
    active: form.active,
    password: form.id ? undefined : form.password,
  })
  if (ok) editOpen.value = false
}

// ---------- 重設密碼 ----------
const pwOpen = ref(false)
const pwUser = ref<UserRow>()
const newPw = ref('')
function openPw(u: UserRow) {
  pwUser.value = u
  newPw.value = ''
  resetPw.fieldErrors.value = {}
  pwOpen.value = true
}
const resetPw = useAction(adminApi.resetPassword, { success: () => `已重設 ${pwUser.value?.username} 的密碼` })
async function submitPw() {
  if (pwUser.value && (await resetPw.run(pwUser.value.id, newPw.value)) !== undefined) pwOpen.value = false
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-end gap-3">
      <UInput v-model="keyword" placeholder="帳號、姓名" class="w-48" />
      <USelect v-model="roleFilter" :options="[{ label: '全部角色', value: '' }, ...roles]" class="w-36" />
      <UButton class="ml-auto" :icon="Plus" @click="openEdit()">新增帳號</UButton>
    </div>
    <UTable :columns="columns" :rows="rows" :row-key="(u) => u.id" :loading="loading && !users" dense :row-class="(u) => (u.active ? '' : 'text-slate-400')">
      <template #cell-username="{ row }">
        <span class="tabular font-medium">{{ row.username }}</span><UBadge v-if="row.id === auth.user?.id" tone="blue" class="ml-1">我</UBadge>
      </template>
      <template #cell-role="{ row }">{{ roleLabel[row.role] }}</template>
      <template #cell-doctorName="{ row }">{{ row.doctorName || '—' }}</template>
      <template #cell-active="{ row }"><UBadge :tone="row.active ? 'green' : 'gray'">{{ row.active ? '啟用' : '停用' }}</UBadge></template>
      <template #cell-act="{ row }">
        <span class="inline-flex whitespace-nowrap">
          <UButton size="sm" variant="ghost" :icon="Pencil" @click="openEdit(row)">編輯</UButton>
          <UButton size="sm" variant="ghost" :icon="KeyRound" @click="openPw(row)">重設密碼</UButton>
        </span>
      </template>
    </UTable>

    <UDialog v-model="editOpen" :title="form.id ? `編輯帳號：${form.username}` : '新增帳號'">
      <div class="grid grid-cols-2 gap-3">
        <UInput v-model="form.username" label="帳號" required :disabled="!!form.id" hint="3–20 個英數字，建立後不可修改" :error="save.fieldErrors.value.username" />
        <USelect v-model="form.role" label="角色" required :options="roles" :disabled="isSelf" :hint="isSelf ? '不能變更自己的角色' : ''" :error="save.fieldErrors.value.role" />
        <USelect
          v-if="form.role === 'doctor'"
          :model-value="form.doctorId"
          label="對應醫師"
          required
          placeholder="請選擇"
          :options="(doctors ?? []).map((d) => ({ label: d.name, value: d.id }))"
          :error="save.fieldErrors.value.doctorId"
          @update:model-value="onDoctor"
        />
        <UInput v-model="form.name" label="姓名" required :error="save.fieldErrors.value.name" />
        <UInput v-if="!form.id" v-model="form.password" label="初始密碼" type="password" required hint="至少 4 碼" :error="save.fieldErrors.value.password" />
        <div class="col-span-2">
          <UCheckbox v-model="form.active" :disabled="isSelf" label="啟用" />
          <p v-if="isSelf" class="mt-1 text-xs text-slate-500">不能停用自己的帳號。</p>
          <p v-else-if="save.fieldErrors.value.active" class="mt-1 text-xs text-red-600">{{ save.fieldErrors.value.active }}</p>
          <p v-else-if="form.id && !form.active" class="mt-1 text-xs text-amber-700">停用後此帳號無法登入；若正在使用中，下一個操作就會被要求重新登入。</p>
        </div>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="editOpen = false">取消</UButton>
        <UButton :loading="save.pending.value" @click="submit">儲存</UButton>
      </template>
    </UDialog>

    <UDialog v-model="pwOpen" :title="`重設密碼：${pwUser?.username ?? ''}`" size="sm">
      <UInput v-model="newPw" label="新密碼" type="password" required hint="至少 4 碼；請以安全的方式告知本人" :error="resetPw.fieldErrors.value.password" />
      <template #footer>
        <UButton variant="secondary" @click="pwOpen = false">取消</UButton>
        <UButton :loading="resetPw.pending.value" @click="submitPw">重設</UButton>
      </template>
    </UDialog>
  </div>
</template>
