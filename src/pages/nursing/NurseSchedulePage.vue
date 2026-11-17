<script setup lang="ts">
// 護理排班：選病房、月份 → 每天三班排了誰、護病比（今天以後依目前住院人數估，超過上限標紅、不擋）。
// 有「護理排班」權限的人（護理長）點格子改人、「複製上個月」（照 4 週前同一個星期幾，已排的不動）；管理員調護病比上限
import { computed, reactive, ref } from 'vue'
import { Copy } from 'lucide-vue-next'
import { UButton, UCheckbox, UDialog, UInput, UPageHeader, UQueryState, USelect } from '@/components/ui'
import { masterApi, SHIFTS, staffingApi, type ScheduleCell, type ShiftName } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import ShiftRequestsPanel from './components/ShiftRequestsPanel.vue'
import { useUi } from '@/stores/ui'
import { today } from '@/utils/date'

const ui = useUi()
const wards = masterApi.staticCodes.wards
const q = reactive({ ward: wards[0], month: today().slice(0, 7) })
const months = (() => {
  const m = today().slice(0, 7)
  const shift = (k: number) => {
    const [y, mo] = m.split('-').map(Number)
    const d = new Date(y, mo - 1 + k, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }
  return [shift(-1), m, shift(1)]
})()
const { data, loading, reload } = useQuery(() => staffingApi.getSchedule(q.ward, q.month), [() => q.ward, () => q.month])
const weekday = (d: string) => '日一二三四五六'[new Date(d).getDay()]

// ---------- 改一班 ----------
const editing = ref<{ date: string; shift: ShiftName }>()
const editOpen = computed({ get: () => !!editing.value, set: (x) => !x && (editing.value = undefined) })
const picked = ref<string[]>([])
function openCell(date: string, c: ScheduleCell) {
  if (!data.value?.canEdit || date < today()) return
  picked.value = c.nurses.map((n) => n.id)
  setAct.fieldErrors.value = {}
  editing.value = { date, shift: c.shift }
}
const setAct = useAction(staffingApi.setShiftNurses, { success: (c) => `已排 ${c.shift}：${c.nurses.map((n) => n.name).join('、') || '（不排）'}` })
async function submitCell() {
  if (editing.value && (await setAct.run(q.ward, editing.value.date, editing.value.shift, picked.value))) {
    editing.value = undefined
    reload()
  }
}
const copyAct = useAction(staffingApi.copyPreviousMonth)
async function copyPrev() {
  if (!(await ui.confirm({ title: '複製上個月', message: `${q.ward} ${q.month}：今天以後還沒排的班，照 4 週前同一個星期幾排（已排的不動）？`, okText: '複製' }))) return
  const r = await copyAct.run(q.ward, q.month)
  if (r) {
    ui.toast.success(`已複製 ${r.copied} 人次`)
    reload()
  }
}
// ---------- 護病比上限（管理員） ----------
const ratioOpen = ref(false)
const ratio = reactive<Record<ShiftName, number | undefined>>({ 白班: 7, 小夜: 11, 大夜: 15 })
function openRatio() {
  Object.assign(ratio, data.value?.ratio ?? {})
  ratioAct.fieldErrors.value = {}
  ratioOpen.value = true
}
const ratioAct = useAction(staffingApi.saveRatio, { success: '已更新護病比上限' })
async function submitRatio() {
  if (await ratioAct.run({ 白班: Number(ratio.白班), 小夜: Number(ratio.小夜), 大夜: Number(ratio.大夜) })) {
    ratioOpen.value = false
    reload()
  }
}
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="護理排班" description="各病房每天三班的護理師與護病比（超過上限標紅，不擋）">
      <UButton v-if="data?.canEditRatio" variant="secondary" @click="openRatio">護病比上限</UButton>
      <UButton v-if="data?.canEdit" variant="secondary" :icon="Copy" :loading="copyAct.pending.value" @click="copyPrev">複製上個月</UButton>
    </UPageHeader>
    <div class="flex flex-wrap items-end gap-3">
      <USelect v-model="q.ward" label="病房" :options="wards.map((w) => ({ label: w, value: w }))" class="w-44" />
      <USelect v-model="q.month" label="月份" :options="months.map((m) => ({ label: m, value: m }))" class="w-32" />
      <span v-if="data" class="text-xs text-slate-500">護病比上限：{{ SHIFTS.map((s) => `${s} 1:${data!.ratio[s]}`).join('・') }}<template v-if="!data.canEdit">（要改班表請找有「護理排班」權限的人）</template></span>
    </div>
    <ShiftRequestsPanel @changed="reload" />
    <UQueryState :loading="loading && !data" :ready="!!data">
      <div v-if="data" class="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table class="w-full min-w-[40rem] text-left text-sm">
          <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500">
            <tr><th class="px-3 py-1.5">日期</th><th v-for="s in SHIFTS" :key="s" class="px-3 py-1.5">{{ s }}</th></tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="d in data.days" :key="d.date" :class="d.date === data.current.date && 'bg-brand-50/60'">
              <td class="tabular whitespace-nowrap px-3 py-1.5 text-slate-600">{{ d.date.slice(5) }}（{{ weekday(d.date) }}）</td>
              <td v-for="c in d.cells" :key="c.shift" :class="['px-3 py-1.5 align-top', data.canEdit && d.date >= today() && 'cursor-pointer hover:bg-slate-50', d.date === data.current.date && c.shift === data.current.shift && 'ring-2 ring-inset ring-brand-400']" @click="openCell(d.date, c)">
                <div :class="c.nurses.length ? 'text-slate-800' : 'text-slate-400'">{{ c.nurses.map((n) => n.name).join('、') || '未排' }}</div>
                <div v-if="c.ratio" :class="['text-xs', c.ratio.over ? 'font-semibold text-red-700' : 'text-slate-400']">{{ c.ratio.text }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UQueryState>

    <UDialog v-model="editOpen" :title="`${q.ward} ${editing?.date ?? ''} ${editing?.shift ?? ''}`" size="sm" @submit="submitCell">
      <div class="grid grid-cols-2 gap-2 text-sm">
        <UCheckbox v-for="n in data?.nurses ?? []" :key="n.id" :model-value="picked.includes(n.id)" :label="n.name" @update:model-value="(on: boolean) => (picked = on ? [...picked, n.id] : picked.filter((x) => x !== n.id))" />
      </div>
      <p v-if="setAct.fieldErrors.value.nurseIds" class="mt-2 text-xs text-red-600">{{ setAct.fieldErrors.value.nurseIds }}</p>
      <template #footer>
        <UButton variant="secondary" @click="editOpen = false">取消</UButton>
        <UButton type="submit" :loading="setAct.pending.value">儲存</UButton>
      </template>
    </UDialog>

    <UDialog v-model="ratioOpen" title="護病比上限（一位護理師最多照顧幾位病人）" size="sm" @submit="submitRatio">
      <div class="grid grid-cols-3 gap-2">
        <UInput v-for="s in SHIFTS" :key="s" v-model="ratio[s]" type="number" :label="s" :error="ratioAct.fieldErrors.value[s]" />
      </div>
      <p class="mt-2 text-xs text-slate-500">區域醫院標準：白班 7、小夜 11、大夜 15；醫學中心更嚴（6、9、11）。</p>
      <template #footer>
        <UButton variant="secondary" @click="ratioOpen = false">取消</UButton>
        <UButton type="submit" :loading="ratioAct.pending.value">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
