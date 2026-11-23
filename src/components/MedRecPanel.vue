<script setup lang="ts">
// 入院用藥整合（住院醫囑、護理站的病人分頁「用藥整合」共用）：
//   - 還沒建清單：護理師、藥師看系統從門診處方帶出的建議（最近 90 天，可取消勾選）、加院外的藥 → 建立清單（沒有就「無居家用藥」）
//   - 建好了：主治逐項「續用」（院內的藥要先有住院醫囑：沒有就帶入開醫囑對話框，開好再按一次）、「暫停」（原因）、「改藥」（改成什麼）
// 入院 24 小時內要完成。規則在服務層 medrec.ts、medrec-rules
import { computed, ref, watch } from 'vue'
import { Plus, X } from 'lucide-vue-next'
import { UBadge, UButton, UInput, UQueryState } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { medrecApi, type HomeMedInput, type HomeMedView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ admissionId: string }>()
const emit = defineEmits<{ order: [preset: { drugId: string; dose?: number; freq?: string; route?: string }] }>()
const { data, loading } = useQuery(() => medrecApi.getMedRec(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))

// 建清單：建議預設勾選，院外的手打
const picked = ref<Record<string, boolean>>({})
watch(() => v.value?.draft, (d) => (picked.value = Object.fromEntries((d ?? []).map((x) => [x.id, true]))), { immediate: true })
const outside = ref<{ name: string; dose?: number; freq: string }[]>([])
const addOutside = () => outside.value.push({ name: '', freq: '' })
// 院外的藥是這位病人的：換病人清掉
watch(() => props.admissionId, () => (outside.value = []))
const build = useAction(medrecApi.buildMedRec, { success: (r) => (r.items.length ? `已建立居家用藥清單（${r.items.length} 項），等主治整合` : '已記錄：無居家用藥') })
function submitBuild(empty = false) {
  const items: HomeMedInput[] = empty ? [] : [
    ...(v.value?.draft ?? []).filter((x) => picked.value[x.id]).map((x) => ({ drugId: x.drugId, dose: x.dose, freq: x.freq, route: x.route, source: 'opd' as const, lastDate: x.lastDate })),
    ...outside.value.filter((x) => x.name.trim()).map((x) => ({ name: x.name, ...(x.dose ? { dose: Number(x.dose) } : {}), ...(x.freq ? { freq: x.freq } : {}), source: 'outside' as const })),
  ]
  build.run(props.admissionId, items).then((r) => r && (outside.value = []))
}

// 醫師決定
const decide = useAction(medrecApi.decideHomeMed, { success: (r) => (r.state === 'done' ? '用藥整合完成' : '已記錄') })
const asking = ref<{ item: HomeMedView; decision: 'hold' | 'change' | 'continue' }>()
const askingOpen = computed({ get: () => !!asking.value, set: (x) => !x && (asking.value = undefined) })
function onContinue(x: HomeMedView) {
  if (!x.drugId) return void (asking.value = { item: x, decision: 'continue' })
  if (!x.activeOrderId) return emit('order', { drugId: x.drugId, ...(x.dose ? { dose: x.dose } : {}), ...(x.freq ? { freq: x.freq } : {}), ...(x.route ? { route: x.route } : {}) })
  decide.run(props.admissionId, x.id, { decision: 'continue' })
}
async function confirmAsk(reason: string) {
  const a = asking.value
  if (a && (await decide.run(props.admissionId, a.item.id, { decision: a.decision, reason }))) asking.value = undefined
}
const TONE = { continue: 'green', hold: 'yellow', change: 'blue' } as const
</script>

