<script setup lang="ts">
// 每週門診表：時段 × 星期 的格子，點格子新增、點醫師編輯。
// 改範本只影響「還沒有人掛號」的未來診次；已有掛號的保留原安排，儲存後會告訴你保留了幾個。
import { computed, reactive, ref } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'
import { UButton, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import { adminApi, scheduleApi, type WeeklySlotView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import type { Period } from '@/types'

const ui = useUi()
const deptId = ref<string | number | undefined>('')
const { data: depts } = useQuery(() => adminApi.listDepartments())
const { data: doctors } = useQuery(() => adminApi.listDoctors())
const { data: slots, loading } = useQuery(() => scheduleApi.listWeeklySlots({ deptId: String(deptId.value ?? '') || undefined }), [deptId])

// 星期一排最前面（門診表的習慣），週日放最後
const weekdays = [1, 2, 3, 4, 5, 6, 0]
const wdLabel = (wd: number) => `週${'日一二三四五六'[wd]}`
const periods: { key: Period; label: string }[] = [
  { key: 'AM', label: '上午' },
  { key: 'PM', label: '下午' },
  { key: 'NIGHT', label: '夜診' },
]
const cell = (wd: number, p: Period) => (slots.value ?? []).filter((s) => s.weekday === wd && s.period === p)

// ---------- 新增 / 編輯 ----------
const open = ref(false)
const form = reactive({ id: undefined as string | undefined, doctorId: undefined as string | number | undefined, weekday: 1 as string | number | undefined, period: 'AM' as string | number | undefined, roomNo: '', limit: 50 as number | undefined })
const doctorOptions = computed(() =>
  (doctors.value ?? []).filter((d) => d.active && (!deptId.value || d.deptId === deptId.value)).map((d) => ({ label: `${d.name}（${d.deptName}）`, value: d.id })),
)
function openSlot(s?: WeeklySlotView, wd?: number, p?: Period) {
  Object.assign(form, s ? { id: s.id, doctorId: s.doctorId, weekday: s.weekday, period: s.period, roomNo: s.roomNo, limit: s.limit } : { id: undefined, doctorId: undefined, weekday: wd ?? 1, period: p ?? 'AM', roomNo: '', limit: p === 'NIGHT' ? 30 : 50 })
  save.fieldErrors.value = {}
  open.value = true
}
const keptMsg = (n: number) => (n ? `；${n} 個已有掛號的未來診次維持原安排，如需更動請用「單日調整」` : '')
const save = useAction(scheduleApi.saveWeeklySlot, { success: (r) => `已儲存門診表${keptMsg(r.keptSessions)}` })
async function submit() {
  const ok = await save.run({ id: form.id, doctorId: String(form.doctorId ?? ''), weekday: Number(form.weekday), period: form.period as Period, roomNo: form.roomNo, limit: form.limit ?? 0 })
  if (ok) open.value = false
}
const del = useAction(scheduleApi.deleteWeeklySlot, { success: (r) => `已移除門診${keptMsg(r.keptSessions)}` })
async function remove() {
  if (!form.id) return
  const ok = await ui.confirm({ title: '移除每週門診', message: '之後不再自動產生這個診次。\n已有病人掛號的未來診次會保留，不受影響。', okText: '移除', danger: true })
  if (ok && (await del.run(form.id))) open.value = false
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-end gap-3">
      <USelect v-model="deptId" label="科別" :options="[{ label: '全部科別', value: '' }, ...(depts ?? []).filter((d) => d.active).map((d) => ({ label: d.name, value: d.id }))]" class="w-40" />
      <p class="pb-2 text-xs text-slate-500">點醫師可編輯，點格子右上角 ＋ 新增。</p>
    </div>
    <!-- 載入中不能顯示空白表格：管理員會以為「沒有排班」而重複新增 -->
    <UQueryState :loading="loading && !slots" :ready="!!slots">
    <div class="overflow-x-auto rounded-md border border-slate-200">
      <table class="w-full min-w-[56rem] table-fixed text-sm">
        <thead class="bg-slate-50 text-xs text-slate-500">
          <tr>
            <th class="w-16 px-2 py-2 text-left font-medium">時段</th>
            <th v-for="wd in weekdays" :key="wd" class="px-2 py-2 text-left font-medium">{{ wdLabel(wd) }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-for="p in periods" :key="p.key" class="align-top">
            <th class="px-2 py-2 text-left text-xs font-medium text-slate-600">{{ p.label }}</th>
            <td v-for="wd in weekdays" :key="wd" class="group relative border-l border-slate-100 px-1.5 py-1.5">
              <button class="absolute right-1 top-1 rounded p-0.5 text-slate-300 hover:bg-brand-50 hover:text-brand-600" :aria-label="`新增${wdLabel(wd)}${p.label}門診`" @click="openSlot(undefined, wd, p.key)">
                <Plus class="h-3.5 w-3.5" />
              </button>
              <div class="space-y-1 pr-5">
                <button
                  v-for="s in cell(wd, p.key)"
                  :key="s.id"
                  :class="['block w-full rounded border px-1.5 py-1 text-left text-xs hover:border-brand-400', s.doctorActive ? 'border-slate-200 bg-white' : 'border-red-200 bg-red-50']"
                  :title="`${s.deptName}・${s.doctorName}・${s.roomNo} 診・上限 ${s.limit} 人`"
                  @click="openSlot(s)"
                >
                  <div class="truncate font-medium text-slate-800">{{ s.doctorName }}</div>
                  <div class="tabular truncate text-slate-500">{{ s.roomNo }} 診・{{ s.limit }} 人</div>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    </UQueryState>

    <UDialog v-model="open" @submit="submit" :title="form.id ? '編輯每週門診' : '新增每週門診'">
      <div class="grid grid-cols-2 gap-3">
        <USelect v-model="form.doctorId" label="醫師" required placeholder="請選擇" :options="doctorOptions" class="col-span-2" :error="save.fieldErrors.value.doctorId" />
        <USelect v-model="form.weekday" label="星期" required :options="weekdays.map((wd) => ({ label: wdLabel(wd), value: wd }))" :error="save.fieldErrors.value.weekday" />
        <USelect v-model="form.period" label="時段" required :options="periods.map((p) => ({ label: p.label, value: p.key }))" :error="save.fieldErrors.value.period" />
        <UInput v-model="form.roomNo" label="診間" required placeholder="例：101" :error="save.fieldErrors.value.roomNo" />
        <UInput v-model="form.limit" label="人數上限" type="number" min="1" required :error="save.fieldErrors.value.limit" />
      </div>
      <p class="mt-3 text-xs text-slate-500">變更只影響尚無掛號的未來診次；已有掛號的維持原安排。</p>
      <template #footer>
        <UButton v-if="form.id" class="mr-auto" variant="ghost" :icon="Trash2" :loading="del.pending.value" @click="remove">移除</UButton>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton :loading="save.pending.value" type="submit">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
