<script setup lang="ts">
// 病患資料表單（建檔與修改共用）。
// 兩種錯誤來源合併顯示：
//   1. 本地格式檢查：輸入當下就提示（和服務層呼叫同一個 validators.ts）
//   2. 服務層回傳的欄位錯誤：例如「身分證已建檔」，只有服務層查得出來
import { computed } from 'vue'
import { UCheckbox, UInput, USelect, UTextarea } from '@/components/ui'
import { masterApi } from '@/services'
import type { PatientInput } from '@/services/patient'
import { useQuery } from '@/composables/useService'
import { isValidIdNo, isValidPhone } from '@/utils/validators'
import { today } from '@/utils/date'

const form = defineModel<PatientInput>({ required: true })
const props = defineProps<{
  /** 服務層回傳的欄位錯誤 */
  serverErrors?: Record<string, string>
  /** 按過送出後才顯示「必填」類錯誤，避免一打開就滿畫面紅字 */
  submitted?: boolean
}>()

const { data: identities } = useQuery(() => masterApi.listIdentities())
const identityOptions = computed(() => (identities.value ?? []).map((i) => ({ label: `${i.code} ${i.name}`, value: i.code })))
const { familyHistoryOptions, allergyOptions } = masterApi.staticCodes

/** 本地檢查：格式錯誤一有內容就提示；必填要等送出後 */
const localErrors = computed(() => {
  const f = form.value
  const e: Record<string, string> = {}
  if (props.submitted && !f.name.trim()) e.name = '姓名為必填'
  if (f.idNo ? !isValidIdNo(f.idNo) : props.submitted) e.idNo = f.idNo ? '格式或檢查碼錯誤（例：A123456789）' : '身分證字號為必填'
  if (props.submitted && !f.birthDate) e.birthDate = '出生日期為必填'
  if (f.birthDate && f.birthDate > today()) e.birthDate = '不可晚於今天'
  if (f.phone && !isValidPhone(f.phone)) e.phone = '格式錯誤（例：0912-345-678）'
  if (f.emergencyPhone && !isValidPhone(f.emergencyPhone)) e.emergencyPhone = '格式錯誤'
  return e
})

/** 本地錯誤優先（使用者正在改的就是它）；沒有本地錯誤才顯示服務層的 */
const err = (k: string) => localErrors.value[k] ?? props.serverErrors?.[k] ?? ''

/** 外部可呼叫：送出前確認本地沒有錯誤 */
defineExpose({ isValid: () => Object.keys(localErrors.value).length === 0 })

function toggle(list: string[], v: string, on: boolean) {
  const i = list.indexOf(v)
  if (on && i < 0) list.push(v)
  if (!on && i >= 0) list.splice(i, 1)
}
</script>

<template>
  <div class="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
    <UInput v-model="form.name" label="姓名" required :error="err('name')" />
    <UInput v-model="form.idNo" label="身分證字號" required :error="err('idNo')" class="uppercase" maxlength="10" @blur="form.idNo = form.idNo.toUpperCase()" />
    <USelect v-model="form.gender" label="性別" :options="[{ label: '男', value: 'M' }, { label: '女', value: 'F' }]" />
    <UInput v-model="form.birthDate" label="出生日期" type="date" required :max="today()" :error="err('birthDate')" />

    <UInput v-model="form.phone" label="電話" :error="err('phone')" placeholder="0912-345-678" />
    <USelect v-model="form.defaultIdentity" label="預設就醫身分" :options="identityOptions" :error="err('defaultIdentity')" />
    <USelect v-model="form.bloodType" label="血型" :options="['A', 'B', 'O', 'AB']" placeholder="未知" />
    <div class="flex items-end gap-4 pb-2">
      <UCheckbox v-model="form.smoking" label="吸菸" />
      <UCheckbox v-model="form.betelNut" label="嚼檳榔" />
    </div>

    <div class="col-span-2 md:col-span-4"><UInput v-model="form.address" label="地址" /></div>
    <UInput v-model="form.emergencyContact" label="緊急聯絡人" />
    <UInput v-model="form.emergencyPhone" label="緊急聯絡電話" :error="err('emergencyPhone')" />

    <div class="col-span-2 md:col-span-4">
      <div class="mb-1 text-xs font-medium text-slate-600">藥物過敏</div>
      <div class="flex flex-wrap gap-x-4 gap-y-1 rounded-md border border-slate-200 px-3 py-2" :class="form.allergies.length ? 'border-red-200 bg-red-50/40' : ''">
        <UCheckbox v-for="a in allergyOptions" :key="a" :model-value="form.allergies.includes(a)" :label="a" @update:model-value="(v) => toggle(form.allergies, a, v)" />
      </div>
    </div>
    <div class="col-span-2 md:col-span-4">
      <div class="mb-1 text-xs font-medium text-slate-600">家族病史（預防保健資格會參考）</div>
      <div class="flex flex-wrap gap-x-4 gap-y-1 rounded-md border border-slate-200 px-3 py-2">
        <UCheckbox v-for="f in familyHistoryOptions" :key="f" :model-value="form.familyHistory.includes(f)" :label="f" @update:model-value="(v) => toggle(form.familyHistory, f, v)" />
      </div>
    </div>
    <div class="col-span-2 md:col-span-4"><UTextarea v-model="form.note" label="備註" :rows="2" /></div>
  </div>
</template>
