<script setup lang="ts">
// 早期預警 NEWS2（一般病房）：最近一次分數與各項、趨勢、再量時間、快速反應小組呼叫與評估紀錄、手動呼叫。
// 護理站「生命徵象」與住院醫囑「加護病房」分頁共用（加護病房的病人不顯示：那邊看 SOFA）
import { computed, reactive, ref, watch } from 'vue'
import { UBadge, UButton, UDialog, UTextarea } from '@/components/ui'
import { NEWS_ADVICE, NEWS_LEVEL_LABEL, RRT_DISPOSITION_LABEL, rrtApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ admissionId: string; refresh?: number }>()
const { data, reload } = useQuery(() => rrtApi.patientNews(props.admissionId), [() => props.admissionId])
watch(() => props.refresh, () => reload())
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const tone = { low: 'green', medium: 'yellow', high: 'red' } as const
const at = (s?: string) => s?.slice(5, 16).replace('-', '/') ?? ''

const callOpen = ref(false)
const call = reactive({ reason: '' })
const callAct = useAction(rrtApi.callRrt, { success: '已呼叫快速反應小組' })
async function submitCall() {
  if (await callAct.run(props.admissionId, { reason: call.reason })) {
    callOpen.value = false
    reload()
  }
}
</script>

<template>
  <section v-if="v && !v.inIcu" class="rounded-md border border-slate-200 p-3 text-sm">
    <div class="flex flex-wrap items-center gap-2">
      <span class="font-semibold text-slate-700">早期預警 NEWS2</span>
      <template v-if="v.last">
        <UBadge :tone="tone[v.last.level]" class="tabular">{{ v.last.total }} 分・{{ NEWS_LEVEL_LABEL[v.last.level] }}</UBadge>
        <span class="text-xs text-slate-500">{{ at(v.last.at) }}</span>
        <UBadge v-if="v.last.red && v.last.total < 5" tone="yellow">單項 3 分</UBadge>
      </template>
      <span v-else class="text-xs text-slate-500">還沒有算得出分數的紀錄（七項都要有：呼吸、血氧、給氧、收縮壓、心跳、意識、體溫）</span>
      <UBadge v-if="v.recheck" :tone="v.recheck.status === 'overdue' ? 'red' : 'yellow'">{{ v.recheck.status === 'overdue' ? '再量逾時' : '再量' }} {{ v.recheck.dueAt.slice(11) }} 前</UBadge>
      <UBadge v-if="v.open" tone="red">已呼叫快速反應小組（{{ v.open.waitedMin }} 分鐘）</UBadge>
      <UButton v-if="v.canCall" class="ml-auto" size="sm" variant="secondary" @click="call.reason = ''; callAct.fieldErrors.value = {}; callOpen = true">呼叫快速反應小組</UButton>
    </div>
    <template v-if="v.last">
      <div class="tabular mt-1 flex flex-wrap gap-1 text-xs">
        <span v-for="p in v.last.parts" :key="p.key" :class="['rounded px-1.5 py-0.5', p.points === 3 ? 'bg-red-50 text-red-700' : p.points ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600']">{{ p.label }} {{ p.points }}</span>
      </div>
      <p class="mt-1 text-xs text-slate-600">{{ NEWS_ADVICE[v.last.level] }}</p>
    </template>
    <p v-if="v.missing" class="mt-1 text-xs text-amber-800">最近一筆生命徵象缺「{{ v.missing.join('、') }}」，算不出 NEWS2</p>
    <div v-if="v.trend.length > 1" class="tabular mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-500">
      趨勢
      <span v-for="(x, i) in v.trend" :key="x.at" :title="at(x.at)"><span v-if="i" class="text-slate-300">→</span> <b :class="x.level === 'high' ? 'text-red-600' : x.level === 'medium' ? 'text-amber-700' : 'text-slate-700'">{{ x.total }}</b><span class="ml-0.5 text-[10px]">{{ x.at.slice(11) }}</span></span>
    </div>
    <div v-if="v.calls.length" class="mt-2 space-y-1 border-t border-slate-100 pt-2 text-xs text-slate-600">
      <div v-for="c in v.calls" :key="c.id">
        <b class="text-slate-700">{{ at(c.calledAt) }} 快速反應</b>（{{ c.trigger === 'auto' ? `NEWS2 ${c.score} 分自動呼叫` : `${c.calledByName}呼叫：${c.reason}` }}）
        <template v-if="c.status === 'done'">→ {{ at(c.assessedAt) }} {{ c.assessedByName }}評估（{{ c.responseMin }} 分鐘到場）：{{ c.findings }}；處置 {{ c.actions }}；<b>{{ RRT_DISPOSITION_LABEL[c.disposition!] }}</b></template>
        <template v-else>→ 等到場評估</template>
      </div>
    </div>

    <UDialog v-model="callOpen" title="呼叫快速反應小組" size="sm" @submit="submitCall">
      <UTextarea v-model="call.reason" label="呼叫原因" :rows="3" required :error="callAct.fieldErrors.value.reason" placeholder="例：病人突然躁動、說不出話，覺得不對勁" />
      <p class="mt-1 text-xs text-slate-500">NEWS2 ≥7 會自動呼叫；分數不高但你擔心病人，也可以叫。</p>
      <template #footer>
        <UButton variant="secondary" @click="callOpen = false">取消</UButton>
        <UButton type="submit" variant="danger" :loading="callAct.pending.value">呼叫</UButton>
      </template>
    </UDialog>
  </section>
</template>
