<script setup lang="ts">
// 住院藥局：UD（Unit Dose）調劑、核對與退藥點收。
//   - 補調劑（今天）：今天才開的醫囑、還沒調劑的今天劑量——護理師在等，排最上面
//   - 每日調劑（明天）：每天下午把明天整天的劑量調好
//   - 待核對：逐位病人的藥盒核對，通過才扣帳、送病房；發現錯誤退回重調（雙人核對開啟時調劑的人不能自己核對）
//   - 待退藥：病房送回來的（暫停、拒絕、醫囑停止、出院）由藥師點收入庫；還沒送回的另外列出供參考
//   - 病房回報：藥車點收時發現不符（短少、破損、不是這位病人的），藥師處理後寫說明（補發走上面的調劑流程）
// 每劑幾個、哪些要退都由服務層算（ud-rules、ud-work）；頁面送出的是畫面上看得到的那幾劑。
import { computed, reactive, ref, watch } from 'vue'
import { AlertTriangle, ClipboardCheck, PackageCheck, PillBottle, Undo2 } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UDialog, UEmpty, UInput, UQueryState } from '@/components/ui'
import { udApi, type UdIssueRow, type UdReturnRow, type UdVerifyBox, type UdWorkGroup } from '@/services'
import ReasonDialog from '@/components/ReasonDialog.vue'
import WardRefillCard from './components/WardRefillCard.vue'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'

const ui = useUi()
const { data: w, loading } = useQuery(() => udApi.getUdWork(), [])
const md = (s: string) => s.slice(5, 10).replace('-', '/')

// 無法換算的藥（胰島素筆、眼藥水）：藥師填發多少；0＝床邊已有
const qtys = reactive<Record<string, number | undefined>>({})

type Kind = 'extra' | 'daily'
const sections = computed(() =>
  w.value
    ? ([
        { kind: 'extra', title: `補調劑・今天 ${md(w.value.today)}`, hint: '今天才開的醫囑、還沒調劑的今天劑量：護理師在等，請優先處理', groups: w.value.extra },
        { kind: 'daily', title: `每日調劑・明天 ${md(w.value.tomorrow)}`, hint: '明天整天的劑量，調好後送病房', groups: w.value.daily },
      ] as const)
    : [],
)
const doseCount = (gs: readonly UdWorkGroup[]) => gs.reduce((n, g) => n + g.lines.reduce((s, l) => s + l.marIds.length, 0), 0)

const run = useAction(udApi.dispenseUd, { success: (r) => `已調劑 ${r.no}：${r.patients} 位病人、${r.lines} 項，請逐位核對後送病房` })
const errOf = (orderId: string) => run.fieldErrors.value[`qty.${orderId}`]
async function dispense(kind: Kind, groups: readonly UdWorkGroup[]) {
  const lines = groups.flatMap((g) => g.lines)
  if (groups.length > 1) {
    const ok = await ui.confirm({ title: kind === 'daily' ? '每日調劑' : '補調劑', message: `調劑 ${groups.length} 位病人、${lines.length} 項（${doseCount(groups)} 劑）？調好後逐位核對，核對通過才從${w.value?.locationName}扣庫存、送病房。`, okText: '調劑' })
    if (!ok) return
  }
  const q: Record<string, number> = {}
  for (const l of lines) if (!l.perDose && qtys[l.orderId] !== undefined) q[l.orderId] = qtys[l.orderId]!
  if (await run.run({ kind, marIds: lines.flatMap((l) => l.marIds), qtys: q })) for (const l of lines) delete qtys[l.orderId]
}

// ---------- 核對 ----------
const verify = useAction(udApi.verifyUdBox, { success: (r) => `已核對 ${r.patientName}（${r.no}），送病房` })
const rejecting = ref<UdVerifyBox | null>(null)
const rejectOpen = computed({ get: () => !!rejecting.value, set: (v) => !v && (rejecting.value = null) })
const reject = useAction(udApi.rejectUdBox, { success: '已退回重調：這位病人的劑量回到待調劑' })
async function confirmReject(reason: string) {
  if (rejecting.value && (await reject.run(rejecting.value.dispenseId, rejecting.value.admissionId, reason))) rejecting.value = null
}

