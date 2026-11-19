<script setup lang="ts">
// 手術團隊：主刀、助手、麻醉醫師、刷手、流動護理師。
//   - 排程後、麻醉前查核前：有「手術排程」權限的人直接指定（換人不留交班）
//   - 麻醉前查核後到手術完成：護理師記交班（誰接手、幾點）
// 到齊才能查核（流動、麻醉醫師 → 麻醉前查核；刷手 → 劃刀前暫停確認）由服務層判斷（surgery.setTeam、handoverTeam、recordCheck）
import { computed, reactive, ref, watch } from 'vue'
import { Users } from 'lucide-vue-next'
import { UButton, UInput, USelect } from '@/components/ui'
import { surgeryApi, type SurgeryView } from '@/services'
import type { TeamRole } from '@/types'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ surgery: SurgeryView; canSchedule: boolean; isNurse: boolean }>()
const s = computed(() => props.surgery)
const planning = computed(() => props.canSchedule && (s.value.status === 'scheduled' || s.value.status === 'sent') && !s.value.checks.signIn)
const live = computed(() => props.isNurse && !!s.value.checks.signIn && (s.value.status === 'sent' || s.value.status === 'in-progress'))
const { data: opts } = useQuery(() => surgeryApi.teamOptions(props.surgery.id), [() => props.surgery.id], { immediate: true })
const options = (r: string) => [{ label: '（不指定）', value: '' }, ...(opts.value?.options[r as TeamRole] ?? []).map((x) => ({ label: x.name, value: x.id }))]

const editing = ref(false)
const form = reactive<Record<string, string | number | undefined>>({})
// 人員衝突放行原因（只有急刀能放行；服務層判斷）
const clashReason = ref('')
function edit() {
  for (const r of s.value.teamRows) form[r.role] = r.userId ?? ''
  clashReason.value = ''
  saveAct.fieldErrors.value = {}
  editing.value = true
}
watch(() => props.surgery.id, () => (editing.value = false))
const saveAct = useAction(surgeryApi.setTeam, { success: '已更新手術團隊' })
async function save() {
  if (await saveAct.run(s.value.id, { ...Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v ?? '')])), clashReason: clashReason.value })) editing.value = false
}

const handing = ref<string>()
const ho = reactive({ userId: '' as string | number | undefined, at: '' })
function openHandover(role: string) {
  Object.assign(ho, { userId: '', at: '' })
  clashReason.value = ''
  hoAct.fieldErrors.value = {}
  handing.value = role
}
const hoAct = useAction(surgeryApi.handoverTeam, { success: (v) => `已記交班：${v.teamRows.find((r) => r.role === handing.value)?.label ?? ''}` })
async function handover() {
  if (handing.value && (await hoAct.run(s.value.id, handing.value as TeamRole, { userId: String(ho.userId ?? ''), at: ho.at.replace('T', ' '), clashReason: clashReason.value }))) handing.value = undefined
}
const span = (x: { from?: string; to?: string }) => (x.from || x.to ? `（${x.from?.slice(11) ?? ''}–${x.to?.slice(11) ?? ''}）` : '')
</script>

<template>
  <section class="space-y-2 rounded-md border p-3 text-sm" :class="s.teamMissing.length ? 'border-amber-300 bg-amber-50/40' : 'border-slate-200'">
    <div class="flex flex-wrap items-center gap-2">
      <Users class="h-4 w-4 text-slate-500" />
      <h4 class="font-semibold text-slate-700">手術團隊</h4>
      <span v-if="s.teamMissing.length" class="text-xs font-medium text-amber-800">還缺：{{ s.teamMissing.join('、') }}（{{ s.status === 'sent' && !s.checks.signIn ? '麻醉前查核前' : '劃刀前暫停確認前' }}要到齊）</span>
      <UButton v-if="planning && !editing" size="sm" variant="secondary" class="ml-auto" @click="edit">{{ s.teamRows.some((r) => r.userId) ? '修改團隊' : '指定團隊' }}</UButton>
    </div>

    <form v-if="editing" class="grid grid-cols-1 gap-2 sm:grid-cols-2" @submit.prevent="save">
      <USelect v-for="r in s.teamRows" :key="r.role" v-model="form[r.role]" :label="r.label + (r.role === 'assistant' ? '（選填）' : r.role === 'anesthetist' && s.anesthesia === 'local' ? '（局部麻醉不用）' : '')" :options="options(r.role)" :error="saveAct.fieldErrors.value[r.role]" />
      <div v-if="s.urgency || Object.values(saveAct.fieldErrors.value).some((x) => x.includes('放行'))" class="col-span-full"><UInput v-model="clashReason" label="人員同時段在別台時的放行原因（急刀，選填）" placeholder="例：夜間人力不足，流動護理師兼顧兩房" /></div>
      <div class="col-span-full flex justify-end gap-2">
        <UButton size="sm" variant="secondary" @click="editing = false">取消</UButton>
        <UButton size="sm" type="submit" :loading="saveAct.pending.value">存團隊</UButton>
      </div>
    </form>

    <dl v-else class="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1">
      <dt class="text-slate-500">主刀</dt><dd class="text-slate-800">{{ s.doctorName }}</dd>
      <template v-for="r in s.teamRows" :key="r.role">
        <dt class="text-slate-500">{{ r.label }}</dt>
        <dd class="flex flex-wrap items-center gap-x-2">
          <template v-if="r.shifts.length">
            <span v-for="(x, i) in r.shifts" :key="i" :class="i === r.shifts.length - 1 && !x.to ? 'text-slate-800' : 'text-slate-500 line-through decoration-slate-300'">{{ i ? '→ ' : '' }}{{ x.name }}<span class="tabular text-xs">{{ span(x) }}</span></span>
          </template>
          <span v-else :class="s.teamMissing.includes(r.label) ? 'font-medium text-amber-800' : 'text-slate-400'">未指定</span>
          <button v-if="live && handing !== r.role" type="button" class="text-xs text-brand-700 underline" @click="openHandover(r.role)">{{ r.userId ? '交班' : '加入' }}</button>
        </dd>
        <dd v-if="handing === r.role" class="col-span-2 flex flex-wrap items-end gap-2 rounded bg-slate-50 p-2">
          <div class="min-w-[10rem] flex-1"><USelect v-model="ho.userId" :label="`接手的${r.label}`" :options="options(r.role).slice(1)" placeholder="選擇" :error="hoAct.fieldErrors.value.userId" /></div>
          <div v-if="s.urgency || hoAct.fieldErrors.value.userId?.includes('放行')" class="min-w-[12rem] flex-1"><UInput v-model="clashReason" label="同時段在別台的放行原因（急刀）" /></div>
          <div class="w-48"><UInput v-model="ho.at" type="datetime-local" label="交班時間（空白＝現在）" :error="hoAct.fieldErrors.value.at" /></div>
          <UButton size="sm" variant="secondary" @click="handing = undefined">取消</UButton>
          <UButton size="sm" :loading="hoAct.pending.value" @click="handover">記交班</UButton>
        </dd>
      </template>
    </dl>
    <p v-if="!planning && !live && !s.teamRows.some((r) => r.userId) && s.status === 'scheduled'" class="text-xs text-slate-500">團隊由有「手術排程」權限的人指定。</p>
  </section>
</template>
