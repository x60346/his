<script setup lang="ts">
// 負壓隔離室（護理站病房層級分頁，病房有負壓室才出現）：每間的這一班狀態（正常、本班未記錄、負壓不足）、住的人與隔離、
// 記錄壓差（Pa，負值；高於 −2.5 要寫處理）、最近 24 小時的紀錄
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UDialog, UInput, UQueryState } from '@/components/ui'
import { pressureApi, PRESSURE_LIMIT, pressureAbnormal, type NegativeRoom } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ ward: string; canRecord: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { data, loading, reload } = useQuery(async () => ({ ward: props.ward, rooms: await pressureApi.listNegativeRooms(props.ward) }), [() => props.ward])
const rooms = computed(() => (data.value?.ward === props.ward ? data.value.rooms : undefined))
const tone = { ok: 'green', missing: 'yellow', abnormal: 'red' } as const

const editing = ref<NegativeRoom>()
const open = computed({ get: () => !!editing.value, set: (x) => !x && (editing.value = undefined) })
const f = reactive({ pa: undefined as number | undefined, note: '' })
const act = useAction(pressureApi.recordPressure, { success: (r) => `已記錄 ${r.bedNo}：${r.stateLabel}` })
async function submit() {
  if (editing.value && (await act.run(editing.value.bedId, { pa: f.pa === undefined || (f.pa as unknown) === '' ? NaN : Number(f.pa), note: f.note }))) {
    editing.value = undefined
    reload()
    emit('changed')
  }
}
const bad = computed(() => f.pa !== undefined && (f.pa as unknown) !== '' && pressureAbnormal(Number(f.pa)))
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <p class="text-xs text-slate-500">每班至少記錄一次壓差（Pa，負值）。高於 {{ PRESSURE_LIMIT }} Pa 是負壓不足，要寫處理；這一班沒記錄或負壓不足的負壓室，不能新收空氣隔離病人。</p>
    <UQueryState :loading="loading && !rooms" :ready="!!rooms?.length" empty-title="這個病房沒有負壓隔離室">
      <section v-for="r in rooms" :key="r.bedId" class="rounded-md border border-slate-200 p-3">
        <div class="flex flex-wrap items-center gap-2">
          <b class="tabular">{{ r.bedNo }}</b>
          <UBadge :tone="tone[r.state]">{{ r.stateLabel }}<template v-if="r.last">（{{ r.last.pa }} Pa，{{ r.last.at.slice(11) }}）</template></UBadge>
          <span class="text-xs text-slate-600">{{ r.patientName ? `${r.patientName}${r.isolation ? `・${r.isolation}` : ''}` : '空床' }}</span>
          <UButton v-if="canRecord" class="ml-auto" size="sm" :variant="r.state === 'ok' ? 'secondary' : 'primary'" @click="f.pa = undefined; f.note = ''; act.fieldErrors.value = {}; editing = r">記錄壓差</UButton>
        </div>
        <div v-if="r.logs.length" class="tabular mt-1 flex flex-wrap gap-x-3 text-xs text-slate-600">
          <span v-for="l in r.logs" :key="l.id" :class="pressureAbnormal(l.pa) && 'font-semibold text-red-600'" :title="l.note">{{ l.at.slice(5).replace('-', '/') }} {{ l.pa }} Pa（{{ l.byName }}）</span>
        </div>
      </section>
    </UQueryState>

    <UDialog v-model="open" :title="`記錄壓差：${editing?.bedNo ?? ''}`" size="sm" @submit="submit">
      <div class="space-y-2">
        <UInput v-model="f.pa" type="number" step="any" label="壓差 Pa（負值）" :hint="`正常要低於 ${PRESSURE_LIMIT}（例：−10）`" :error="act.fieldErrors.value.pa" />
        <UInput v-if="bad" v-model="f.note" label="負壓不足的處理" placeholder="例：前室門關不緊，已通知工務" :error="act.fieldErrors.value.note" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton type="submit" :loading="act.pending.value">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