// ---------- 病房回報（藥盒不符）：寫處理說明，需要時逐行補發（扣住院藥局；那幾劑不會再出現在補調劑）----------
const resolving = ref<UdIssueRow | null>(null)
const resolveOpen = computed({ get: () => !!resolving.value, set: (v) => !v && (resolving.value = null) })
const rsForm = reactive<{ resolution: string; resupply: Record<string, number | undefined> }>({ resolution: '', resupply: {} })
function openResolve(i: UdIssueRow) {
  Object.assign(rsForm, { resolution: '', resupply: {} })
  resolve.fieldErrors.value = {}
  resolving.value = i
}
const resolve = useAction(udApi.resolveUdIssue, { success: (r) => `已處理 ${r.no} 的病房回報${r.resupplied ? `，補發 ${r.resupplied}` : ''}` })
async function confirmResolve() {
  const x = resolving.value
  if (!x) return
  const resupply: Record<string, number> = {}
  for (const [k, v] of Object.entries(rsForm.resupply)) if (v !== undefined && String(v) !== '') resupply[k] = Number(v)
  if (await resolve.run(x.dispenseId, x.admissionId, { resolution: rsForm.resolution, resupply })) resolving.value = null
}

// ---------- 退藥點收 ----------
const returning = ref<UdReturnRow | null>(null)
const returnOpen = computed({ get: () => !!returning.value, set: (v) => !v && (returning.value = null) })
const form = reactive<{ qty?: number; reason: string }>({ qty: undefined, reason: '' })
watch(returning, (r) => Object.assign(form, { qty: r?.expected, reason: '' }))
const short = computed(() => (returning.value && form.qty !== undefined ? returning.value.expected - form.qty : 0))
const receive = useAction(udApi.receiveUdReturn, { success: (r) => `已點收退藥 ${r.qty}${r.qty < r.expected ? `（短少 ${r.expected - r.qty}）` : ''}` })
async function confirmReturn() {
  if (returning.value && (await receive.run(returning.value.lineId, { qty: form.qty as number, reason: form.reason }))) returning.value = null
}
</script>

