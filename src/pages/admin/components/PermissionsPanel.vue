<script setup lang="ts">
// 權限對照表：直接從路由表（routes.ts 的 meta.roles）產生，不另外手寫一份。
// 手寫的說明文件遲早會和程式不一致；從程式產生的表，永遠就是系統實際的行為。
//
// 權限要放在程式碼還是資料庫？這個系統選擇放在程式碼，原因寫在下方說明區。
import { computed } from 'vue'
import { Check, Minus } from 'lucide-vue-next'
import { routes } from '@/router/routes'
import { roleLabel } from '@/utils/labels'
import type { Role } from '@/types'

const roles = Object.keys(roleLabel) as Role[]
const pages = computed(() =>
  (routes.find((r) => r.children)?.children ?? [])
    .filter((r) => r.meta?.group)
    .map((r) => ({ title: r.meta!.title!, group: r.meta!.group!, roles: r.meta!.roles })),
)
const allowed = (p: { roles?: Role[] }, role: Role) => role === 'admin' || !p.roles?.length || p.roles.includes(role)

// 動作層級的權限（服務層 requireUser 的設定），挑主要的列出，對照用
const actions: { group: string; label: string; roles: Role[] }[] = [
  // 這份清單第一版就有兩處和服務層不符（預約住院、出院），比對 requireUser 後才修正——手寫文件會飄移的活例子
  { group: '門診', label: '建立／修改病人資料', roles: ['clerk', 'doctor', 'nurse'] },
  { group: '門診', label: '掛號、退掛', roles: ['clerk', 'nurse'] },
  { group: '門診', label: '寫病歷、開處方、完成看診', roles: ['doctor'] },
  { group: '門診', label: '批價收費、作廢收據', roles: ['clerk'] },
  { group: '門診', label: '核對處方、發藥', roles: ['pharmacist'] },
  { group: '住院', label: '預約住院、辦理出院', roles: ['clerk', 'doctor', 'nurse'] },
  { group: '住院', label: '報到、轉床、取消預約、病床狀態', roles: ['clerk', 'nurse'] },
  { group: '住院', label: '開立／停止醫囑、病程紀錄', roles: ['doctor'] },
  { group: '住院', label: '給藥、生命徵象、護理紀錄、交班', roles: ['nurse'] },
  { group: '其他', label: '預防保健登錄、補登報告', roles: ['doctor', 'nurse'] },
  { group: '其他', label: '進貨、盤點、報廢', roles: ['pharmacist'] },
  { group: '系統', label: '帳號、科別、醫師、稽核、匯出入', roles: ['admin'] },
]
</script>

<template>
  <div class="space-y-6">
    <section>
      <h3 class="mb-1 text-sm font-semibold text-slate-700">頁面存取</h3>
      <p class="mb-2 text-xs text-slate-500">由路由設定自動產生，與系統實際行為一致。</p>
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
                <Check v-if="allowed(p, r)" class="mx-auto h-4 w-4 text-emerald-600" :aria-label="`${roleLabel[r]}可進入`" />
                <Minus v-else class="mx-auto h-4 w-4 text-slate-300" :aria-label="`${roleLabel[r]}不可進入`" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h3 class="mb-1 text-sm font-semibold text-slate-700">主要操作權限（服務層把關）</h3>
      <p class="mb-2 text-xs text-slate-500">看得到頁面不代表能做每個操作——真正的權限在服務層，每個寫入動作都會再檢查一次角色。此表為人工整理的摘要，以服務層程式為準。</p>
      <ul class="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
        <li v-for="a in actions" :key="a.label" class="flex items-center gap-3 px-3 py-1.5">
          <span class="w-10 text-xs text-slate-500">{{ a.group }}</span>
          <span class="flex-1 text-slate-800">{{ a.label }}</span>
          <span class="text-xs text-slate-600">{{ a.roles.map((r) => roleLabel[r]).join('、') }}</span>
        </li>
      </ul>
    </section>

    <section class="rounded-md bg-slate-50 p-4 text-sm text-slate-700">
      <h3 class="mb-2 font-semibold">為什麼權限寫在程式碼，而不是在這裡勾選？</h3>
      <ul class="list-disc space-y-1 pl-5">
        <li><b>權限和業務規則綁在一起。</b>「醫師才能開醫囑」不只是能不能按按鈕，還牽涉醫囑要記在哪位醫師名下、誰負法律責任。若讓管理員把開醫囑勾給櫃台，系統會出現沒有醫師的醫囑。</li>
        <li><b>改權限要經過審查。</b>寫在程式碼裡，每次調整都有版本紀錄、有人審查、有測試保護；在畫面上勾一下，就少了這些關卡。</li>
        <li><b>什麼時候該放進資料庫？</b>當角色多、組合多、且各院設定不同（例如「實習醫師只能看不能開」「某病房護理長可以排班」）時，才值得做成可設定。屆時仍應只開放「在既有規則內調整」，而不是任意勾選。</li>
      </ul>
      <p class="mt-2 rounded bg-sky-50 px-2 py-1 text-xs text-sky-900">
        系統管理員可進入所有頁面檢視，但<b>不能執行臨床操作</b>（掛號、開醫囑、給藥、發藥、收費…）：服務層的角色檢查不對管理員放行，
        醫療紀錄只會記在具該角色的人名下。管理員能做的事，在服務層明確寫出 admin 才算數。
      </p>
    </section>
  </div>
</template>
