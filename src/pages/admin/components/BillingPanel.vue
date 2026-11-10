<script setup lang="ts">
// 收費設定：部分負擔參數＋各就醫身分的掛號費。
// 右側試算表用的是批價同一個純函式 drugCopay——畫面上看到的，就是批價時會算出來的。
// 已收費的收據存的是當時的明細，不受影響；只有「尚未收費」的會用新參數計算。
import { computed, reactive, ref, watch } from 'vue'
import { Pencil } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput } from '@/components/ui'
import { adminApi, drugCopay, masterApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import type { BillingSettings, Identity } from '@/types'

const { data: settings } = useQuery(() => adminApi.getBillingSettings())
const { data: identities } = useQuery(() => masterApi.listIdentities())

// ---------- 部分負擔參數 ----------
const form = reactive<BillingSettings>({ basicCopay: 0, drugCopayFreeUpTo: 0, drugCopayStep: 1, drugCopayPerStep: 0, drugCopayMax: 0 })
// 只在第一次載入時帶入；之後重新查詢不覆蓋使用者正在改的內容
let loaded = false
watch(settings, (s) => {
  if (s && !loaded) {
    Object.assign(form, s)
    loaded = true
  }
})
const dirty = computed(() => !!settings.value && (['basicCopay', 'drugCopayFreeUpTo', 'drugCopayStep', 'drugCopayPerStep', 'drugCopayMax'] as const).some((k) => form[k] !== settings.value![k]))
const fields: { key: keyof BillingSettings; label: string; hint: string }[] = [
  { key: 'basicCopay', label: '門診基本部分負擔', hint: '元／次' },
  { key: 'drugCopayFreeUpTo', label: '藥品部分負擔免收額度', hint: '健保藥費在此金額以下免收' },
  { key: 'drugCopayStep', label: '每一級距', hint: '元' },
  { key: 'drugCopayPerStep', label: '每級加收', hint: '元' },
  { key: 'drugCopayMax', label: '藥品部分負擔上限', hint: '元' },
]

// 試算：草稿數字不合法時（例如級距 0）不試算，避免畫面出現 Infinity
const valid = computed(() => form.drugCopayStep >= 1 && fields.every((f) => Number.isFinite(form[f.key] as number)))
const samples = [80, 100, 150, 250, 450, 800, 1500]

const save = useAction(adminApi.saveBillingSettings, { success: (r) => `已儲存收費設定${r.affectedPending ? `；目前 ${r.affectedPending} 筆待批價將以新設定計算` : ''}` })
async function submit() {
  const r = await save.run({ ...form })
  if (r) Object.assign(form, r.settings)
}
function revert() {
  if (settings.value) Object.assign(form, settings.value)
}

// ---------- 就醫身分 ----------
const idOpen = ref(false)
const idForm = reactive<Identity>({ code: '', name: '', regFee: 0, copayExempt: false, selfPay: false })
function openId(i: Identity) {
  Object.assign(idForm, i)
  saveId.fieldErrors.value = {}
  idOpen.value = true
}
const saveId = useAction(adminApi.saveIdentity, { success: (r) => `已儲存 ${r.identity.name}${r.affectedPending ? `；${r.affectedPending} 筆待批價將以新設定計算` : ''}` })
async function submitId() {
  if (await saveId.run({ ...idForm })) idOpen.value = false
}
</script>

<template>
  <div class="space-y-6">
    <section class="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_20rem]">
      <div>
        <h3 class="mb-2 text-sm font-semibold text-slate-700">部分負擔</h3>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UInput v-for="f in fields" :key="f.key" v-model="form[f.key] as number" :label="f.label" type="number" min="0" :hint="f.hint" :error="save.fieldErrors.value[f.key]" />
        </div>
        <p class="mt-2 text-xs text-slate-500">
          已收費的收據不受影響（收據保存當時的明細）；尚未收費的掛號會以新設定計算。
          <template v-if="settings?.updatedAt">上次修改：{{ settings.updatedAt }}</template>
        </p>
        <div class="mt-3 flex gap-2">
          <UButton :disabled="!dirty" :loading="save.pending.value" @click="submit">儲存</UButton>
          <UButton v-if="dirty" variant="secondary" @click="revert">還原</UButton>
        </div>
      </div>

      <div class="rounded-md border border-slate-200">
        <div class="border-b border-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">藥品部分負擔試算</div>
        <table v-if="valid && settings" class="w-full text-sm">
          <thead class="text-xs text-slate-500">
            <tr><th class="px-3 py-1 text-left font-medium">健保藥費</th><th class="px-3 text-right font-medium">目前</th><th class="px-3 text-right font-medium">修改後</th></tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="n in samples" :key="n">
              <td class="tabular px-3 py-1">{{ n }} 元</td>
              <td class="tabular px-3 text-right text-slate-500">{{ drugCopay(n, settings) }}</td>
              <td :class="['tabular px-3 text-right font-medium', drugCopay(n, form) !== drugCopay(n, settings) ? 'text-amber-700' : 'text-slate-800']">{{ drugCopay(n, form) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="px-3 py-4 text-xs text-slate-500">設定不完整，暫無法試算（級距至少 1 元）。</p>
      </div>
    </section>

    <section>
      <h3 class="mb-2 text-sm font-semibold text-slate-700">就醫身分與掛號費</h3>
      <ul class="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
        <li v-for="i in identities" :key="i.code" class="flex items-center gap-3 px-3 py-2">
          <span class="tabular w-8 text-xs text-slate-500">{{ i.code }}</span>
          <span class="w-36 font-medium text-slate-800">{{ i.name }}</span>
          <span class="tabular w-24">掛號費 {{ i.regFee }} 元</span>
          <UBadge v-if="i.selfPay" tone="purple">自費（不走健保）</UBadge>
          <UBadge v-else-if="i.copayExempt" tone="green">免部分負擔</UBadge>
          <UButton class="ml-auto" size="sm" variant="ghost" :icon="Pencil" @click="openId(i)">編輯</UButton>
        </li>
      </ul>
      <p class="mt-1 text-xs text-slate-500">身分代碼對應健保規定，只能調整，不能新增或更改代碼。</p>
    </section>

    <UDialog v-model="idOpen" :title="`編輯就醫身分：${idForm.code}`" size="sm">
      <div class="space-y-3">
        <UInput v-model="idForm.name" label="名稱" required :error="saveId.fieldErrors.value.name" />
        <UInput v-model="idForm.regFee" label="掛號費" type="number" min="0" hint="元" :error="saveId.fieldErrors.value.regFee" />
        <UCheckbox v-model="idForm.copayExempt" label="免部分負擔" />
        <UCheckbox v-model="idForm.selfPay" label="自費身分（不申報健保）" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="idOpen = false">取消</UButton>
        <UButton :loading="saveId.pending.value" @click="submitId">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
