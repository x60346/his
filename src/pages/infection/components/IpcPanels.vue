<script setup lang="ts">
// 感染管制頁的三個分頁：指標（各病房感染密度、CAUTI／CLABSI／VAP）、群聚（確認或排除）、法定傳染病（待通報、通報過的）
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { UBadge, UButton, UCard, UDialog, UQueryState, UTextarea } from '@/components/ui'
import { ipcApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ mode: 'stats' | 'clusters' | 'notify' }>()
const emit = defineEmits<{ changed: [] }>()
const router = useRouter()
const { data: stats, loading: l1 } = useQuery(async () => (props.mode === 'stats' ? ipcApi.infectionStats(30) : undefined), [() => props.mode])
const { data: cl, loading: l2, reload: reloadCl } = useQuery(async () => (props.mode === 'clusters' ? ipcApi.listClusters() : undefined), [() => props.mode])
const { data: nf, loading: l3 } = useQuery(async () => (props.mode === 'notify' ? ipcApi.listNotifiable() : undefined), [() => props.mode])
const rate = (x: number | null) => (x === null ? '—' : x)
const hm = (s: string) => s.slice(5, 16).replace('-', '/')

// 群聚判定
const deciding = ref<{ key: string; label: string; confirm: boolean }>()
const open = computed({ get: () => !!deciding.value, set: (x) => !x && (deciding.value = undefined) })
const f = reactive({ note: '' })
const act = useAction(ipcApi.decideCluster, { success: () => (deciding.value?.confirm ? '已確認群聚' : '已排除') })
async function submit() {
  if (deciding.value && (await act.run(deciding.value.key, { confirm: deciding.value.confirm, note: f.note }))) {
    deciding.value = undefined
    reloadCl()
    emit('changed')
  }
}
const stateTone = { ok: 'gray', soon: 'yellow', overdue: 'red' } as const
const stateText = { ok: '時限內', soon: '快到期', overdue: '逾時' } as const
</script>

