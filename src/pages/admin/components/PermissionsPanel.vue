<script setup lang="ts">
// 權限：頁面存取（從路由表產生）＋操作權限（從權限目錄 permission-rules 產生，服務層 requirePermission 讀同一份）。
// 只能在目錄允許的範圍內調整：固定的不能改；可調整的只能在「法規允許的角色」裡勾、至少留一個（可指定個人的，已指定了人就可以全部取消）；主管型的可以指定給個人。
// 每次調整都要寫原因（稽核）；會讓人失去權限的，服務層先回 CONFLICT 列出帳號，這裡確認後帶 confirm 重送。
import { computed, reactive, ref } from 'vue'
import { Check, Lock, Minus, Pencil, UserPlus, X } from 'lucide-vue-next'
import { routes } from '@/router/routes'
import { roleLabel } from '@/utils/labels'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import { adminApi, permissionApi, ServiceError, type PermissionRow, type PermKey } from '@/services'
import { Cancelled, useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import type { Role } from '@/types'

const ui = useUi()
const roles = Object.keys(roleLabel) as Role[]
const pages = computed(() =>
  (routes.find((r) => r.children)?.children ?? [])
    .filter((r) => r.meta?.group)
    .map((r) => ({ title: r.meta!.title!, group: r.meta!.group!, roles: r.meta!.roles })),
)
const allowedPage = (p: { roles?: Role[] }, role: Role) => role === 'admin' || !p.roles?.length || p.roles.includes(role)

const { data: rows, loading } = useQuery(() => permissionApi.listPermissions())
const { data: users } = useQuery(() => adminApi.listUsers())

// ---------- 調整角色 ----------
const editing = ref<PermissionRow | null>(null)
const editOpen = computed({ get: () => !!editing.value, set: (v) => !v && (editing.value = null) })
const form = reactive<{ roles: Role[]; reason: string }>({ roles: [], reason: '' })
function openEdit(r: PermissionRow) {
  Object.assign(form, { roles: [...r.roles], reason: '' })
  save.fieldErrors.value = {}
  editing.value = r
}
const toggle = (r: Role, on: boolean) => (form.roles = on ? [...form.roles, r] : form.roles.filter((x) => x !== r))
async function saveRoles(key: PermKey, input: { roles: Role[]; reason: string }) {
  try {
    return await permissionApi.savePermissionRoles(key, input)
  } catch (e) {
    if (!(e instanceof ServiceError && e.code === 'CONFLICT' && e.field === 'confirm')) throw e
    if (!(await ui.confirm({ title: '有人會失去權限', message: `${e.message}\n\n確定調整？`, okText: '確定調整', danger: true }))) throw new Cancelled()
    return permissionApi.savePermissionRoles(key, { ...input, confirm: true })
  }
}
const save = useAction(saveRoles, { success: (r) => `已調整「${r.label}」` })
async function onSave() {
  if (editing.value && (await save.run(editing.value.key, { ...form }))) editing.value = null
}

// ---------- 指定個人 ----------
const granting = ref<PermissionRow | null>(null)
const grantOpen = computed({ get: () => !!granting.value, set: (v) => !v && (granting.value = null) })
const gForm = reactive<{ userId: string | number | undefined; reason: string }>({ userId: undefined, reason: '' })
const grantCandidates = computed(() =>
  (users.value ?? [])
    .filter((u) => u.active && granting.value && u.roles.some((r) => granting.value!.candidates.includes(r)) && !granting.value.grantees.some((g) => g.userId === u.id))
    .map((u) => ({ label: `${u.name}（${u.username}・${u.roles.map((r) => roleLabel[r]).join('、')}）`, value: u.id })),
)
function openGrant(r: PermissionRow) {
  Object.assign(gForm, { userId: undefined, reason: '' })
  grant.fieldErrors.value = {}
  granting.value = r
}
const grant = useAction(permissionApi.setPermissionGrant, { success: (r) => `已更新「${r.label}」的指定人員` })
async function onGrant() {
  if (granting.value && gForm.userId && (await grant.run(granting.value.key, String(gForm.userId), { on: true, reason: gForm.reason }))) granting.value = null
}
// 收回：寫原因（ReasonDialog）
const revoking = ref<{ row: PermissionRow; user: PermissionRow['grantees'][number] } | null>(null)
const revokeOpen = computed({ get: () => !!revoking.value, set: (v) => !v && (revoking.value = null) })
async function confirmRevoke(reason: string) {
  const x = revoking.value
  if (x && (await grant.run(x.row.key, x.user.userId, { on: false, reason }))) revoking.value = null
}
const groups = computed(() => [...new Set((rows.value ?? []).map((r) => r.group))])
</script>

<template>
  <div class="space-y-6">
    <section>
      <h3 class="mb-1 text-sm font-semibold text-slate-700">操作權限</h3>
      <p class="mb-2 text-xs text-slate-500">
        由權限目錄產生，服務層每個受控操作都檢查同一份——這張表就是系統實際的規則。只能在<b>法規允許的角色</b>內調整（灰色格子不能勾）；
        <Lock class="inline h-3 w-3" /> 固定的權限牽涉醫療紀錄與法律責任，不能調整。
      </p>
      <UQueryState :loading="loading && !rows" :ready="!!rows">
        <div class="overflow-x-auto rounded-md border border-slate-200">
          <table class="w-full text-sm">
            <thead class="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th class="px-3 py-2 text-left font-medium">操作</th>
                <th v-for="r in roles" :key="r" class="whitespace-nowrap px-2 py-2 text-center font-medium">{{ roleLabel[r] }}</th>
                <th class="px-3 py-2 text-left font-medium">指定個人</th>
                <th class="px-2 py-2" />
              </tr>
            </thead>
            <tbody v-for="g in groups" :key="g" class="divide-y divide-slate-100 border-t border-slate-200">
              <tr><td :colspan="roles.length + 3" class="bg-slate-50/60 px-3 py-1 text-xs font-semibold text-slate-500">{{ g }}</td></tr>
              <tr v-for="p in rows!.filter((x) => x.group === g)" :key="p.key" :class="p.changed && 'bg-amber-50/50'">
                <td class="px-3 py-1.5">
                  <div class="flex items-center gap-1 font-medium text-slate-800">
                    <Lock v-if="p.fixed" class="h-3.5 w-3.5 text-slate-400" />{{ p.label }}
                    <UBadge v-if="p.changed" tone="yellow">已調整</UBadge>
                  </div>
                  <div class="text-xs text-slate-500">{{ p.covers }}<template v-if="p.note">・{{ p.note }}</template></div>
                </td>
                <td v-for="r in roles" :key="r" class="px-2 text-center">
                  <Check v-if="p.roles.includes(r)" class="mx-auto h-4 w-4 text-emerald-600" :aria-label="`${roleLabel[r]}可以`" />
                  <span v-else-if="p.candidates.includes(r)" class="mx-auto block h-4 w-4 rounded border border-slate-300" :title="`可以開放給${roleLabel[r]}`" />
                  <Minus v-else class="mx-auto h-4 w-4 text-slate-200" :aria-label="`${roleLabel[r]}不在法規範圍`" />
                </td>
                <td class="px-3 py-1.5 text-xs">
                  <template v-if="p.grantable || p.grantOnly">
                    <span v-for="u in p.grantees" :key="u.userId" class="mr-1 inline-flex items-center gap-0.5 rounded bg-sky-100 px-1.5 py-0.5 text-sky-800">
                      {{ u.name }}<button type="button" class="text-sky-600 hover:text-red-600" :aria-label="`收回 ${u.name}`" @click="revoking = { row: p, user: u }"><X class="h-3 w-3" /></button>
                    </span>
                    <button type="button" class="inline-flex items-center gap-0.5 text-brand-600 hover:underline" @click="openGrant(p)"><UserPlus class="h-3.5 w-3.5" />指定</button>
                  </template>
                  <span v-else class="text-slate-300">—</span>
                </td>
                <td class="px-2 text-right">
                  <UButton v-if="!p.fixed && !p.grantOnly" size="sm" variant="ghost" :icon="Pencil" @click="openEdit(p)">調整</UButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UQueryState>
    </section>

    <section>
      <h3 class="mb-1 text-sm font-semibold text-slate-700">頁面存取</h3>
      <p class="mb-2 text-xs text-slate-500">由路由設定自動產生（固定）。看得到頁面不代表能做每個操作，操作看上表。</p>
      <div class="overflow-x-auto rounded-md border border-slate-200">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th class="px-3 py-2 text-left font-medium">分組</th>
              <th class="px-3 py-2 text-left font-medium">頁面</th>
              <th v-for="r in roles" :key="r" class="px-3 py-2 text-center font-medium">{{ roleLabel[r] }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="p in pages" :key="p.title">
              <td class="px-3 py-1.5 text-xs text-slate-500">{{ p.group }}</td>
              <td class="px-3 py-1.5 text-slate-800">{{ p.title }}</td>
              <td v-for="r in roles" :key="r" class="px-3 text-center">
                <Check v-if="allowedPage(p, r)" class="mx-auto h-4 w-4 text-emerald-600" :aria-label="`${roleLabel[r]}可進入`" />
                <Minus v-else class="mx-auto h-4 w-4 text-slate-300" :aria-label="`${roleLabel[r]}不可進入`" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="rounded-md bg-slate-50 p-4 text-sm text-slate-700">
      <h3 class="mb-2 font-semibold">為什麼只能「在規則內調整」，不能任意勾選？</h3>
      <ul class="list-disc space-y-1 pl-5">
        <li><b>權限和業務規則綁在一起。</b>「醫師才能開醫囑」牽涉醫囑要記在哪位醫師名下、誰負法律責任。若能把開醫囑勾給櫃台，系統會出現沒有醫師的醫囑——所以這類權限固定。</li>
        <li><b>可調整的範圍寫在程式裡。</b>每項權限的「法規允許的角色」是程式碼（有版本紀錄、有審查、有測試）；在畫面上能調的，只是範圍內的選擇。</li>
        <li><b>每次調整都留紀錄。</b>要寫原因、寫稽核；會讓人失去權限的先列出受影響的帳號再確認。</li>
      </ul>
      <p class="mt-2 rounded bg-sky-50 px-2 py-1 text-xs text-sky-900">
        系統管理員可進入所有頁面檢視，但<b>不能執行臨床操作</b>（開醫囑、給藥、發藥、收費…）：這些權限的法規範圍裡沒有管理員，怎麼調都不會出現。
      </p>
    </section>

    <UDialog v-model="editOpen" :title="`調整：${editing?.label ?? ''}`" size="sm" @submit="onSave">
      <div v-if="editing" class="space-y-3 text-sm">
        <p class="text-xs text-slate-500">{{ editing.covers }}</p>
        <div class="space-y-1">
          <div class="text-xs font-medium text-slate-600">開放給（法規允許：{{ editing.candidates.map((r) => roleLabel[r]).join('、') }}）</div>
          <UCheckbox v-for="r in editing.candidates" :key="r" :model-value="form.roles.includes(r)" :label="roleLabel[r]" @update:model-value="(v: boolean) => toggle(r, v)" />
          <p v-if="save.fieldErrors.value.roles" class="text-xs text-red-600">{{ save.fieldErrors.value.roles }}</p>
          <p class="text-xs text-slate-400">預設：{{ editing.defaults.map((r) => roleLabel[r]).join('、') }}</p>
        </div>
        <UInput v-model="form.reason" label="調整原因" required placeholder="例：掛號集中在櫃台" :error="save.fieldErrors.value.reason" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="editing = null">取消</UButton>
        <UButton type="submit" :loading="save.pending.value">儲存</UButton>
      </template>
    </UDialog>

    <ReasonDialog
      v-model="revokeOpen"
      :title="`收回「${revoking?.row.label ?? ''}」`"
      :subject="revoking ? `${revoking.user.name}（${revoking.user.username}）` : ''"
      label="收回原因"
      :presets="['職務調整', '代理結束']"
      ok-text="收回"
      danger
      :pending="grant.pending.value"
      :error="grant.fieldErrors.value.reason"
      @confirm="confirmRevoke"
    />
    <UDialog v-model="grantOpen" :title="`指定個人：${granting?.label ?? ''}`" size="sm" @submit="onGrant">
      <div v-if="granting" class="space-y-3 text-sm">
        <p class="text-xs text-slate-500">只能指定給有「{{ granting.candidates.map((r) => roleLabel[r]).join('、') }}」角色的帳號；用其他角色登入時不適用。</p>
        <USelect v-model="gForm.userId" label="帳號" required placeholder="請選擇" :options="grantCandidates" />
        <UInput v-model="gForm.reason" label="原因" required placeholder="例：升任藥劑部主管" :error="grant.fieldErrors.value.reason" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="granting = null">取消</UButton>
        <UButton type="submit" :disabled="!gForm.userId" :loading="grant.pending.value">指定</UButton>
      </template>
    </UDialog>
  </div>
</template>
