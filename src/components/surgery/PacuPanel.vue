<script setup lang="ts">
// 恢復室（一台手術）：交班重點（麻醉、術中異常、輸入輸出、PCA）、Aldrete 與疼痛評分、轉出（不符合要麻醉醫師寫原因放行）、病房接回。
// 轉出條件、該評分了、停留過久都由服務層判斷（anesthesia.ts、anesthesia-rules）
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UCheckbox, UInput, UQueryState, USelect } from '@/components/ui'
import { ALDRETE_ITEMS, anesthesiaApi, PACU_ALDRETE_MIN, PACU_PAIN_MAX, type PacuItem } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ surgeryId: string }>()
const emit = defineEmits<{ changed: [] }>()
const { data, loading, reload } = useQuery(() => anesthesiaApi.pacuOf(props.surgeryId), [() => props.surgeryId])
const p = computed<PacuItem | null | undefined>(() => (data.value === null ? null : data.value?.surgeryId === props.surgeryId ? data.value : undefined))

const f = reactive<Record<string, string | number | undefined>>({ activity: '', respiration: '', circulation: '', consciousness: '', spo2: '', pain: '' })
const ponv = ref(false)
const scoreAct = useAction(anesthesiaApi.recordPacuScore, { success: (x) => `已評分：Aldrete ${x.latest?.aldrete}、疼痛 ${x.latest?.pain}` })
async function score() {
  const v = await scoreAct.run(props.surgeryId, { ...Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x === '' ? undefined : Number(x)])), ponv: ponv.value })
  if (v) {
    for (const k of Object.keys(f)) f[k] = ''
    ponv.value = false
    done()
  }
}
const override = ref('')
const outAct = useAction(anesthesiaApi.dischargePacu, { success: '已轉出恢復室，等病房接回' })
async function discharge() {
  if (await outAct.run(props.surgeryId, { override: override.value })) done()
}
const recvAct = useAction(anesthesiaApi.receivePacu, { success: '已接回病房' })
async function receive() {
  if (await recvAct.run(props.surgeryId)) done()
}
function done() {
  reload()
  emit('changed')
}
const STAGE = { in: { label: '恢復室中', tone: 'purple' }, out: { label: '待病房接回', tone: 'yellow' }, back: { label: '已接回病房', tone: 'green' } } as const
</script>

<template>
  <UQueryState :loading="loading && p === undefined" :ready="p !== undefined">
    <section v-if="p" class="space-y-2 rounded-md border border-slate-200 p-3 text-sm">
      <div class="flex flex-wrap items-center gap-2">
        <h4 class="font-semibold text-slate-700">恢復室</h4>
        <UBadge :tone="STAGE[p.stage].tone">{{ STAGE[p.stage].label }}</UBadge>
        <span class="tabular text-xs" :class="p.long ? 'font-semibold text-red-700' : 'text-slate-600'">{{ p.inAt.slice(11) }} 進入・{{ p.stage === 'in' ? '已' : '共' }} {{ p.minutes }} 分鐘{{ p.long ? '（超過 2 小時）' : '' }}</span>
        <span v-if="p.scoreDue" class="text-xs font-medium text-amber-700">該評分了（每 15 分鐘）</span>
      </div>
      <ul class="space-y-0.5 rounded bg-slate-50 px-3 py-1.5 text-xs text-slate-700">
        <li v-for="(h, i) in p.handover" :key="i" :class="h.startsWith('術中') ? 'text-red-700' : ''">{{ h }}</li>
      </ul>

      <table v-if="p.scores.length" class="w-full text-xs">
        <thead class="text-slate-500"><tr><th class="text-left font-normal">時間</th><th v-for="it in ALDRETE_ITEMS" :key="it.key" class="font-normal">{{ it.label }}</th><th class="font-normal">Aldrete</th><th class="font-normal">疼痛</th><th class="font-normal">噁吐</th><th class="text-right font-normal">評分者</th></tr></thead>
        <tbody class="tabular">
          <tr v-for="sc in p.scores" :key="sc.id" class="border-t border-slate-100 text-center">
            <td class="text-left">{{ sc.at.slice(11) }}</td>
            <td v-for="it in ALDRETE_ITEMS" :key="it.key">{{ sc[it.key] }}</td>
            <td :class="sc.aldrete < PACU_ALDRETE_MIN ? 'font-semibold text-red-700' : 'font-semibold text-emerald-700'">{{ sc.aldrete }}</td>
            <td :class="sc.pain > PACU_PAIN_MAX ? 'text-red-700' : ''">{{ sc.pain }}</td>
            <td>{{ sc.ponv ? '有' : '—' }}</td>
            <td class="text-right text-slate-500">{{ sc.byName }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="text-xs text-slate-400">還沒評分</p>

      <form v-if="p.canScore" class="grid grid-cols-2 gap-2 rounded bg-slate-50 p-2 sm:grid-cols-4" @submit.prevent="score">
        <USelect v-for="it in ALDRETE_ITEMS" :key="it.key" v-model="f[it.key]" :label="it.label" :options="it.options.map((o, i) => ({ label: `${i}：${o}`, value: i }))" placeholder="選擇" :error="scoreAct.fieldErrors.value[it.key]" />
        <UInput v-model="f.pain" type="number" label="疼痛（0–10）" :error="scoreAct.fieldErrors.value.pain" />
        <div class="flex items-end pb-2"><UCheckbox v-model="ponv" label="噁心嘔吐" /></div>
        <div class="col-span-full flex justify-end"><UButton type="submit" size="sm" :loading="scoreAct.pending.value">評分</UButton></div>
      </form>

      <div v-if="p.stage === 'in'" class="flex flex-wrap items-end gap-2">
        <p class="text-xs" :class="p.unmet.length ? 'text-amber-800' : 'text-emerald-700'">
          轉出條件（Aldrete ≥ {{ PACU_ALDRETE_MIN }}、疼痛 ≤ {{ PACU_PAIN_MAX }}、沒有噁心嘔吐）：{{ p.unmet.length ? `還沒達到——${p.unmet.join('、')}` : '已達到' }}
        </p>
        <div v-if="p.canOverride && p.unmet.length" class="min-w-[14rem] flex-1"><UInput v-model="override" label="放行原因（麻醉醫師）" :error="outAct.fieldErrors.value.override" /></div>
        <UButton v-if="p.canDischarge && (!p.unmet.length || p.canOverride)" size="sm" class="ml-auto" :loading="outAct.pending.value" @click="discharge">{{ p.unmet.length ? '放行轉出' : '轉回病房' }}</UButton>
      </div>
      <p v-if="p.outText" class="text-xs text-slate-600">{{ p.outText }}</p>
      <div v-if="p.stage === 'out'" class="flex items-center gap-2">
        <p class="text-xs text-amber-800">已轉出，等病房護理師接回。</p>
        <UButton v-if="p.canReceive" size="sm" class="ml-auto" :loading="recvAct.pending.value" @click="receive">接回病房</UButton>
      </div>
      <p v-if="p.receivedText" class="text-xs text-emerald-700">{{ p.receivedText }}</p>
    </section>
  </UQueryState>
</template>
