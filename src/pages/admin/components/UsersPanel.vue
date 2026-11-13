<script setup lang="ts">
// 帳號管理：新增、修改、停用（不刪除——帳號做過的事都記在稽核紀錄與病歷裡，刪掉就對不上人了）、重設密碼。
// 一個帳號可以有多個角色（例：護理師兼櫃台）；不能兼任的組合（醫師＋藥師）用和服務層同一條 rolesProblem 即時提示。
import { computed, reactive, ref } from 'vue'
import { KeyRound, Pencil, Plus } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, USelect, UTable, type Column } from '@/components/ui'
import { adminApi, masterApi, PASSWORD_RULE, rolesProblem, type UserRow } from '@/services'
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
  (users.value ?? []).filter((u) => (!roleFilter.value || u.roles.includes(roleFilter.value as Role)) && (!keyword.value || `${u.username} ${u.name}`.includes(keyword.value.trim()))),
)

const roles = Object.entries(roleLabel).map(([value, label]) => ({ label, value }))
const columns: Column<UserRow>[] = [
  { key: 'username', label: '帳號', width: '8rem' },
  { key: 'name', label: '姓名' },
  { key: 'roles', label: '角色', width: '9rem' },
  { key: 'doctorName', label: '對應醫師' },
  { key: 'lastLoginAt', label: '最近登入', width: '9rem', format: (u) => u.lastLoginAt?.slice(5) ?? '—' },
  { key: 'active', label: '狀態', width: '5rem' },
  { key: 'act', label: '', width: '13rem', align: 'right' },
]