<template>
  <UQueryState :loading="loading && !v" :ready="!!v">
    <div v-if="v" class="space-y-3">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <UBadge :tone="v.state === 'done' ? 'green' : v.overdue ? 'red' : 'yellow'">{{ v.state === 'done' ? '整合完成' : v.state === 'unbuilt' ? '待建居家用藥清單' : `待主治決定 ${v.left} 項` }}</UBadge>
        <span v-if="v.state !== 'done'" :class="['tabular text-xs', v.overdue ? 'font-semibold text-red-700' : 'text-slate-500']">期限 {{ v.dueAt.slice(5) }}（入院 24 小時內）{{ v.overdue ? '・已逾時' : '' }}</span>
        <span v-if="v.builtByName" class="text-xs text-slate-500">清單：{{ v.builtByName }} {{ v.builtAt?.slice(5) }}<template v-if="v.completedByName">・完成：{{ v.completedByName }} {{ v.completedAt?.slice(5) }}</template></span>
      </div>

      <!-- 建清單 -->
      <template v-if="v.state === 'unbuilt'">
        <p v-if="!v.canBuild" class="text-sm text-slate-500">由護理師或藥師建立居家用藥清單。</p>
        <template v-else>
          <p class="text-sm text-slate-600">系統從最近 90 天的院內門診處方帶出（同一個藥取最近一次）；病人沒在吃的取消勾選，院外的藥（含保健食品）另外加。</p>
          <ul class="divide-y divide-slate-100 rounded border border-slate-200 text-sm">
            <li v-for="x in v.draft" :key="x.id" class="flex flex-wrap items-center gap-2 px-3 py-1.5">
              <input v-model="picked[x.id]" type="checkbox" class="h-4 w-4" :aria-label="x.drugName" />
              <b>{{ x.drugName }}</b><span class="text-xs text-slate-600">{{ x.doseText }}</span>
              <span class="ml-auto text-xs text-slate-500">門診 {{ x.lastDate }}</span>
            </li>
            <li v-if="!v.draft.length" class="px-3 py-1.5 text-slate-400">最近 90 天沒有院內門診處方</li>
            <li v-for="(o, i) in outside" :key="`o${i}`" class="flex flex-wrap items-end gap-2 px-3 py-1.5">
              <UInput v-model="o.name" class="min-w-[12rem] flex-1" label="院外的藥（名稱）" placeholder="例：銀杏萃取物 40mg" />
              <UInput v-model="o.dose" class="w-24" type="number" label="每次" />
              <UInput v-model="o.freq" class="w-24" label="頻率" placeholder="BID" />
              <UButton size="sm" variant="ghost" :icon="X" aria-label="移除" @click="outside.splice(i, 1)" />
            </li>
          </ul>
          <p v-if="Object.keys(build.fieldErrors.value).length" class="text-xs text-red-600">{{ Object.values(build.fieldErrors.value).join('；') }}</p>
          <div class="flex flex-wrap justify-end gap-2">
            <UButton size="sm" variant="ghost" :icon="Plus" @click="addOutside">加院外的藥</UButton>
            <UButton size="sm" variant="secondary" :loading="build.pending.value" @click="submitBuild(true)">無居家用藥</UButton>
            <UButton size="sm" :loading="build.pending.value" @click="submitBuild()">建立清單</UButton>
          </div>
        </template>
      </template>

      <!-- 清單與決定 -->
      <ul v-else-if="v.items.length" class="divide-y divide-slate-100 rounded border border-slate-200 text-sm">
        <li v-for="x in v.items" :key="x.id" class="space-y-1 px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <b>{{ x.drugName }}</b><span class="text-xs text-slate-600">{{ x.doseText }}</span>
            <UBadge :tone="x.source === 'opd' ? 'gray' : 'purple'">{{ x.source === 'opd' ? `門診 ${x.lastDate ?? ''}` : '院外' }}</UBadge>
            <UBadge v-if="x.decision" :tone="TONE[x.decision]" class="ml-auto">{{ x.decisionLabel }}</UBadge>
          </div>
          <div v-if="x.decision" class="text-xs text-slate-600">{{ x.decidedByName }} {{ x.decidedAt?.slice(5) }}<template v-if="x.reason">：{{ x.reason }}</template><template v-if="x.decision === 'continue' && x.activeOrderText">（住院醫囑：{{ x.activeOrderText }}）</template></div>
          <div v-else-if="v.canDecide" class="flex flex-wrap items-center justify-end gap-2">
            <span v-if="x.activeOrderText" class="mr-auto text-xs text-emerald-700">已有住院醫囑：{{ x.activeOrderText }}</span>
            <UButton size="sm" variant="ghost" @click="asking = { item: x, decision: 'hold' }">暫停</UButton>
            <UButton size="sm" variant="ghost" @click="asking = { item: x, decision: 'change' }">改藥</UButton>
            <UButton size="sm" :loading="decide.pending.value" @click="onContinue(x)">{{ x.drugId && !x.activeOrderId ? '續用（開醫囑）' : '續用' }}</UButton>
          </div>
        </li>
      </ul>
      <p v-else class="text-sm text-slate-500">無居家用藥。</p>
      <p v-if="decide.fieldErrors.value.decision" class="text-xs text-red-600">{{ decide.fieldErrors.value.decision }}</p>
    </div>
  </UQueryState>

  <ReasonDialog
    v-model="askingOpen"
    :title="asking?.decision === 'hold' ? '暫停居家用藥' : asking?.decision === 'change' ? '改藥' : '續用院外的藥'"
    :subject="asking ? `${asking.item.drugName} ${asking.item.doseText}` : ''"
    :label="asking?.decision === 'hold' ? '暫停原因' : asking?.decision === 'change' ? '改成什麼' : '怎麼續用'"
    :presets="asking?.decision === 'hold' ? ['禁食中', '血壓偏低', '住院期間暫停，出院時再評估'] : asking?.decision === 'change' ? ['改用 Insulin 控制血糖', '改用院內同成分藥'] : ['病人自備，照原劑量']"
    ok-text="確定"
    :pending="decide.pending.value"
    :error="decide.fieldErrors.value.reason"
    @confirm="confirmAsk"
  />
</template>