<template>
  <div class="text-sm">
    <!-- 指標 -->
    <UCard v-if="mode === 'stats'" :padded="false">
      <UQueryState :loading="l1 && !stats" :ready="!!stats">
        <div v-if="stats" class="overflow-x-auto p-3">
          <p class="mb-2 text-xs text-slate-500">{{ stats.from }} ～ {{ stats.to }}，判定成立的院內感染。密度＝每千住院人日；裝置相關＝每千管路日（導尿管、中心靜脈導管、氣管內管）</p>
          <table class="tabular w-full min-w-[40rem] text-xs">
            <thead class="text-slate-500"><tr><th class="py-1 text-left font-medium">病房</th><th class="text-right font-medium">住院人日</th><th class="text-right font-medium">院內感染</th><th class="text-right font-medium">密度</th><th v-for="d in stats.total.devices" :key="d.kind" class="text-right font-medium">{{ d.short }}（例／管路日・率）</th></tr></thead>
            <tbody>
              <tr v-for="r in [...stats.rows, stats.total]" :key="r.ward" :class="['border-t border-slate-100', r.ward === '全院' && 'font-semibold']">
                <td class="py-1">{{ r.ward }}</td><td class="text-right">{{ r.patientDays }}</td><td class="text-right">{{ r.hai }}</td><td class="text-right">{{ rate(r.density) }}</td>
                <td v-for="d in r.devices" :key="d.kind" class="text-right">{{ d.cases }}／{{ d.lineDays }}・{{ rate(d.rate) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </UQueryState>
    </UCard>

    <!-- 群聚 -->
    <UQueryState v-else-if="mode === 'clusters'" :loading="l2 && !cl" :ready="!!cl" >
      <div v-if="cl" class="space-y-3">
        <p class="text-xs text-slate-500">同病房 14 天內兩例以上同菌種（從培養結果認得出的）或同感染部位；被判定不成立的個案不算。</p>
        <p v-if="!cl.clusters.length" class="rounded-md border border-slate-200 bg-white px-3 py-6 text-center text-slate-400">最近 60 天沒有疑似群聚</p>
        <UCard v-for="c in cl.clusters" :key="c.key">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge :tone="c.decision ? (c.decision.status === 'confirmed' ? 'red' : 'gray') : 'yellow'">{{ c.decision ? (c.decision.status === 'confirmed' ? '已確認群聚' : '已排除') : '疑似群聚・待判定' }}</UBadge>
            <b>{{ c.ward }}・{{ c.label }}</b><span class="text-xs text-slate-500">{{ c.by === 'organism' ? '同菌種' : '同感染部位' }}・{{ c.caseIds.length }} 例・{{ c.from }} ～ {{ c.to }}</span>
            <span v-if="!c.decision && cl.canDecide" class="ml-auto flex gap-2">
              <UButton size="sm" variant="danger" @click="f.note = ''; act.fieldErrors.value = {}; deciding = { key: c.key, label: `${c.ward} ${c.label}`, confirm: true }">確認群聚</UButton>
              <UButton size="sm" variant="secondary" @click="f.note = ''; act.fieldErrors.value = {}; deciding = { key: c.key, label: `${c.ward} ${c.label}`, confirm: false }">排除</UButton>
            </span>
          </div>
          <ul class="mt-1 text-xs text-slate-700">
            <li v-for="x in c.cases" :key="x.id">{{ x.onsetAt }} {{ x.patientName }}（{{ x.bedNo }}）・{{ x.culture }}<UBadge v-if="x.status === 'reported'" tone="yellow" class="ml-1">待判定</UBadge></li>
          </ul>
          <p v-if="c.decision" class="mt-1 text-xs text-slate-600">{{ c.decision.status === 'confirmed' ? '處置' : '排除原因' }}：{{ c.decision.note }}（{{ c.byName }} {{ hm(c.decision.at) }}）</p>
        </UCard>
      </div>
    </UQueryState>

    <!-- 法定傳染病 -->
    <UQueryState v-else :loading="l3 && !nf" :ready="!!nf">
      <div v-if="nf" class="space-y-3">
        <UCard :padded="false">
          <div class="border-b border-slate-100 px-3 py-2 font-semibold text-slate-700">待通報 {{ nf.pending.length }}</div>
          <p v-if="!nf.pending.length" class="px-3 py-4 text-center text-slate-400">沒有待通報</p>
          <button v-for="p in nf.pending" :key="`${p.patientId}-${p.disease}`" type="button" class="block w-full border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-slate-50" @click="router.push({ name: 'ipd', query: { admission: p.admissionId } })">
            <div class="flex flex-wrap items-center gap-2"><UBadge :tone="stateTone[p.state]">{{ stateText[p.state] }}</UBadge><b>{{ p.patientName }}</b><span class="text-xs text-slate-500">{{ p.ward }} {{ p.bedNo }}</span><b class="text-red-700">{{ p.label }}</b></div>
            <div class="text-xs text-slate-600">{{ p.basis }}・時限 {{ hm(p.dueAt) }}</div>
          </button>
        </UCard>
        <UCard v-if="nf.reported.length" :padded="false">
          <div class="border-b border-slate-100 px-3 py-2 font-semibold text-slate-700">最近 30 天通報 {{ nf.reported.length }}</div>
          <div v-for="r in nf.reported" :key="r.id" class="border-b border-slate-100 px-3 py-1.5 text-xs last:border-b-0">{{ hm(r.reportedAt) }} {{ r.patientName }}・{{ r.label }}・{{ r.cdcNo }}・{{ r.reportedByName }}<UBadge v-if="r.late" tone="red" class="ml-1">逾時通報</UBadge></div>
        </UCard>
      </div>
    </UQueryState>

    <UDialog v-model="open" :title="deciding?.confirm ? `確認群聚：${deciding?.label}` : `排除群聚：${deciding?.label}`" size="sm" @submit="submit">
      <UTextarea v-model="f.note" :label="deciding?.confirm ? '處置' : '排除原因'" :rows="3" required :error="act.fieldErrors.value.note" :placeholder="deciding?.confirm ? '例：加強手部衛生稽核、導尿管照護查核、同病房篩檢' : '例：菌株不同、時間不重疊'" />
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton type="submit" :variant="deciding?.confirm ? 'danger' : 'primary'" :loading="act.pending.value">{{ deciding?.confirm ? '確認' : '排除' }}</UButton>
      </template>
    </UDialog>
  </div>
</template>