// ---------- 新增 / 修改 ----------
const editOpen = ref(false)
const form = reactive({ id: undefined as string | undefined, username: '', name: '', roles: ['clerk'] as Role[], doctorId: undefined as string | number | undefined, active: true, password: '', approvesDiscount: false })
const roleOrder: Role[] = ['doctor', 'nurse', 'pharmacist', 'clerk', 'admin']
function toggleRole(role: Role, on: boolean) {
  form.roles = on ? [...form.roles, role] : form.roles.filter((x) => x !== role)
}
// 勾的當下就提示不能兼任的組合（服務層也會擋）
const rolesHint = computed(() => rolesProblem(form.roles))
const hasDoctor = computed(() => form.roles.includes('doctor'))
const isSelf = computed(() => !!form.id && form.id === auth.user?.id)
function openEdit(u?: UserRow) {
  Object.assign(form, u ? { id: u.id, username: u.username, name: u.name, roles: [...u.roles], doctorId: u.doctorId, active: u.active, password: '', approvesDiscount: !!u.approvesDiscount } : { id: undefined, username: '', name: '', roles: ['clerk'], doctorId: undefined, active: true, password: '', approvesDiscount: false })
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
    roles: form.roles,
    doctorId: hasDoctor.value ? (form.doctorId as string | undefined) : undefined,
    active: form.active,
    approvesDiscount: form.approvesDiscount,
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
        <UBadge v-if="row.approvesDiscount" tone="blue" class="ml-1" title="可核准需主管核准的優免">核准優免</UBadge>
        <UBadge v-if="row.mustChangePassword" tone="yellow" class="ml-1" title="管理員設定的密碼，本人登入後須先變更">待改密碼</UBadge>
        <UBadge v-else-if="row.passwordState?.expired" tone="red" class="ml-1" :title="`${row.passwordState.expiresOn} 到期；登入後須先變更`">密碼過期</UBadge>
        <UBadge v-else-if="row.passwordState" tone="yellow" class="ml-1" :title="`${row.passwordState.expiresOn} 到期`">密碼 {{ row.passwordState.daysLeft }} 天後到期</UBadge>
      </template>
      <template #cell-roles="{ row }">{{ row.roles.map((x) => roleLabel[x]).join('、') }}</template>
      <template #cell-doctorName="{ row }">{{ row.doctorName || '—' }}</template>
      <template #cell-active="{ row }"><UBadge :tone="row.active ? 'green' : 'gray'">{{ row.active ? '啟用' : '停用' }}</UBadge></template>
      <template #cell-act="{ row }">
        <span class="inline-flex whitespace-nowrap">
          <UButton size="sm" variant="ghost" :icon="Pencil" @click="openEdit(row)">編輯</UButton>
          <UButton size="sm" variant="ghost" :icon="KeyRound" @click="openPw(row)">重設密碼</UButton>
        </span>
      </template>
    </UTable>

    <UDialog v-model="editOpen" @submit="submit" :title="form.id ? `編輯帳號：${form.username}` : '新增帳號'">
      <div class="grid grid-cols-2 gap-3">
        <UInput v-model="form.username" label="帳號" required :disabled="!!form.id" :hint="`${adminApi.USERNAME_RULE}，建立後不可修改`" :error="save.fieldErrors.value.username" />
        <fieldset class="col-span-2">
          <legend class="mb-1 text-sm font-medium text-slate-700">角色 <span class="text-red-500">*</span></legend>
          <div class="flex flex-wrap gap-x-4 gap-y-1">
            <!-- 自己的管理員角色不能拿掉（防止把自己鎖在門外）；其他角色可以加 -->
            <UCheckbox
              v-for="x in roleOrder"
              :key="x"
              :model-value="form.roles.includes(x)"
              :label="roleLabel[x]"
              :disabled="isSelf && x === 'admin'"
              @update:model-value="(v: boolean) => toggleRole(x, v)"
            />
          </div>
          <p v-if="rolesHint || save.fieldErrors.value.roles" class="mt-1 text-xs text-red-600">{{ rolesHint ?? save.fieldErrors.value.roles }}</p>
          <p v-else-if="form.roles.length > 1" class="mt-1 text-xs text-slate-500">多個角色：登入時選一個使用，右上角可切換；權限與稽核都看「當下用的角色」。</p>
          <p v-if="isSelf" class="mt-1 text-xs text-slate-500">不能拿掉自己的管理員角色。</p>
        </fieldset>
        <USelect
          v-if="hasDoctor"
          :model-value="form.doctorId"
          label="對應醫師"
          required
          placeholder="請選擇"
          :options="(doctors ?? []).map((d) => ({ label: d.name, value: d.id }))"
          :error="save.fieldErrors.value.doctorId"
          @update:model-value="onDoctor"
        />
        <UInput v-model="form.name" label="姓名" required :error="save.fieldErrors.value.name" />
        <UInput v-if="!form.id" v-model="form.password" label="初始密碼" type="password" required :hint="`${PASSWORD_RULE}；本人第一次登入時須改成自己的密碼`" :error="save.fieldErrors.value.password" />
        <div class="col-span-2">
          <UCheckbox v-model="form.approvesDiscount" label="可核准優免（需主管核准的優免類別，結帳時由此人當場輸入帳密）" class="mb-2" />
          <UCheckbox v-model="form.active" :disabled="isSelf" label="啟用" />
          <p v-if="isSelf" class="mt-1 text-xs text-slate-500">不能停用自己的帳號。</p>
          <p v-else-if="save.fieldErrors.value.active" class="mt-1 text-xs text-red-600">{{ save.fieldErrors.value.active }}</p>
          <p v-else-if="form.id && !form.active" class="mt-1 text-xs text-amber-700">停用後此帳號無法登入；若正在使用中，下一個操作就會被要求重新登入。</p>
        </div>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="editOpen = false">取消</UButton>
        <UButton :loading="save.pending.value" :disabled="!!rolesHint" type="submit">儲存</UButton>
      </template>
    </UDialog>

    <UDialog v-model="pwOpen" @submit="submitPw" :title="`重設密碼：${pwUser?.username ?? ''}`" size="sm">
      <UInput v-model="newPw" label="新密碼" type="password" required :hint="`${PASSWORD_RULE}；請以安全的方式告知本人，本人下次登入須變更，已登入的分頁會被登出`" :error="resetPw.fieldErrors.value.password" />
      <template #footer>
        <UButton variant="secondary" @click="pwOpen = false">取消</UButton>
        <UButton :loading="resetPw.pending.value" type="submit">重設</UButton>
      </template>
    </UDialog>
  </div>
</template>
