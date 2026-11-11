<script setup lang="ts">
// 診間主檔：每週門診表只能選這裡有的、啟用中的診間。位置會印在掛號單上。
// 診間號建立後不能改（門診表、診次都用它）；還有門診表在用的不能停用（服務層擋，訊息列出是誰在用）。
import { reactive, ref } from 'vue'
import { Pencil, Plus } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UTable, type Column } from '@/components/ui'
import { scheduleApi, type RoomRow } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { periodLabel } from '@/utils/date'

const { data: rooms, loading } = useQuery(() => scheduleApi.listRooms())
const columns: Column<RoomRow>[] = [
  { key: 'roomNo', label: '診間', width: '6rem' },
  { key: 'location', label: '位置' },
  { key: 'slots', label: '每週門診' },
  { key: 'active', label: '狀態', width: '5rem' },
  { key: 'act', label: '', width: '6rem', align: 'right' },
]
const usage = (r: RoomRow) =>
  r.slots.length ? `${r.slots.length} 診次：${r.slots.slice(0, 3).map((x) => `${x.doctorName} 週${'日一二三四五六'[x.weekday]}${periodLabel[x.period]}`).join('、')}${r.slots.length > 3 ? '…' : ''}` : '—'

const open = ref(false)
const isNew = ref(true)
const form = reactive({ roomNo: '', location: '', active: true })
function openEdit(r?: RoomRow) {
  isNew.value = !r
  Object.assign(form, r ? { roomNo: r.roomNo, location: r.location, active: r.active } : { roomNo: '', location: '', active: true })
  save.fieldErrors.value = {}
  open.value = true
}
const save = useAction(scheduleApi.saveRoom, { success: (r) => `已儲存 ${r.roomNo} 診` })
async function submit() {
  if (await save.run({ ...form }, isNew.value)) open.value = false
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center">
      <p class="text-sm text-slate-500">每週門診表的診間只能從這裡選；位置會印在掛號單上。</p>
      <UButton class="ml-auto" :icon="Plus" @click="openEdit()">新增診間</UButton>
    </div>
    <UTable :columns="columns" :rows="rooms ?? []" :row-key="(r) => r.roomNo" :loading="loading && !rooms" dense :row-class="(r) => (r.active ? '' : 'text-slate-400')">
      <template #cell-roomNo="{ row }"><span class="tabular font-medium">{{ row.roomNo }}</span></template>
      <template #cell-slots="{ row }"><span class="text-xs text-slate-600">{{ usage(row) }}</span></template>
      <template #cell-active="{ row }"><UBadge :tone="row.active ? 'green' : 'gray'">{{ row.active ? '啟用' : '停用' }}</UBadge></template>
      <template #cell-act="{ row }"><UButton size="sm" variant="ghost" :icon="Pencil" @click="openEdit(row)">編輯</UButton></template>
    </UTable>

    <UDialog v-model="open" @submit="submit" :title="isNew ? '新增診間' : `編輯 ${form.roomNo} 診`" size="sm">
      <div class="space-y-3">
        <UInput v-model="form.roomNo" label="診間號" required :disabled="!isNew" :hint="isNew ? `${scheduleApi.ROOM_NO_RULE}；建立後不可修改` : '診間號不可修改（門診表、診次都用它對應）'" :error="save.fieldErrors.value.roomNo" />
        <UInput v-model="form.location" label="位置" required placeholder="例：2 樓 內科區" hint="印在掛號單上，病人照著找" :error="save.fieldErrors.value.location" />
        <div>
          <UCheckbox v-model="form.active" label="啟用" />
          <p v-if="save.fieldErrors.value.active" class="mt-1 text-xs text-red-600">{{ save.fieldErrors.value.active }}</p>
        </div>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton :loading="save.pending.value" type="submit">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
