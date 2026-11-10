<script setup lang="ts">
// 科別與醫師。兩者都只能「停用」不能刪除：過去的掛號、病歷都指向它們，刪了歷史資料就斷線。
// 醫師清單直接顯示「停用前要處理的事」（未看診掛號、住院病人、排班、帳號），
// 管理員不用按下去才發現不能停——服務層仍會再檢查一次。
import { computed, reactive, ref } from 'vue'
import { Pencil, Plus } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, USelect, UTable, type Column } from '@/components/ui'
import { adminApi, type DepartmentRow, type DoctorRow } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data: depts } = useQuery(() => adminApi.listDepartments())
const { data: doctors, loading } = useQuery(() => adminApi.listDoctors())
const deptFilter = ref<string>()
const shownDoctors = computed(() => (doctors.value ?? []).filter((d) => !deptFilter.value || d.deptId === deptFilter.value))

// ---------- 科別 ----------
const deptOpen = ref(false)
const deptForm = reactive({ id: undefined as string | undefined, code: '', name: '', active: true })
function openDept(d?: DepartmentRow) {
  Object.assign(deptForm, d ? { id: d.id, code: d.code, name: d.name, active: d.active } : { id: undefined, code: '', name: '', active: true })
  saveDept.fieldErrors.value = {}
  deptOpen.value = true
}
const saveDept = useAction(adminApi.saveDepartment, { success: (d) => `已儲存科別 ${d.name}` })
async function submitDept() {
  if (await saveDept.run({ ...deptForm })) deptOpen.value = false
}

// ---------- 醫師 ----------
const docOpen = ref(false)
const docForm = reactive({ id: undefined as string | undefined, name: '', deptId: undefined as string | number | undefined, title: '主治醫師', licenseNo: '', active: true })
const editingDoc = computed(() => doctors.value?.find((d) => d.id === docForm.id))
function openDoc(d?: DoctorRow) {
  Object.assign(
    docForm,
    d ? { id: d.id, name: d.name, deptId: d.deptId, title: d.title, licenseNo: d.licenseNo, active: d.active } : { id: undefined, name: '', deptId: deptFilter.value, title: '主治醫師', licenseNo: '', active: true },
  )
  saveDoc.fieldErrors.value = {}
  docOpen.value = true
}
const saveDoc = useAction(adminApi.saveDoctor, { success: (d) => `已儲存醫師 ${d.name}` })
async function submitDoc() {
  if (await saveDoc.run({ ...docForm, deptId: String(docForm.deptId ?? '') })) docOpen.value = false
}

/** 停用前要處理的事（畫面提示用；服務層會再檢查） */
function blockers(d: DoctorRow) {
  const im = d.impact
  return [
    im.futureVisits && `未看診掛號 ${im.futureVisits}`,
    im.admittedPatients && `住院病人 ${im.admittedPatients}`,
    im.weeklySlots && `排班 ${im.weeklySlots} 診`,
    im.activeAccount && `帳號 ${im.activeAccount}`,
  ].filter(Boolean) as string[]
}

const columns: Column<DoctorRow>[] = [
  { key: 'name', label: '醫師', width: '9rem' },
  { key: 'licenseNo', label: '醫事人員代碼', width: '7rem' },
  { key: 'impact', label: '停用前需處理' },
  { key: 'active', label: '狀態', width: '5rem' },
  { key: 'act', label: '', width: '5rem', align: 'right' },
]
</script>