<template>
  <div class="space-y-4">
    <UQueryState :loading="loading && !w" :ready="!!w">
      <template v-if="w">
        <p class="text-sm text-slate-600">
          扣帳地點：<b>{{ w.locationName }}</b>・PRN 與臨時（STAT）給藥用病房常備藥，護理師給藥時直接扣，不在這裡調劑
        </p>

        <UCard v-if="w.issues.length" :padded="false" class="border-red-300">
          <template #title>
            <div class="flex items-center gap-2 text-sm font-semibold text-red-800"><AlertTriangle class="h-4 w-4" />病房回報：藥盒不符<UBadge tone="red">{{ w.issues.length }} 盒</UBadge></div>
            <div class="text-xs text-slate-500">藥車點收時發現的問題：處理時可以補發（從{{ w.locationName }}扣），寫處理說明</div>
          </template>
          <ul class="divide-y divide-slate-100">
            <li v-for="i in w.issues" :key="`${i.dispenseId}|${i.admissionId}`" class="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <span class="tabular w-24 text-xs font-semibold text-brand-700">{{ i.ward.split(' ')[0] }} {{ i.bedNo }}</span>
              <div class="min-w-0 flex-1">
                <div class="font-medium text-slate-800">{{ i.patientName }}・<UBadge tone="red">{{ i.cause }}</UBadge> {{ i.note }}</div>
                <div class="text-xs text-slate-500">{{ i.no }}・{{ i.items.join('、') }}・{{ i.reportedByName }} {{ i.reportedAt.slice(5, 16).replace('-', '/') }} 回報</div>
              </div>
              <UButton size="sm" variant="secondary" @click="openResolve(i)">處理</UButton>
            </li>
          </ul>
        </UCard>

        <UCard v-for="sec in sections" :key="sec.kind" :padded="false" :class="sec.kind === 'extra' && sec.groups.length ? 'border-amber-300' : ''">
          <template #title>
            <div class="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <AlertTriangle v-if="sec.kind === 'extra' && sec.groups.length" class="h-4 w-4 text-amber-600" />
              {{ sec.title }}
              <UBadge v-if="sec.groups.length" :tone="sec.kind === 'extra' ? 'yellow' : 'blue'">{{ sec.groups.length }} 位病人・{{ doseCount(sec.groups) }} 劑</UBadge>
            </div>
            <div class="text-xs text-slate-500">{{ sec.hint }}</div>
          </template>
          <template v-if="sec.groups.length > 1" #actions>
            <UButton size="sm" :icon="PillBottle" :loading="run.pending.value" @click="dispense(sec.kind, sec.groups)">全部調劑</UButton>
          </template>
          <UEmpty v-if="!sec.groups.length" :title="sec.kind === 'extra' ? '今天的劑量都已調劑' : '明天的劑量都已調劑'" class="py-6" />
          <div v-for="g in sec.groups" :key="g.admissionId" class="border-t border-slate-100 first:border-t-0">
            <div class="flex flex-wrap items-center gap-2 bg-slate-50 px-4 py-2 text-sm">
              <span class="tabular font-semibold text-brand-700">{{ g.bedNo }}</span>
              <span class="font-medium text-slate-800">{{ g.patientName }}</span>
              <span class="text-xs text-slate-500">{{ g.chartNo }}・{{ g.admitNo }}</span>
              <UBadge v-if="g.allergies.length" tone="red">過敏：{{ g.allergies.join('、') }}</UBadge>
              <UButton size="sm" variant="secondary" class="ml-auto" :icon="PillBottle" :loading="run.pending.value" @click="dispense(sec.kind, [g])">調劑</UButton>
            </div>
            <table class="tabular w-full text-sm">
              <tbody>
                <tr v-for="l in g.lines" :key="l.orderId" class="border-t border-slate-100 align-top">
                  <td class="px-4 py-2">
                    <div class="flex flex-wrap items-center gap-1 font-medium text-slate-800">
                      {{ l.drugName }}
                      <UBadge v-if="l.highAlert" tone="purple">高警訊</UBadge>
                      <UBadge v-if="l.pendingQuery" tone="yellow" :title="`護理師疑問：${l.pendingQuery}`">醫囑有疑問</UBadge>
                    </div>
                    <div class="text-xs text-slate-500">{{ l.drugNameZh }}・{{ l.spec }}</div>
                  </td>
                  <td class="px-3 py-2 text-slate-700">
                    每次 {{ l.dose }} {{ l.doseUnit }}・{{ l.freqLabel }}・{{ l.route }}
                    <div class="text-xs text-slate-500">{{ l.times.map((t) => t.slice(6)).join('、') }}（{{ l.marIds.length }} 劑）</div>
                  </td>
                  <td class="w-44 px-3 py-2 text-right">
                    <template v-if="l.perDose">
                      <span class="text-base font-semibold">{{ l.qty }}</span> {{ l.unit }}
                    </template>
                    <div v-else class="text-left">
                      <UInput v-model="qtys[l.orderId]" type="number" min="0" :label="`發幾 ${l.unit}`" hint="無法逐劑換算；床邊已有填 0" :error="errOf(l.orderId)" />
                    </div>
                    <div :class="['text-xs', l.counting ? 'text-violet-700' : l.perDose && (l.available ?? 0) < (l.qty ?? 0) ? 'font-semibold text-red-600' : 'text-slate-500']">
                      <template v-if="l.counting">盤點中（{{ l.counting }}）</template>
                      <template v-else>可用 {{ l.available }}</template>
                    </div>
                    <div v-if="l.perDose && errOf(l.orderId)" class="text-xs text-red-600">{{ errOf(l.orderId) }}</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </UCard>

        <UCard :padded="false" :class="w.verify.length ? 'border-sky-300' : ''">
          <template #title>
            <div class="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <ClipboardCheck class="h-4 w-4 text-sky-600" />待核對
              <UBadge v-if="w.verify.length" tone="blue">{{ w.verify.length }} 位病人</UBadge>
            </div>
            <div class="text-xs text-slate-500">逐位病人核對藥盒：通過才扣{{ w.locationName }}、送病房，護理師才能給；發現錯誤退回重調</div>
          </template>
          <UEmpty v-if="!w.verify.length" title="沒有待核對的藥盒" class="py-6" />
          <div v-for="b in w.verify" :key="b.dispenseId + b.admissionId" class="border-t border-slate-100 first:border-t-0">
            <div class="flex flex-wrap items-center gap-2 bg-slate-50 px-4 py-2 text-sm">
              <span class="tabular font-semibold text-brand-700">{{ b.bedNo }}</span>
              <span class="font-medium text-slate-800">{{ b.patientName }}</span>
              <UBadge v-if="b.allergies.length" tone="red">過敏：{{ b.allergies.join('、') }}</UBadge>
              <span class="text-xs text-slate-500">{{ b.no }}・{{ b.kind === 'daily' ? '每日調劑' : '補調劑' }}・{{ b.preparedByName }} {{ b.preparedAt.slice(11) }} 調劑</span>
              <div class="ml-auto flex gap-1.5">
                <UButton size="sm" variant="ghost" @click="rejecting = b">退回重調</UButton>
                <UButton size="sm" :icon="ClipboardCheck" :disabled="!!b.blocked" :title="b.blocked" :loading="verify.pending.value" @click="verify.run(b.dispenseId, b.admissionId)">核對送出</UButton>
              </div>
              <p v-if="b.blocked" class="w-full text-right text-xs text-amber-700" role="status">{{ b.blocked }}</p>
            </div>
            <ul class="divide-y divide-slate-100">
              <li v-for="l in b.lines" :key="l.lineId" class="flex flex-wrap items-center gap-3 px-4 py-1.5 text-sm">
                <span class="min-w-0 flex-1">
                  <span class="font-medium text-slate-800">{{ l.drugName }}</span><UBadge v-if="l.highAlert" tone="purple" class="ml-1">高警訊</UBadge>
                  <span class="block text-xs text-slate-500">每次 {{ l.dose }} {{ l.doseUnit }}・{{ l.freqLabel }}・{{ l.route }}・{{ l.times.map((t) => t.slice(6)).join('、') }}</span>
                </span>
                <span class="tabular"><b>{{ l.qty }}</b> {{ l.unit }}</span>
              </li>
            </ul>
          </div>
        </UCard>

        <WardRefillCard />

        <UCard :padded="false">
          <template #title>
            <div class="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Undo2 class="h-4 w-4 text-slate-500" />待退藥點收
              <UBadge v-if="w.returns.length" tone="yellow">{{ w.returns.length }} 項</UBadge>
            </div>
            <div class="text-xs text-slate-500">病房送回來的（暫停、拒絕、醫囑停止、出院）：點收入庫，退回原批號</div>
          </template>
          <UEmpty v-if="!w.returns.length" title="沒有已送回待點收的藥" class="py-6" />
          <ul v-else class="divide-y divide-slate-100">
            <li v-for="r in w.returns" :key="r.lineId" class="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <span class="tabular w-14 font-semibold text-brand-700">{{ r.bedNo || '—' }}</span>
              <div class="min-w-0 flex-1">
                <div class="font-medium text-slate-800">{{ r.patientName }}・{{ r.drugName }}</div>
                <div class="text-xs text-slate-500">{{ r.no }}・{{ r.causes }}・{{ r.sentByName }} {{ r.sentAt?.slice(5, 16).replace('-', '/') }} 送回</div>
              </div>
              <span class="tabular">應退 <b class="text-base">{{ r.expected }}</b> {{ r.unit }}</span>
              <UButton size="sm" variant="secondary" :icon="PackageCheck" @click="returning = r">點收</UButton>
            </li>
          </ul>
        </UCard>

        <details v-if="w.awaitingWard.length" class="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm">
          <summary class="cursor-pointer font-medium text-slate-700">病房還沒送回的（{{ w.awaitingWard.length }} 項，參考；病房按「送回藥局」後才會出現在待點收）</summary>
          <ul class="mt-2 divide-y divide-slate-100">
            <li v-for="r in w.awaitingWard" :key="r.lineId" class="flex flex-wrap gap-3 py-1.5">
              <span class="tabular w-24 text-xs text-slate-500">{{ r.ward.split(' ')[0] }} {{ r.bedNo }}</span>
              <span class="min-w-0 flex-1">{{ r.patientName }}<UBadge v-if="r.discharged" tone="gray" class="ml-1">已出院</UBadge>・{{ r.drugName }}<span class="ml-1 text-xs text-slate-500">{{ r.causes }}</span></span>
              <span class="tabular">{{ r.expected }} {{ r.unit }}</span>
            </li>
          </ul>
        </details>

        <UCard :padded="false">
          <template #title><span class="text-sm font-semibold text-slate-800">最近的調劑</span></template>
          <UEmpty v-if="!w.recent.length" title="還沒有調劑紀錄" class="py-6" />
          <table v-else class="tabular w-full text-sm">
            <thead class="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th class="px-4 py-2 text-left">單號</th>
                <th class="px-3 py-2 text-left">類別</th>
                <th class="px-3 py-2 text-left">時間</th>
                <th class="px-3 py-2 text-left">藥師</th>
                <th class="px-3 py-2 text-right">已核對／病人／項目</th>
                <th class="px-3 py-2 text-right">已退回</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in w.recent" :key="u.id" class="border-t border-slate-100">
                <td class="px-4 py-2 font-medium text-slate-800">{{ u.no }}</td>
                <td class="px-3 py-2"><UBadge :tone="u.kind === 'daily' ? 'blue' : 'yellow'">{{ u.kind === 'daily' ? '每日調劑' : '補調劑' }}</UBadge></td>
                <td class="px-3 py-2 text-slate-600">{{ u.dispensedAt.slice(5, 16).replace('-', '/') }}</td>
                <td class="px-3 py-2 text-slate-600">{{ u.dispensedByName }}</td>
                <td class="px-3 py-2 text-right">{{ u.verified }}／{{ u.patients }}／{{ u.lines }}</td>
                <td class="px-3 py-2 text-right text-slate-500">{{ u.returned || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </UCard>
      </template>
    </UQueryState>

    <ReasonDialog
      v-model="rejectOpen"
      title="退回重調"
      :subject="rejecting ? `${rejecting.bedNo} ${rejecting.patientName}・${rejecting.no}` : ''"
      label="退回原因（調劑的藥師會看到）"
      :presets="['劑量放錯', '少一顆', '藥品放錯藥盒', '標示不清']"
      ok-text="退回重調"
      :pending="reject.pending.value"
      :error="reject.fieldErrors.value.reason"
      @confirm="confirmReject"
    />
    <UDialog v-model="resolveOpen" title="處理病房回報" size="sm" @submit="confirmResolve">
      <div v-if="resolving" class="space-y-3 text-sm">
        <div class="rounded-md bg-red-50 px-3 py-2">
          <div class="font-semibold text-slate-800">{{ resolving.bedNo }} {{ resolving.patientName }}・{{ resolving.no }}</div>
          <div class="text-xs text-red-800">{{ resolving.cause }}<template v-if="resolving.note">：{{ resolving.note }}</template>（{{ resolving.reportedByName }} 回報）</div>
        </div>
        <div>
          <p class="mb-1 text-xs font-medium text-slate-600">補發（選填；從{{ w?.locationName }}扣，同一張單號）</p>
          <div v-for="l in resolving.lines" :key="l.lineId" class="flex items-center gap-2 py-0.5">
            <span class="min-w-0 flex-1 truncate">{{ l.drugName }}<span class="ml-1 text-xs text-slate-400">原發 {{ l.qty }} {{ l.unit }}</span></span>
            <div class="w-20"><UInput v-model="rsForm.resupply[l.lineId]" type="number" min="0" placeholder="0" :error="resolve.fieldErrors.value[`resupply.${l.lineId}`]" /></div>
            <span class="w-10 text-xs text-slate-500">{{ l.unit }}</span>
          </div>
        </div>
        <UInput v-model="rsForm.resolution" label="處理說明" required placeholder="例：已補發 1 顆、已更換藥盒、病房已找到" :error="resolve.fieldErrors.value.resolution" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="resolving = null">取消</UButton>
        <UButton type="submit" :loading="resolve.pending.value">處理完成</UButton>
      </template>
    </UDialog>
    <UDialog v-model="returnOpen" title="退藥點收" size="sm" @submit="confirmReturn">
      <div v-if="returning" class="space-y-3 text-sm">
        <div class="rounded-md bg-slate-50 px-3 py-2">
          <div class="font-semibold text-slate-800">{{ returning.bedNo }} {{ returning.patientName }}・{{ returning.drugName }}</div>
          <div class="text-xs text-slate-500">{{ returning.no }}・{{ returning.causes }}・應退 {{ returning.expected }} {{ returning.unit }}</div>
        </div>
        <UInput v-model="form.qty" type="number" min="0" :label="`實收（${returning.unit}）`" required :error="receive.fieldErrors.value.qty" />
        <UInput v-if="short > 0" v-model="form.reason" :label="`短少 ${short} 的原因`" placeholder="例：破損、遺失、病人已帶回" required :error="receive.fieldErrors.value.reason" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="returning = null">取消</UButton>
        <UButton type="submit" :icon="PackageCheck" :loading="receive.pending.value">點收入庫</UButton>
      </template>
    </UDialog>
  </div>
</template>
