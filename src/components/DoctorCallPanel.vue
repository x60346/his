<script setup lang="ts">
// 呼叫醫師（護理站病人分頁）：記打給誰（預設下班時間找那一科的值班醫師、上班時間找主治）、緊急或一般、為什麼；
// 醫師回覆了記方式（電話醫囑、到床邊）。緊急 15 分鐘沒回覆標紅、提醒再找。服務層 doctor-call.ts
import { computed, reactive } from 'vue'
import { UBadge, UButton, UInput, UQueryState, USelect, UTextarea } from '@/components/ui'
import { doctorCallApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ admissionId: string }>()
const emit = defineEmits<{ note: [draft: { callId: string; focus: string; data: string; action: string }] }>()
const { data, loading } = useQuery(async () => ({ id: props.admissionId, v: await doctorCallApi.listDoctorCalls(props.admissionId) }), [() => props.admissionId])
const v = computed(() => (data.value?.id === props.admissionId ? data.value.v : undefined))
const f = reactive({ toUserId: '' as string | number | undefined, urgency: 'routine' as 'urgent' | 'routine', reason: '' })
const call = useAction(doctorCallApi.callDoctor, { success: (c) => `已記錄：${c.urgency === 'urgent' ? '緊急' : '一般'}找 ${c.toName}` })
async function submit() {
  const to = f.toUserId || v.value?.suggest?.userId
  if (await call.run({ admissionId: props.admissionId, toUserId: String(to ?? ''), urgency: f.urgency, reason: f.reason })) Object.assign(f, { toUserId: '', urgency: 'routine', reason: '' })
}
const resp = useAction(doctorCallApi.respondCall, { success: (c) => `已記錄回覆（等了 ${c.waitMinutes} 分）` })
const notes = reactive<Record<string, string>>({})
const esc = useAction(doctorCallApi.escalateCall, { success: (c) => `已改找主治 ${c.toName}（緊急）` })
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <UQueryState :loading="loading && !v" :ready="!!v">
      <template v-if="v">
        <div class="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
          <div class="font-semibold text-slate-700">呼叫醫師</div>
          <p v-if="v.suggest" class="text-xs text-slate-600">現在建議找：<b>{{ v.suggest.name }}</b>（{{ v.suggest.role === 'oncall' ? '值班醫師' : '主治' }}）</p>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <USelect v-model="f.toUserId" label="找誰" :options="[{ label: v.suggest ? `（建議）${v.suggest.name}` : '請選擇', value: '' }, ...v.doctors.map((d) => ({ label: d.name, value: d.id }))]" :error="call.fieldErrors.value.toUserId" />
            <div>
              <div class="mb-1 text-slate-700">緊急程度</div>
              <div class="flex gap-2">
                <label v-for="u in (['urgent', 'routine'] as const)" :key="u" :class="['cursor-pointer rounded-md border-2 px-3 py-1', f.urgency === u ? (u === 'urgent' ? 'border-red-500 bg-red-50' : 'border-brand-500 bg-brand-50') : 'border-slate-200']">
                  <input v-model="f.urgency" type="radio" :value="u" class="sr-only" />{{ u === 'urgent' ? '緊急' : '一般' }}
                </label>
              </div>
            </div>
          </div>
          <UTextarea v-model="f.reason" label="為什麼找" :rows="2" placeholder="例：血壓 82/50、意識變差；要安眠藥" :error="call.fieldErrors.value.reason" />
          <div class="text-right"><UButton size="sm" :loading="call.pending.value" @click="submit">記錄呼叫</UButton></div>
        </div>
        <p v-if="!v.calls.length" class="text-slate-400">這次住院還沒有呼叫醫師的紀錄</p>
        <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
          <li v-for="c in v.calls" :key="c.id" class="space-y-1 px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="tabular text-xs text-slate-500">{{ c.calledAt.slice(5) }}</span>
              <UBadge :tone="c.urgency === 'urgent' ? 'red' : 'gray'">{{ c.urgency === 'urgent' ? '緊急' : '一般' }}</UBadge>
              <b>{{ c.toName }}</b><span class="text-xs text-slate-500">{{ c.roleLabel }}・{{ c.calledByName }} 打</span>
              <UBadge v-if="c.overdue" tone="red">超過 15 分鐘沒回覆：再找一次或改找主治</UBadge>
              <UButton v-if="c.canEscalate" size="sm" variant="danger" :loading="esc.pending.value" @click="esc.run(c.id)">改找主治</UButton>
              <UBadge v-if="c.escalatedToName" tone="gray">已改找 {{ c.escalatedToName }}</UBadge>
              <UBadge v-if="c.noteId" tone="green">已寫護理紀錄</UBadge>
            </div>
            <div class="text-xs text-slate-700">{{ c.reason }}</div>
            <div v-if="c.response" class="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span class="flex-[1_1_12rem]">{{ c.response.at.slice(11) }} {{ c.response.how === 'phone' ? '電話回覆' : '到床邊' }}（等 {{ c.waitMinutes }} 分）{{ c.response.note ? `：${c.response.note}` : '' }}</span>
              <UButton v-if="c.noteDraft" size="sm" variant="ghost" @click="emit('note', c.noteDraft)">帶入護理紀錄</UButton>
            </div>
            <div v-else-if="!c.escalatedTo" class="flex flex-wrap items-end gap-2">
              <UInput v-model="notes[c.id]" class="min-w-0 flex-[1_1_12rem]" placeholder="醫師怎麼處理（選填，例：電話醫囑給 NS 500 mL）" />
              <UButton size="sm" variant="secondary" :loading="resp.pending.value" @click="resp.run(c.id, { how: 'phone', note: notes[c.id] })">電話回覆了</UButton>
              <UButton size="sm" variant="secondary" :loading="resp.pending.value" @click="resp.run(c.id, { how: 'bedside', note: notes[c.id] })">到床邊了</UButton>
            </div>
          </li>
        </ul>
      </template>
    </UQueryState>
  </div>
</template>