<template>
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-[16rem_1fr]">
    <!-- 科別 -->
    <section class="self-start rounded-md border border-slate-200">
      <header class="flex items-center border-b border-slate-100 px-3 py-2">
        <h3 class="text-sm font-semibold text-slate-700">科別</h3>
        <UButton class="ml-auto" size="sm" variant="ghost" :icon="Plus" @click="openDept()">新增</UButton>
      </header>
      <ul class="divide-y divide-slate-100 text-sm">
        <li>
          <button :class="['w-full px-3 py-2 text-left hover:bg-slate-50', !deptFilter && 'bg-brand-50 font-medium']" @click="deptFilter = undefined">全部科別</button>
        </li>
        <li v-for="d in depts" :key="d.id" :class="['group flex items-center', deptFilter === d.id && 'bg-brand-50']">
          <button class="flex flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-slate-50" @click="deptFilter = d.id">
            <span class="tabular w-10 text-xs text-slate-500">{{ d.code }}</span>
            <span :class="d.active ? 'text-slate-800' : 'text-slate-400 line-through'">{{ d.name }}</span>
            <span class="ml-auto text-xs text-slate-500">{{ d.activeDoctors }} 位</span>
          </button>
          <button class="px-2 text-slate-400 hover:text-brand-600" :aria-label="`編輯${d.name}`" @click="openDept(d)"><Pencil class="h-3.5 w-3.5" /></button>
        </li>
      </ul>
    </section>

    <!-- 醫師 -->
    <section class="min-w-0 space-y-2">
      <div class="flex items-center">
        <h3 class="text-sm font-semibold text-slate-700">醫師（{{ shownDoctors.length }}）</h3>
        <UButton class="ml-auto" size="sm" :icon="Plus" @click="openDoc()">新增醫師</UButton>
      </div>
      <UTable :columns="columns" :rows="shownDoctors" :row-key="(d) => d.id" :loading="loading && !doctors" dense :row-class="(d) => (d.active ? '' : 'text-slate-400')">
        <template #cell-impact="{ row }">
          <span v-if="!row.active" class="text-xs">—</span>
          <span v-else-if="!blockers(row).length" class="text-xs text-emerald-700">無，可直接停用</span>
          <span v-else class="text-xs text-slate-600">{{ blockers(row).join('・') }}</span>
        </template>
        <template #cell-active="{ row }"><UBadge :tone="row.active ? 'green' : 'gray'">{{ row.active ? '在職' : '停用' }}</UBadge></template>
        <template #cell-name="{ row }">
          <div class="whitespace-nowrap font-medium">{{ row.name }}</div>
          <div class="whitespace-nowrap text-xs text-slate-500">{{ row.id }}・{{ row.deptName }}</div>
        </template>
        <template #cell-act="{ row }"><UButton size="sm" variant="ghost" :icon="Pencil" class="whitespace-nowrap" @click="openDoc(row)">編輯</UButton></template>
      </UTable>
    </section>

    <UDialog v-model="deptOpen" :title="deptForm.id ? `編輯科別：${deptForm.name}` : '新增科別'" size="sm">
      <div class="space-y-3">
        <UInput v-model="deptForm.code" label="科別代碼" required hint="2–4 個英數字，例：RHE" :error="saveDept.fieldErrors.value.code" />
        <UInput v-model="deptForm.name" label="科別名稱" required :error="saveDept.fieldErrors.value.name" />
        <UCheckbox v-model="deptForm.active" label="啟用" />
        <p v-if="saveDept.fieldErrors.value.active" class="text-xs text-red-600">{{ saveDept.fieldErrors.value.active }}</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="deptOpen = false">取消</UButton>
        <UButton :loading="saveDept.pending.value" @click="submitDept">儲存</UButton>
      </template>
    </UDialog>

    <UDialog v-model="docOpen" :title="docForm.id ? `編輯醫師：${docForm.name}` : '新增醫師'">
      <div class="grid grid-cols-2 gap-3">
        <UInput v-model="docForm.name" label="姓名" required :error="saveDoc.fieldErrors.value.name" />
        <USelect v-model="docForm.deptId" label="科別" required placeholder="請選擇" :options="(depts ?? []).filter((d) => d.active || d.id === docForm.deptId).map((d) => ({ label: d.name, value: d.id }))" :error="saveDoc.fieldErrors.value.deptId" />
        <UInput v-model="docForm.title" label="職稱" />
        <UInput v-model="docForm.licenseNo" label="醫事人員代碼" required :error="saveDoc.fieldErrors.value.licenseNo" />
        <div class="col-span-2">
          <UCheckbox v-model="docForm.active" label="在職" />
          <p v-if="saveDoc.fieldErrors.value.active" class="mt-1 text-xs text-red-600">{{ saveDoc.fieldErrors.value.active }}</p>
          <p v-else-if="editingDoc?.active && !docForm.active && blockers(editingDoc).length" class="mt-1 text-xs text-amber-700">
            停用前需先處理：{{ blockers(editingDoc).join('、') }}
          </p>
        </div>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="docOpen = false">取消</UButton>
        <UButton :loading="saveDoc.pending.value" @click="submitDoc">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
