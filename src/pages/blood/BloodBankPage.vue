<script setup lang="ts">
// 血庫（醫檢師）：
//   - 備血單：驗血型（和本院上次不同會擋下重抽）→ 交叉試驗配血（只列相容、沒過期的，同型、先到期的在前）→ 發血；
//     發血後 30 分鐘內還沒開始輸可以退回；配好的可以釋出（要原因）
//   - 血袋庫存：各血品血型可用量、效期快到的；入庫、報廢（過期、破損、發出超過 30 分鐘沒用）
import { computed, reactive, ref, watch } from 'vue'
import { PackagePlus } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UPageHeader, UQueryState, USelect, UTabs } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import {
  ABO_TYPES, BLOOD_DEFAULTS, BLOOD_PRODUCT_LABEL, BLOOD_PRODUCTS, bloodApi,
  type BloodIssueRow, type BloodRequestView, type BloodUnitView,
} from '@/services'
import type { Abo, BloodProduct, Rh } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import { addDays, today } from '@/utils/date'

const ui = useUi()
const tab = ref('requests')
const { data, loading } = useQuery(() => bloodApi.listBloodWork())
const tabs = computed(() => [
  { key: 'requests', label: '備血單', count: data.value?.requests.length || undefined },
  { key: 'units', label: '血袋庫存' },
])
const statusTone = (r: BloodRequestView) => (r.status === 'typing' || r.status === 'matching' ? 'yellow' : r.status === 'ready' ? 'blue' : r.status === 'transfusing' ? 'red' : r.status === 'done' ? 'green' : 'gray')

// ---------- 驗血型 ----------
const typing = reactive<Record<string, { abo?: string | number; rh?: string | number }>>({})
const typeAct = useAction(bloodApi.recordBloodTyping)
const typingOf = (id: string) => (typing[id] ??= { abo: '', rh: '' })
const typingFor = ref('')
async function saveTyping(r: BloodRequestView) {
  const t = typingOf(r.id)
  typingFor.value = r.id
  const res = await typeAct.run(r.id, { abo: String(t.abo ?? '') as Abo, rh: String(t.rh ?? '') as Rh })
  if (!res) return
  ui.toast.success(`已登錄血型 ${res.typingText}`)
  if (res.warning) ui.toast.warning(res.warning)
}

// ---------- 交叉試驗：選血袋 ----------
const matching = ref<BloodRequestView>()
const matchOpen = computed({ get: () => !!matching.value, set: (v) => !v && (matching.value = undefined) })
const { data: candidates } = useQuery(async () => (matching.value ? bloodApi.bloodCandidates(matching.value.id) : []), [() => matching.value?.id])
const picked = ref<string[]>([])
watch(() => matching.value?.id, () => (picked.value = []))
const need = computed(() => (matching.value ? matching.value.units - matching.value.rows.length : 0))
const toggle = (id: string, on: boolean) => (picked.value = on ? [...new Set([...picked.value, id])] : picked.value.filter((x) => x !== id))
const matchAct = useAction(bloodApi.crossmatchBlood, { success: (r) => `已配血：${r.rows.length}／${r.units} 袋` })
async function submitMatch() {
  if (matching.value && (await matchAct.run(matching.value.id, picked.value))) matching.value = undefined
}

// ---------- 發血、退回、釋出 ----------
const issueAct = useAction(bloodApi.issueBlood, { success: (r) => `已發血：${r.bedNo} ${r.patientName}，請護理站床邊雙人核對` })
type RowAction = { kind: 'return' | 'release'; r: BloodRequestView; x: BloodIssueRow }
const rowAction = ref<RowAction>()
const rowOpen = computed({ get: () => !!rowAction.value, set: (v) => !v && (rowAction.value = undefined) })
const returnAct = useAction(bloodApi.returnBlood, { success: '已退回血庫（仍配給這位病人）' })
const releaseAct = useAction(bloodApi.releaseBloodUnit, { success: '已釋出，血袋回到可用' })
async function confirmRow(reason: string) {
  const a = rowAction.value
  if (!a) return
  const ok = a.kind === 'return' ? await returnAct.run(a.r.id, a.x.unit.id, reason) : await releaseAct.run(a.r.id, a.x.unit.id, reason)
  if (ok) rowAction.value = undefined
}

