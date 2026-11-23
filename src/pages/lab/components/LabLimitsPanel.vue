<script setup lang="ts">
// 檢驗時限設定：依檢驗醫令的急件、一般時效、危急值通報時限、不計時效；空白＝預設。
// 有「檢驗時限設定」權限的人能改（要寫原因、留紀錄），其他人只能看。服務層 lab-limits.ts
import { reactive, ref } from 'vue'
import { History, Pencil } from 'lucide-vue-next'
import { UButton, UCard, UCheckbox, UDialog, UInput, UQueryState } from '@/components/ui'
import { labLimitApi, LAB_LIMIT_RANGE, type LabLimitRow } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => labLimitApi.labLimitList())
const editing = ref<LabLimitRow>()
const form = reactive({ stat: '', routine: '', callout: '', noTat: false, reason: '' })
function edit(r: LabLimitRow) {
  editing.value = r
  Object.assign(form, { stat: r.limits.stat ?? '', routine: r.limits.routine ?? '', callout: r.limits.callout ?? '', noTat: !!r.limits.noTat, reason: '' })
  save.fieldErrors.value = {}
}
const save = useAction(labLimitApi.setLabLimits, { success: (r) => `已更新：${r.name}` })
// 數字欄清空時會是 '' 或 undefined（UInput type=number）：都當「空白＝預設」，不能變成 NaN
const n = (v: string | number | null | undefined) => (v === '' || v === null || v === undefined ? null : Number(v))
async function submit() {
  if (editing.value && (await save.run(editing.value.procId, { stat: n(form.stat), routine: n(form.routine), callout: n(form.callout), noTat: form.noTat, reason: form.reason }))) editing.value = undefined
}
const open = reactive<Record<string, boolean>>({})
</script>

<template>
  <UQueryState :loading="loading && !data" :ready="!!data">
    <UCard v-if="data" :padded="false">
      <template #title><span class="text-sm font-semibold">檢驗時限（分鐘）</span></template>
      <p class="px-4 pt-2 text-xs text-slate-500">空白＝預設：急件 {{ data.defaults.stat }}、一般 {{ data.defaults.routine }}、危急值通報 {{ data.defaults.callout }}。急件＝住院臨時檢驗、急診；一般＝門診、長期檢驗。{{ data.canEdit ? '' : '要改請找有「檢驗時限設定」權限的人（預設管理員）。' }}</p>
      <div class="overflow-x-auto p-3">
        <table class="w-full min-w-[40rem] text-sm">
          <thead class="text-left text-xs text-slate-500"><tr><th class="py-1">檢驗</th><th>急件</th><th>一般</th><th>危急值通報</th><th>時效</th><th></th></tr></thead>
          <tbody>
            <template v-for="r in data.rows" :key="r.procId">
              <tr class="border-t border-slate-100">
                <td class="py-1.5 pr-2">{{ r.name }} <span class="text-xs text-slate-400">{{ r.code }}</span></td>
                <td :class="['tabular', r.limits.stat !== undefined && 'font-semibold text-indigo-800']">{{ r.effective.stat }}</td>
                <td :class="['tabular', r.limits.routine !== undefined && 'font-semibold text-indigo-800']">{{ r.effective.routine }}</td>
                <td :class="['tabular', r.limits.callout !== undefined && 'font-semibold text-indigo-800']">{{ r.effective.callout }}</td>
                <td class="text-xs">{{ r.effective.noTat ? '不計' : '' }}</td>
                <td class="whitespace-nowrap text-right">
                  <UButton v-if="r.history.length" size="sm" variant="ghost" :icon="History" @click="open[r.procId] = !open[r.procId]">{{ r.history.length }}</UButton>
                  <UButton v-if="data.canEdit" size="sm" variant="secondary" :icon="Pencil" @click="edit(r)">改</UButton>
                </td>
              </tr>
              <tr v-if="open[r.procId]"><td colspan="6" class="pb-2 text-xs text-slate-600">
                <div v-for="(h, i) in r.history" :key="i">{{ h.at.slice(5) }} {{ h.byName }}：{{ h.text }}（{{ h.reason }}）</div>
              </td></tr>
            </template>
          </tbody>
        </table>
        <p class="mt-2 text-xs text-slate-500">粗體＝主檔另設；其他是預設。</p>
      </div>
    </UCard>
  </UQueryState>
  <UDialog :model-value="!!editing" :title="`檢驗時限：${editing?.name ?? ''}`" size="md" @update:model-value="(x: boolean) => !x && (editing = undefined)">
    <div class="space-y-3 text-sm">
      <div class="grid grid-cols-3 gap-3">
        <UInput v-model="form.stat" type="number" label="急件（分）" :placeholder="`預設 ${data?.defaults.stat}`" :error="save.fieldErrors.value.stat" />
        <UInput v-model="form.routine" type="number" label="一般（分）" :placeholder="`預設 ${data?.defaults.routine}`" :error="save.fieldErrors.value.routine" />
        <UInput v-model="form.callout" type="number" label="危急值通報（分）" :placeholder="`預設 ${data?.defaults.callout}`" :error="save.fieldErrors.value.callout" />
      </div>
      <UCheckbox v-model="form.noTat" label="不計時效（例：細菌培養要好幾天）" />
      <UInput v-model="form.reason" label="修改原因" placeholder="例：檢驗科品質會議決議" :error="save.fieldErrors.value.reason" />
      <p class="text-xs text-slate-500">空白＝預設；範圍 {{ LAB_LIMIT_RANGE.min }}–{{ LAB_LIMIT_RANGE.max }} 分鐘。改了之後，還沒發的檢驗與還沒通報的危急值馬上照新的時限判斷。</p>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="editing = undefined">取消</UButton>
      <UButton :loading="save.pending.value" @click="submit">儲存</UButton>
    </template>
  </UDialog>
</template>
