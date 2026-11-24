<script setup lang="ts">
// 管灌（護理站病人分頁「管灌」）：目前的管灌醫囑（配方、總量、灌法、熱量蛋白質）、今天各餐（連續灌食是各班）——
// 前後 1 小時內「記錄」灌入量與反抽量；反抽 >200 ml 提醒暫停下一餐並通知醫師（不擋）；沒灌要寫原因。
// 灌入量算進「今日輸入量」（生命徵象分頁）
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UDialog, UInput, UQueryState } from '@/components/ui'
import { TUBE_RESIDUAL_HOLD, tubeApi, type FeedSlot } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'

const props = defineProps<{ admissionId: string }>()
const ui = useUi()
const { data, loading } = useQuery(() => tubeApi.getTubeFeeding(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const stateView = { done: { label: '已記', tone: 'green' }, upcoming: { label: '稍後', tone: 'gray' }, due: { label: '現在', tone: 'yellow' }, overdue: { label: '逾時', tone: 'red' } } as const

const target = ref<FeedSlot>()
const open = computed({ get: () => !!target.value, set: (x) => !x && (target.value = undefined) })
const form = reactive({ givenMl: undefined as number | undefined, residualMl: undefined as number | undefined, held: false, heldReason: '', note: '' })
function openRecord(s: FeedSlot) {
  Object.assign(form, { givenMl: s.ml, residualMl: undefined, held: false, heldReason: '', note: '' })
  save.fieldErrors.value = {}
  target.value = s
}
const save = useAction(tubeApi.recordTubeFeed)
async function submit() {
  if (!target.value) return
  const r = await save.run(props.admissionId, { slot: target.value.slot, givenMl: form.held ? 0 : Number(form.givenMl), ...(form.residualMl !== undefined && (form.residualMl as unknown) !== '' ? { residualMl: Number(form.residualMl) } : {}), ...(form.held ? { heldReason: form.heldReason } : {}), note: form.note })
  if (r) {
    target.value = undefined
    if (r.warning) ui.toast.warning(r.warning)
    else ui.toast.success(`已記錄管灌 ${r.record.givenMl} ml`)
  }
}
const highNow = computed(() => form.residualMl !== undefined && Number(form.residualMl) > TUBE_RESIDUAL_HOLD)
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <UQueryState :loading="loading && !v" :ready="!!v">
      <template v-if="v">
        <p v-if="!v.plan" class="rounded-md border border-slate-200 px-3 py-4 text-center text-slate-400">沒有管灌醫囑</p>
        <template v-else>
          <div class="rounded-md bg-slate-50 px-3 py-2">
            <b class="text-slate-800">{{ v.plan.text }}</b>
            <span class="ml-2 text-xs text-slate-500">約 {{ v.plan.kcal }} kcal、蛋白質 {{ v.plan.protein }} g／日・今天已灌 {{ v.todayMl }} ml</span>
          </div>
          <p v-if="v.highResidual" class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">{{ v.highResidual.at.slice(5).replace('-', '/') }} 反抽 {{ v.highResidual.residualMl }} ml（>{{ TUBE_RESIDUAL_HOLD }}）：建議暫停下一餐並通知醫師</p>
          <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
            <li v-for="s in v.slots" :key="s.slot" class="flex flex-wrap items-center gap-2 px-3 py-2">
              <span class="tabular w-24 text-slate-700">{{ s.slot.slice(5).replace('-', '/') }}</span>
              <span class="text-slate-600">{{ s.ml }} ml{{ v.plan.mode === 'continuous' ? '（本班）' : '' }}</span>
              <UBadge :tone="stateView[s.state].tone">{{ stateView[s.state].label }}</UBadge>
              <span v-if="s.record" class="text-xs text-slate-500">
                {{ s.record.heldReason ? `未灌：${s.record.heldReason}` : `灌 ${s.record.givenMl} ml` }}<template v-if="s.record.residualMl !== undefined">・反抽 <b :class="s.record.residualMl > TUBE_RESIDUAL_HOLD && 'text-red-700'">{{ s.record.residualMl }}</b> ml</template>・{{ s.byName }} {{ s.record.at.slice(11) }}
              </span>
              <UButton v-if="v.canRecord && !s.record && s.state !== 'upcoming'" size="sm" class="ml-auto" @click="openRecord(s)">記錄</UButton>
            </li>
          </ul>
          <p class="text-xs text-slate-500">分次灌食在預定時間前後 1 小時內記錄；連續灌食每班記一次本班的量。灌入量會算進生命徵象分頁的「今日輸入量」。</p>
        </template>
      </template>
    </UQueryState>

    <UDialog v-model="open" :title="`管灌：${target?.slot.slice(5).replace('-', '/') ?? ''}`" size="sm" @submit="submit">
      <div class="space-y-3 text-sm">
        <UInput v-model="form.residualMl" type="number" label="灌食前反抽量 ml（選填）" :error="save.fieldErrors.value.residualMl" />
        <p v-if="highNow" class="rounded bg-red-50 px-2 py-1 text-xs text-red-800">反抽超過 {{ TUBE_RESIDUAL_HOLD }} ml：建議這一餐暫停（勾下面「沒灌」寫原因）並通知醫師</p>
        <label class="flex items-center gap-2"><input v-model="form.held" type="checkbox" class="h-4 w-4" />沒灌</label>
        <UInput v-if="form.held" v-model="form.heldReason" label="沒灌的原因" required placeholder="例：反抽過多、外出檢查" :error="save.fieldErrors.value.givenMl" />
        <UInput v-else v-model="form.givenMl" type="number" label="灌入量 ml" required :error="save.fieldErrors.value.givenMl" />
        <UInput v-model="form.note" label="備註（選填）" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton type="submit" :loading="save.pending.value">記錄</UButton>
      </template>
    </UDialog>
  </div>
</template>