// ---------- 入庫、報廢 ----------
const recvOpen = ref(false)
const recv = reactive({ product: 'rbc' as BloodProduct, abo: 'O' as string | number | undefined, rh: '+' as string | number | undefined, count: 1 as number | undefined, expiresOn: '', volume: 250 as number | undefined })
function openRecv() {
  Object.assign(recv, { product: 'rbc', abo: 'O', rh: '+', count: 1, expiresOn: addDays(today(), BLOOD_DEFAULTS.rbc.days), volume: BLOOD_DEFAULTS.rbc.volume })
  recvAct.fieldErrors.value = {}
  recvOpen.value = true
}
function pickProduct(p: BloodProduct) {
  recv.product = p
  recv.expiresOn = addDays(today(), BLOOD_DEFAULTS[p].days)
  recv.volume = BLOOD_DEFAULTS[p].volume
}
const recvAct = useAction(bloodApi.receiveBloodUnits, { success: (u) => `已入庫 ${u.length} 袋：${u[0]?.unitNo}${u.length > 1 ? `～${u.at(-1)?.unitNo}` : ''}` })
async function submitRecv() {
  const ok = await recvAct.run({ product: recv.product, abo: String(recv.abo) as Abo, rh: String(recv.rh) as Rh, count: Number(recv.count), expiresOn: recv.expiresOn, volume: Number(recv.volume) })
  if (ok) recvOpen.value = false
}
const scrapping = ref<BloodUnitView>()
const scrapOpen = computed({ get: () => !!scrapping.value, set: (v) => !v && (scrapping.value = undefined) })
const scrapAct = useAction(bloodApi.scrapBloodUnit, { success: '已報廢' })
async function confirmScrap(reason: string) {
  if (scrapping.value && (await scrapAct.run(scrapping.value.id, reason))) scrapping.value = undefined
}
const UNIT_STATUS: Record<BloodUnitView['status'], string> = { available: '可用', reserved: '已配血', issued: '已發出', transfused: '已輸', scrapped: '報廢' }
const productFilter = ref<string | number | undefined>('')
const shownUnits = computed(() => (data.value?.units ?? []).filter((u) => !productFilter.value || u.product === productFilter.value))
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="血庫" description="驗血型、交叉試驗配血、發血；血袋入庫與報廢" />
    <UTabs v-model="tab" :tabs="tabs" />
    <UQueryState :loading="loading && !data" :ready="!!data">
      <template v-if="data">
        <!-- 備血單 -->
        <div v-if="tab === 'requests'" class="space-y-3">
          <p v-if="!data.requests.length" class="text-sm text-slate-500">目前沒有待處理的備血單。</p>
          <section v-for="r in data.requests" :key="r.id" class="space-y-2 rounded-md border border-slate-300 bg-white p-3 text-sm">
            <div class="flex flex-wrap items-center gap-2">
              <b class="text-slate-800">{{ r.bedNo }} {{ r.patientName }}</b>
              <span class="tabular text-xs text-slate-500">{{ r.chartNo }}・{{ r.ward }}</span>
              <b>{{ r.productLabel }} {{ r.units }} 單位</b>
              <UBadge v-if="r.urgent" tone="red">急</UBadge>
              <UBadge :tone="statusTone(r)">{{ r.statusLabel }}</UBadge>
              <span class="tabular ml-auto text-xs text-slate-500">{{ r.no }}・{{ r.orderedAt.slice(5) }}・{{ r.doctorName }}</span>
            </div>
            <div class="text-xs text-slate-600">適應症：{{ r.indication }}<span v-if="r.labText">・{{ r.labText }}</span><span v-if="r.overReason" class="text-amber-800">・高於門檻：{{ r.overReason }}</span></div>

            <div v-if="r.status === 'typing'" class="flex flex-wrap items-end gap-2 rounded bg-amber-50 p-2">
              <div class="w-28"><USelect v-model="typingOf(r.id).abo" label="ABO" :options="ABO_TYPES" placeholder="選擇" /></div>
              <div class="w-28"><USelect v-model="typingOf(r.id).rh" label="Rh" :options="[{ label: 'Rh+', value: '+' }, { label: 'Rh−', value: '-' }]" placeholder="選擇" /></div>
              <UButton :loading="typeAct.pending.value" @click="saveTyping(r)">登錄血型</UButton>
              <span class="text-xs text-slate-600">{{ r.priorTypingText ? `本院先前：${r.priorTypingText}` : '本院沒驗過' }}<span v-if="r.selfReported">；病人資料（自述）{{ r.selfReported }} 型</span></span>
              <p v-if="typingFor === r.id && typeAct.fieldErrors.value.abo" class="w-full text-sm font-semibold text-red-700">{{ typeAct.fieldErrors.value.abo }}</p>
            </div>
            <div v-else class="text-xs text-slate-600">病人血型 <b class="text-slate-800">{{ r.typingText }}</b>（{{ r.typedByName }}）</div>

            <ul v-if="r.rows.length" class="space-y-1">
              <li v-for="x in r.rows" :key="x.unit.id" class="flex flex-wrap items-center gap-2 rounded border border-slate-200 px-2 py-1.5">
                <span class="tabular font-medium">{{ x.unit.unitNo }}</span>
                <span class="text-slate-600">{{ x.unit.typeText }}・效期 {{ x.unit.expiresOn }}</span>
                <UBadge v-if="x.unit.expired" tone="red">已過期</UBadge>
                <UBadge :tone="x.state === 'reserved' || x.state === 'returned' ? 'blue' : x.state === 'issued' ? 'yellow' : 'red'">{{ x.stateLabel }}</UBadge>
                <span v-if="x.issue && x.state === 'issued'" class="tabular text-xs text-slate-500">發血 {{ x.issue.issuedAt.slice(11) }}</span>
                <span class="ml-auto flex gap-1.5">
                  <template v-if="x.state === 'reserved' || x.state === 'returned'">
                    <UButton size="sm" :loading="issueAct.pending.value" @click="issueAct.run(r.id, x.unit.id)">發血</UButton>
                    <UButton size="sm" variant="ghost" @click="rowAction = { kind: 'release', r, x }">釋出</UButton>
                  </template>
                  <UButton v-if="x.canReturn" size="sm" variant="secondary" @click="rowAction = { kind: 'return', r, x }">退回血庫</UButton>
                </span>
              </li>
            </ul>
            <UButton v-if="r.status === 'matching'" size="sm" variant="secondary" @click="matching = r">交叉試驗配血（還差 {{ r.units - r.rows.length }} 袋）</UButton>
          </section>

          <details v-if="data.recent.length" class="rounded-md border border-slate-200 bg-white p-3 text-sm">
            <summary class="cursor-pointer text-slate-600">最近 24 小時完成或取消的 {{ data.recent.length }} 張</summary>
            <ul class="mt-2 divide-y divide-slate-100">
              <li v-for="r in data.recent" :key="r.id" class="py-1.5 text-xs text-slate-600">
                <span class="tabular">{{ r.no }}</span>　{{ r.patientName }}　{{ r.productLabel }} {{ r.units }} 單位　<UBadge :tone="statusTone(r)">{{ r.statusLabel }}</UBadge>
                <span v-if="r.cancelled">　{{ r.cancelled.reason }}</span>
              </li>
            </ul>
          </details>
        </div>

        <!-- 血袋庫存 -->
        <div v-else class="space-y-3">
          <div class="flex flex-wrap items-end gap-3">
            <div class="w-44"><USelect v-model="productFilter" label="血品" :options="[{ label: '全部', value: '' }, ...BLOOD_PRODUCTS.map((p) => ({ label: BLOOD_PRODUCT_LABEL[p], value: p }))]" /></div>
            <UButton class="ml-auto" :icon="PackagePlus" @click="openRecv">血袋入庫</UButton>
          </div>
          <div class="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))]">
            <section v-for="p in BLOOD_PRODUCTS" :key="p" class="rounded-md border border-slate-200 bg-white p-3 text-sm">
              <h3 class="mb-2 font-semibold text-slate-700">{{ BLOOD_PRODUCT_LABEL[p] }}・可用</h3>
              <div class="flex flex-wrap gap-1.5">
                <div v-for="s in data.stock.filter((x) => x.product === p)" :key="s.abo + s.rh" :class="['min-w-[4.5rem] rounded border px-2 py-1 text-center', s.available ? 'border-slate-200' : 'border-red-200 bg-red-50']">
                  <div class="text-xs text-slate-500">{{ s.abo }}{{ s.rh === '+' ? '+' : '−' }}</div>
                  <div class="tabular text-lg font-semibold text-slate-800">{{ s.available }}</div>
                  <div v-if="s.expiringSoon" class="whitespace-nowrap text-[11px] text-amber-700">{{ s.expiringSoon }} 快到期</div>
                </div>
              </div>
            </section>
          </div>
          <div class="overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table class="w-full text-sm">
              <thead class="whitespace-nowrap bg-slate-50 text-left text-xs text-slate-500">
                <tr><th class="px-3 py-2">血袋號</th><th class="px-3 py-2">血品</th><th class="px-3 py-2">血型</th><th class="px-3 py-2">效期</th><th class="px-3 py-2">狀態</th><th class="px-3 py-2"></th></tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                <tr v-for="u in shownUnits" :key="u.id">
                  <td class="tabular px-3 py-1.5">{{ u.unitNo }}</td>
                  <td class="whitespace-nowrap px-3 py-1.5">{{ u.productLabel }}</td>
                  <td class="whitespace-nowrap px-3 py-1.5">{{ u.typeText }}</td>
                  <td class="tabular px-3 py-1.5">{{ u.expiresOn }}
                    <UBadge v-if="u.expired" tone="red">已過期</UBadge><UBadge v-else-if="u.expiringSoon" tone="yellow">快到期</UBadge>
                  </td>
                  <td class="px-3 py-1.5">{{ UNIT_STATUS[u.status] }}<span v-if="u.forText" class="text-xs text-slate-500">（{{ u.forText }}）</span></td>
                  <td class="px-3 py-1.5 text-right"><UButton size="sm" variant="ghost" class="text-red-700" @click="scrapping = u">報廢</UButton></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </UQueryState>

    <UDialog v-model="matchOpen" :title="`交叉試驗配血：${matching?.patientName ?? ''}`" size="lg" @submit="submitMatch">
      <div v-if="matching" class="space-y-2 text-sm">
        <p>病人血型 <b>{{ matching.typingText }}</b>・{{ matching.productLabel }}・還差 <b>{{ need }}</b> 袋（已選 {{ picked.length }}）</p>
        <p v-if="!candidates?.length" class="text-red-700">沒有相容、可用的血袋：請向捐血中心訂血。</p>
        <ul class="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200">
          <li v-for="u in candidates ?? []" :key="u.id" class="flex items-center gap-2 px-3 py-1.5">
            <UCheckbox :model-value="picked.includes(u.id)" :label="`${u.unitNo}　${u.typeText}　${u.volume} ml　效期 ${u.expiresOn}`" @update:model-value="(v) => toggle(u.id, v)" />
            <UBadge v-if="u.typeText === matching.typingText" tone="green">同型</UBadge>
            <UBadge v-if="u.expiringSoon" tone="yellow">快到期</UBadge>
          </li>
        </ul>
        <p v-if="matchAct.fieldErrors.value.units" class="text-xs text-red-600">{{ matchAct.fieldErrors.value.units }}</p>
        <p class="text-xs text-slate-500">只列相容、沒過期的；同型的在前，再依效期（先到期的先用）。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="matchOpen = false">取消</UButton>
        <UButton type="submit" :disabled="!picked.length" :loading="matchAct.pending.value">配血（{{ picked.length }} 袋）</UButton>
      </template>
    </UDialog>

    <UDialog v-model="recvOpen" title="血袋入庫" @submit="submitRecv">
      <div class="space-y-3">
        <fieldset class="flex flex-wrap gap-4 text-sm">
          <label v-for="p in BLOOD_PRODUCTS" :key="p" class="flex items-center gap-1.5">
            <input :checked="recv.product === p" type="radio" name="recv-product" class="h-4 w-4 text-brand-600" @change="pickProduct(p)" />{{ BLOOD_PRODUCT_LABEL[p] }}
          </label>
        </fieldset>
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <USelect v-model="recv.abo" label="ABO" :options="ABO_TYPES" required :error="recvAct.fieldErrors.value.abo" />
          <USelect v-model="recv.rh" label="Rh" :options="[{ label: 'Rh+', value: '+' }, { label: 'Rh−', value: '-' }]" required :error="recvAct.fieldErrors.value.rh" />
          <UInput v-model="recv.count" type="number" label="袋數" required :error="recvAct.fieldErrors.value.count" />
          <UInput v-model="recv.expiresOn" type="date" label="效期" required :error="recvAct.fieldErrors.value.expiresOn" />
          <UInput v-model="recv.volume" type="number" label="每袋 ml" required :error="recvAct.fieldErrors.value.volume" />
        </div>
        <p class="text-xs text-slate-500">每袋給一個血袋號（條碼），護理站床邊掃描用。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="recvOpen = false">取消</UButton>
        <UButton type="submit" :loading="recvAct.pending.value">入庫</UButton>
      </template>
    </UDialog>

    <ReasonDialog
      v-model="rowOpen"
      :title="rowAction?.kind === 'return' ? '退回血庫' : '釋出配血'"
      :subject="rowAction ? `${rowAction.r.patientName}・血袋 ${rowAction.x.unit.unitNo}` : ''"
      :label="rowAction?.kind === 'return' ? '退回原因（30 分鐘內、還沒開始輸）' : '釋出原因（血袋回到可用）'"
      :presets="rowAction?.kind === 'return' ? ['病人暫時不輸', '病人外出檢查', '發錯病房'] : ['交叉試驗結果不合', '醫師改變治療計畫', '改配同型血']"
      :ok-text="rowAction?.kind === 'return' ? '退回' : '釋出'"
      :pending="returnAct.pending.value || releaseAct.pending.value"
      :error="(rowAction?.kind === 'return' ? returnAct : releaseAct).fieldErrors.value.reason"
      @confirm="confirmRow"
    />
    <ReasonDialog
      v-model="scrapOpen"
      title="血袋報廢"
      :subject="scrapping ? `${scrapping.unitNo} ${scrapping.productLabel} ${scrapping.typeText}（效期 ${scrapping.expiresOn}）` : ''"
      label="報廢原因"
      :presets="['過期', '血袋破損', '發出超過 30 分鐘未使用', '溫度異常']"
      ok-text="報廢"
      danger
      :pending="scrapAct.pending.value"
      :error="scrapAct.fieldErrors.value.reason"
      @confirm="confirmScrap"
    />
  </div>
</template>
