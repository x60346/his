<script setup lang="ts">
// 快速反應小組（權限 rrt，示範 dr03）：等到場評估的呼叫（等最久的在上面）、評估（發現、處置、留原病房或申請轉加護病房）、
// 最近 7 天評估過的、品質指標（30 天）。點病人名字到那位病人的住院醫囑
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { UBadge, UButton, UCard, UDialog, UPageHeader, UQueryState, USelect, UTextarea } from '@/components/ui'
import { ICU_CATEGORIES, NEWS_LEVEL_LABEL, RRT_DISPOSITION_LABEL, rrtApi, type RrtView } from '@/services'
import type { IcuCategory } from '@/types'
import { useAction, useQuery } from '@/composables/useService'

const router = useRouter()
const { data, loading, reload } = useQuery(() => rrtApi.listRrt())
const at = (s?: string) => s?.slice(5, 16).replace('-', '/') ?? ''
const tone = { low: 'green', medium: 'yellow', high: 'red' } as const
const icuText = { pending: '待加護病房主治同意', accepted: '同意，候床中', declined: '加護病房不同意', cancelled: '已取消', placed: '已轉入加護病房' } as const

const assessing = ref<RrtView>()
const open = computed({ get: () => !!assessing.value, set: (x) => !x && (assessing.value = undefined) })
const f = reactive({ findings: '', actions: '', disposition: '' as 'stay' | 'icu' | '', category: '' as IcuCategory | '', reason: '' })
function openAssess(c: RrtView) {
  Object.assign(f, { findings: '', actions: '', disposition: '', category: '', reason: '' })
  act.fieldErrors.value = {}
  assessing.value = c
}
const act = useAction(rrtApi.assessRrt, { success: (c) => (c.disposition === 'icu' ? '已評估：送出轉入加護病房申請' : '已評估：留原病房') })
async function submit() {
  if (!assessing.value) return
  const ok = await act.run(assessing.value.id, {
    findings: f.findings, actions: f.actions, disposition: f.disposition as 'stay' | 'icu',
    ...(f.disposition === 'icu' ? { category: f.category as IcuCategory, reason: f.reason } : {}),
  })
  if (ok) {
    assessing.value = undefined
    reload()
  }
}
const toIpd = (id: string) => router.push({ name: 'ipd', query: { admission: id } })
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="快速反應" description="一般病房 NEWS2 ≥7 自動呼叫、護理師擔心病人手動呼叫：到場評估，留原病房或申請轉加護病房" />
    <UQueryState :loading="loading && !data" :ready="!!data">
      <div v-if="data" class="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_20rem]">
        <UCard :padded="false" class="self-start">
          <div class="border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">等到場評估 {{ data.pending.length }}</div>
          <p v-if="!data.pending.length" class="px-4 py-4 text-center text-sm text-slate-400">沒有等評估的呼叫</p>
          <div v-for="c in data.pending" :key="c.id" class="border-b border-slate-100 px-4 py-3 text-sm last:border-b-0">
            <div class="flex flex-wrap items-center gap-2">
              <UBadge tone="red">{{ c.trigger === 'auto' ? `NEWS2 ${c.score}` : '手動呼叫' }}</UBadge>
              <button type="button" class="font-semibold text-brand-700 hover:underline" @click="toIpd(c.admissionId)">{{ c.patientName }}</button>
              <span class="text-xs text-slate-500">{{ c.ward }} {{ c.bedNo }}・{{ c.diagnosis }}</span>
              <span :class="['ml-auto text-xs', (c.waitedMin ?? 0) > 15 ? 'font-semibold text-red-600' : 'text-slate-500']">{{ at(c.calledAt) }} {{ c.calledByName }}呼叫・等了 {{ c.waitedMin }} 分鐘</span>
            </div>
            <div v-if="c.reason" class="mt-0.5 text-slate-700">{{ c.reason }}</div>
            <div v-if="c.news" class="tabular mt-1 flex flex-wrap gap-1 text-xs">
              <span v-for="p in c.news.parts" :key="p.key" :class="['rounded px-1.5 py-0.5', p.points === 3 ? 'bg-red-50 text-red-700' : p.points ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600']">{{ p.label }} {{ p.points }}</span>
              <span class="text-slate-400">（{{ at(c.news.at) }}）</span>
            </div>
            <div v-if="c.latest && c.latest.at !== c.news?.at" class="mt-0.5 text-xs text-slate-600">目前 NEWS2 <UBadge :tone="tone[c.latest.level]" class="tabular">{{ c.latest.total }}・{{ NEWS_LEVEL_LABEL[c.latest.level] }}</UBadge>（{{ at(c.latest.at) }}）</div>
            <div v-if="data.canAssess" class="mt-2"><UButton size="sm" @click="openAssess(c)">到場評估</UButton></div>
          </div>
          <details v-if="data.recent.length" class="px-4 py-2 text-xs text-slate-600" open>
            <summary class="cursor-pointer">最近 7 天評估過 {{ data.recent.length }} 筆</summary>
            <div v-for="c in data.recent" :key="c.id" class="border-t border-slate-100 py-1.5">
              <div class="flex flex-wrap items-center gap-2">
                <span class="tabular">{{ at(c.assessedAt) }}</span>
                <button type="button" class="font-semibold text-brand-700 hover:underline" @click="toIpd(c.admissionId)">{{ c.patientName }}</button>
                <span>{{ c.trigger === 'auto' ? `NEWS2 ${c.score} 分` : '手動' }}・{{ c.responseMin }} 分鐘到場・{{ c.assessedByName }}</span>
                <UBadge :tone="c.disposition === 'icu' ? 'red' : 'gray'">{{ RRT_DISPOSITION_LABEL[c.disposition!] }}</UBadge>
                <UBadge v-if="c.icuRequestStatus" tone="blue">{{ icuText[c.icuRequestStatus] }}</UBadge>
              </div>
              <div class="text-slate-700">{{ c.findings }}；處置 {{ c.actions }}</div>
            </div>
          </details>
        </UCard>
        <UCard class="self-start">
          <div class="text-sm font-semibold text-slate-700">品質指標（最近 {{ data.stats.days }} 天）</div>
          <dl class="tabular mt-2 grid grid-cols-[1fr_auto] gap-y-1 text-sm">
            <dt class="text-slate-500">呼叫次數</dt><dd>{{ data.stats.calls }}（自動 {{ data.stats.auto }}）</dd>
            <dt class="text-slate-500">平均到場評估</dt><dd>{{ data.stats.avgResponseMin === null ? '—' : `${data.stats.avgResponseMin} 分鐘` }}</dd>
            <dt class="text-slate-500">轉加護病房</dt><dd>{{ data.stats.toIcu }} / {{ data.stats.done }}</dd>
          </dl>
          <p class="mt-2 text-xs text-slate-500">NEWS2：5–6 分或單項 3 分通知主治、1 小時內再量；≥7 分自動呼叫（已經在等、或已申請轉加護病房的不重複叫）。</p>
        </UCard>
      </div>
    </UQueryState>

    <UDialog v-model="open" :title="`快速反應評估：${assessing?.patientName ?? ''}`" @submit="submit">
      <div class="space-y-2 text-sm">
        <UTextarea v-model="f.findings" label="評估發現" :rows="2" required :error="act.fieldErrors.value.findings" placeholder="例：意識清楚，呼吸喘，兩側下肺囉音，四肢冰冷" />
        <UTextarea v-model="f.actions" label="處置" :rows="2" required :error="act.fieldErrors.value.actions" placeholder="例：輸液 500 ml、抽血液培養與乳酸、氧氣面罩 6 L" />
        <div><USelect v-model="f.disposition" label="去向" :options="[{ label: '請選', value: '' }, { label: RRT_DISPOSITION_LABEL.stay, value: 'stay' }, { label: RRT_DISPOSITION_LABEL.icu, value: 'icu' }]" :error="act.fieldErrors.value.disposition" /></div>
        <template v-if="f.disposition === 'icu'">
          <div><USelect v-model="f.category" label="轉入類別" :options="[{ label: '請選', value: '' }, ...ICU_CATEGORIES.map((c) => ({ label: c.label, value: c.key }))]" :error="act.fieldErrors.value.category" /></div>
          <UTextarea v-model="f.reason" label="轉入原因" :rows="2" required :error="act.fieldErrors.value.reason" />
          <p class="text-xs text-slate-500">送出後建一筆轉入申請，由加護病房主治同意、排床（已經有申請在走的就接上那一筆）。</p>
        </template>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton type="submit" :loading="act.pending.value">儲存評估</UButton>
      </template>
    </UDialog>
  </div>
</template>
