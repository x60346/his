<script setup lang="ts">
// 門診藥局：調劑清單（依領藥號）→ 調劑單 → 核對 → 發藥；缺藥可申請補貨、列印藥袋。
// 兩段式（核對、發藥）是用藥安全的標準流程；扣庫存只在發藥時發生，且整筆交易（任一藥不足就全部不扣）。
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { computed, ref, watch } from 'vue'
import { AlertTriangle, CheckCheck, ClipboardCheck, PackagePlus, Printer } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UCheckbox, UDialog, UEmpty, UInput, UQueryState, UStatusBadge, UTabs } from '@/components/ui'
import PatientBanner from '@/components/PatientBanner.vue'
import DrugBagLabels from './components/DrugBagLabels.vue'
import RestockRequestDialog from '@/components/RestockRequestDialog.vue'
import { pharmacyApi } from '@/services'
import type { DispenseItem } from '@/services/pharmacy'
import { useAction, useQuery } from '@/composables/useService'
import { followToday } from '@/composables/useClock'
import { diffDays, today } from '@/utils/date'
import { dispenseStatus } from '@/utils/labels'
import type { DispenseStatus } from '@/types'

// ---------- 清單 ----------
const date = ref(today())
const todayStr = followToday(date) // 原本看今天的，跨日時自動換到新的一天
const { data: all, loading } = useQuery(() => pharmacyApi.listDispenses({ date: date.value }), [date])
const tab = ref<DispenseStatus>('pending')
// 搜尋：病人遞上領藥單時，輸入領藥號按 Enter 就選中，不必捲清單找。三個分頁一起篩，分頁數字跟著變
const kw = ref('')
// 1–3 位數字當領藥號（完全相符）；4 位以上才比對病歷號——否則打「4」會連病歷號含 4 的人都找出來，Enter 就選不到唯一一筆
const matches = (x: { pickupNo: number; patientName: string; chartNo: string }, k: string) => {
  if (!k) return true
  if (/^\d{1,3}$/.test(k)) return String(x.pickupNo) === k
  return x.patientName.includes(k) || x.chartNo.includes(k)
}
const searched = computed(() => (all.value ?? []).filter((d) => matches(d, kw.value.trim())))
const tabs = computed(() =>
  (['pending', 'verified', 'dispensed'] as DispenseStatus[]).map((s) => ({ key: s, label: dispenseStatus[s].label, count: searched.value.filter((d) => d.status === s).length })),
)
const list = computed(() => searched.value.filter((d) => d.status === tab.value))
/** Enter：只有一筆符合就直接選中（分頁由下方的 watch 跟著那張單切過去）；多筆就留給使用者從清單點 */
function onSearchEnter() {
  const hit = searched.value
  if (hit.length === 1) {
    selectedId.value = hit[0].id
    tab.value = hit[0].status // 明確切過去：若前一張選的單狀態相同，下面跟著狀態切分頁的 watch 不會觸發
  } else if (hit.length > 1 && !list.value.length) tab.value = hit[0].status
}
// 前幾日開立、還沒領的單（服務層排在當天的後面）。領藥號每天重編，要標日期才分得出是哪一天的「3 號」
const createdDay = (x: { createdAt: string }) => x.createdAt.slice(0, 10)
const isCarried = (x: { createdAt: string; status: DispenseStatus }) => x.status !== 'dispensed' && createdDay(x) < date.value
/** 一般處方箋 3 日內有效：滿 3 天提醒（不擋，是否需重新看診由藥師判斷） */
const ageDays = (x: { createdAt: string }) => diffDays(createdDay(x), todayStr.value)

const selectedId = ref<string>()
useRevealOnNarrow(selectedId) // 窄螢幕點選後把明細捲進畫面
watch(date, () => (selectedId.value = undefined))

// 右側以 id 直接查最新的調劑單（不依賴清單上可能過期的狀態）
const { data: detail, loading: detailLoading } = useQuery(async () => (selectedId.value ? pharmacyApi.getDispense(selectedId.value) : undefined), [selectedId])
const d = computed(() => (detail.value?.id === selectedId.value ? detail.value : undefined))
const shortages = computed(() => (d.value?.items ?? []).filter((i) => i.shortage))

// 分頁跟著「選中那張單」的狀態走：核對後它移到「已核對」、發藥後移到「已發藥」，分頁就跟過去，
// 右邊顯示的病人一定找得到在左邊哪個清單。使用者自己切分頁時，單的狀態沒變，不會被拉回來。
watch(
  () => d.value?.status,
  (s) => {
    if (s) tab.value = s
  },
)

// ---------- 核對、發藥 ----------
const verify = useAction(pharmacyApi.verifyDispense, { success: (x) => `領藥號 ${x.pickupNo} 核對完成` })
const give = useAction(pharmacyApi.dispense, { success: (x) => `領藥號 ${x.pickupNo} 已發藥給 ${x.patientName}` })

/** 下一張待處理的單：發藥後自動帶到下一位，減少點擊 */
const nextPending = computed(() => (all.value ?? []).find((x) => x.status !== 'dispensed' && x.id !== selectedId.value))
// ---------- 發藥前確認身分：請病人說出出生月日，或登記代領人（比對在服務層） ----------
const pickupOpen = ref(false)
const pickup = ref({ proxy: false, birthMMDD: '', proxyName: '', relation: '' })
function onDispense() {
  if (!d.value) return
  give.fieldErrors.value = {}
  pickup.value = { proxy: false, birthMMDD: '', proxyName: '', relation: '' }
  pickupOpen.value = true
}
async function confirmPickup() {
  if (!d.value) return
  const p = pickup.value
  const check = p.proxy ? { proxy: true, proxyName: p.proxyName, relation: p.relation } : { birthMMDD: p.birthMMDD.trim() }
  if (await give.run(d.value.id, check)) {
    pickupOpen.value = false
    // 自動帶到下一張；分頁由上面的 watch 跟著那張單的狀態切換
    if (nextPending.value) selectedId.value = nextPending.value.id
  }
}

// ---------- 補貨申請（U25） ----------
// 窗口只提出申請（數量）；批號、效期等貨到了在藥品庫存頁「到貨入庫」時才填
const restockOpen = ref(false)
const restockItem = ref<DispenseItem>()
function openRestock(it: DispenseItem) {
  restockItem.value = it
  restockOpen.value = true
}

// ---------- 藥袋 ----------
const bagOpen = ref(false)
const print = () => window.print()
</script>

<template>
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-[21rem_1fr]">
    <!-- 清單 -->
    <UCard :padded="false" class="no-print self-start">
      <template #title><span class="text-sm font-semibold text-slate-800">調劑清單</span></template>
      <template #actions><div class="w-40"><UInput v-model="date" type="date" :max="todayStr" /></div></template>
      <div class="px-3 pt-2"><UInput v-model="kw" placeholder="領藥號、姓名、病歷號（Enter 選取）" aria-label="搜尋調劑單" @keydown.enter.prevent="onSearchEnter" /></div>
      <div class="px-3"><UTabs v-model="tab" :tabs="tabs" /></div>
      <UQueryState :loading="loading" :ready="list.length > 0" :empty-title="kw.trim() ? `沒有符合「${kw.trim()}」的${dispenseStatus[tab].label}單` : `沒有${dispenseStatus[tab].label}的單`">
      <ul class="max-h-[calc(100vh-15rem)] divide-y divide-slate-100 overflow-y-auto">
        <li v-for="(x, i) in list" :key="x.id">
          <div v-if="isCarried(x) && (i === 0 || !isCarried(list[i - 1]))" class="bg-slate-50 px-3 py-1 text-xs font-medium text-slate-500">前幾日未領</div>
          <button :class="['flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50', x.id === selectedId && '!bg-brand-50']" @click="selectedId = x.id">
            <span class="tabular w-10 text-center leading-tight">
              <span v-if="createdDay(x) !== date" class="block text-[11px] font-medium text-slate-500">{{ createdDay(x).slice(5).replace('-', '/') }}</span>
              <span class="text-2xl font-bold text-brand-600">{{ x.pickupNo }}</span>
            </span>
            <span class="min-w-0 flex-1">
              <span class="block font-medium text-slate-800">{{ x.patientName }}</span>
              <span class="block truncate text-xs text-slate-500">{{ x.deptName }}・{{ x.items.length }} 項藥品</span>
              <UBadge v-if="x.status !== 'dispensed' && ageDays(x) >= 3" tone="yellow" class="mt-0.5">已開立 {{ ageDays(x) }} 天</UBadge>
            </span>
            <span class="flex flex-col items-end gap-1">
              <AlertTriangle v-if="x.allergyWarnings.length" class="h-4 w-4 text-red-500" aria-label="過敏警示" />
              <UBadge v-if="x.items.some((i) => i.shortage)" :tone="x.items.every((i) => !i.shortage || i.restock?.includesThis) ? 'blue' : 'red'">{{ x.items.every((i) => !i.shortage || i.restock?.includesThis) ? '待補貨' : '缺藥' }}</UBadge>
            </span>
          </button>
        </li>
      </ul>
      </UQueryState>
    </UCard>

    <!-- 調劑單 -->
    <UCard v-if="!selectedId" data-detail class="no-print"><UEmpty title="請從清單選擇調劑單" description="依領藥號順序處理" /></UCard>
    <UCard v-else-if="!d" data-detail class="no-print"><UQueryState :loading="detailLoading" :ready="false" empty-title="找不到這張調劑單" /></UCard>
    <div v-else data-detail class="no-print min-w-0 space-y-3">
      <PatientBanner :patient="d">
        <UBadge tone="blue">領藥號 {{ createdDay(d) !== todayStr ? createdDay(d).slice(5).replace('-', '/') + '・' : '' }}{{ d.pickupNo }}</UBadge>
        <UStatusBadge :map="dispenseStatus" :value="d.status" />
      </PatientBanner>

      <!-- 多重把關：醫師開藥時已提醒過，藥師這一關再顯示一次 -->
      <div v-if="d.allergyWarnings.length" class="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div class="font-semibold">過敏警示：請確認醫師已評估後再調劑</div>
          <div v-for="w in d.allergyWarnings" :key="w.drugId">{{ w.drugName }}：病人對 {{ w.allergen }} 過敏</div>
        </div>
      </div>

      <UCard :padded="false">
        <template #title>
          <div class="text-sm font-semibold text-slate-800">處方內容<span v-if="d.refillSeq" class="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-800">慢箋第 {{ d.refillSeq }} 次</span></div>
          <div class="text-xs text-slate-500">{{ d.deptName }}・{{ d.doctorName }}｜診斷：{{ d.diagnoses.join('、') }}</div>
        </template>
        <table class="tabular w-full text-sm">
          <thead class="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th class="px-4 py-2 text-left">藥品</th>
              <th class="px-3 py-2 text-left">用法</th>
              <th class="px-3 py-2 text-right">天數</th>
              <th class="px-3 py-2 text-right">總量</th>
              <th class="px-3 py-2 text-right">庫存</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="it in d.items" :key="it.drugId">
            <tr :class="['border-t border-slate-100', it.shortage && 'bg-red-50']">
              <td class="px-4 py-2">
                <div class="font-medium text-slate-800">{{ it.drugName }}</div>
                <div v-if="it.drugNameZh" class="text-xs text-slate-600">{{ it.drugNameZh }}</div>
                <div class="flex items-center gap-1 text-xs text-slate-500">{{ it.spec }}<UBadge v-if="it.highAlert" tone="purple">高警訊</UBadge></div>
              </td>
              <td class="px-3 py-2 text-slate-700">{{ it.dose }} {{ it.doseUnit }}・{{ it.freq }}・{{ it.route }}<span v-if="it.timingShort" :class="['ml-1 rounded px-1 text-xs', it.timingShort === '飯前飯後皆可' ? 'text-slate-500' : 'bg-amber-100 font-medium text-amber-800']">{{ it.timingShort }}</span></td>
              <td class="px-3 py-2 text-right">{{ it.days }}</td>
              <td class="px-3 py-2 text-right font-semibold">{{ it.qty }}</td>
              <td :class="['px-3 py-2 text-right', it.shortage ? 'font-semibold text-red-600' : 'text-slate-500']">
                {{ it.stock }}<div v-if="it.shortage" class="text-xs">缺 {{ it.qty - it.stock }}</div>
              </td>
            </tr>
            <!-- 缺藥的處理放在下一列、跨整列：窄螢幕時明細只有 400px 寬，擠在最後一欄會撐出橫向捲軸 -->
            <tr v-if="it.shortage && d.status !== 'dispensed'" class="bg-red-50">
              <td colspan="5" class="px-4 pb-2">
                <div v-if="it.restock?.includesThis" class="flex flex-wrap items-center gap-2 text-xs text-sky-800">
                  <UBadge tone="blue">已申請補貨</UBadge>
                  <span>{{ it.restock.requestedAt.slice(5, 16).replace('-', '/') }} 申請，尚欠 {{ it.restock.outstanding }} {{ it.unit }}；到貨入庫後即可{{ d.status === 'pending' ? '核對' : '發藥' }}</span>
                </div>
                <div v-else class="flex flex-wrap items-center gap-2 text-xs text-red-700">
                  <UButton size="sm" variant="secondary" :icon="PackagePlus" @click="openRestock(it)">{{ it.restock ? '加入補貨申請' : '申請補貨' }}</UButton>
                  <span v-if="it.restock">這種藥已申請 {{ it.restock.qty }} {{ it.unit }}（{{ it.restock.requestedAt.slice(5, 16).replace('-', '/') }}），把這位病人加入等候名單</span>
                </div>
              </td>
            </tr>
            </template>
          </tbody>
        </table>
      </UCard>

      <!-- 錯誤訊息不只說「錯了」，也告訴使用者下一步 -->
      <div v-if="shortages.length && d.status !== 'dispensed'" class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
{{ shortages.map((s) => s.drugName).join('、') }} 庫存不足，無法{{ d.status === 'pending' ? '核對' : '發藥' }}。
        <template v-if="shortages.every((s) => s.restock?.includesThis)">已申請補貨，到貨入庫後即可{{ d.status === 'pending' ? '核對' : '發藥' }}；也可以請醫師改開替代藥。</template>
        <template v-else>請按該列的「申請補貨」，或聯絡醫師更換藥品。</template>
      </div>

      <div class="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3">
        <span class="text-xs text-slate-500">
          <template v-if="d.verifiedAt">核對：{{ d.verifiedAt.slice(11) }}　</template>
          <template v-if="d.dispensedAt">發藥：{{ d.dispensedAt.slice(11) }}</template>
        </span>
        <div class="ml-auto flex gap-2">
          <UButton variant="secondary" :icon="Printer" @click="bagOpen = true">藥袋</UButton>
          <UButton v-if="d.status === 'pending'" :icon="ClipboardCheck" :disabled="shortages.length > 0" :loading="verify.pending.value" @click="verify.run(d.id)">核對處方</UButton>
          <UButton v-if="d.status === 'verified'" variant="success" :icon="CheckCheck" :disabled="shortages.length > 0" :loading="give.pending.value" @click="onDispense">發藥</UButton>
        </div>
      </div>
    </div>

    <!-- 補貨申請：與藥品庫存頁共用；建議量依用量算（stock-rules 的 suggestRestockQty），不再固定「缺量＋500」 -->
    <RestockRequestDialog v-model="restockOpen" :drug-id="restockItem?.drugId" :dispense-id="d?.id" :pickup-no="d?.pickupNo" />

    <UDialog v-model="pickupOpen" title="發藥：確認領藥人" size="sm" @submit="confirmPickup">
      <div v-if="d" class="space-y-3 text-sm">
        <div class="rounded-md bg-slate-50 px-3 py-2">
          <span class="text-base font-semibold text-slate-800">{{ d.patientName }}</span>
          <span class="ml-2 text-slate-500">{{ d.gender === 'M' ? '男' : '女' }}・{{ d.age }} 歲・領藥號 {{ d.pickupNo }}</span>
        </div>
        <!-- 「他人代領」放在輸入欄下方：對話框打開時游標落在第一個欄位，多數情況是本人，直接打 4 碼按 Enter -->
        <template v-if="!pickup.proxy">
          <p class="text-slate-600">請病人說出<b>姓名與出生月日</b>，輸入病人說的月日：</p>
          <UInput v-model="pickup.birthMMDD" label="出生月日（4 碼）" placeholder="例：0314" inputmode="numeric" maxlength="4" required :error="give.fieldErrors.value.birthMMDD" />
        </template>
        <template v-else>
          <div class="grid grid-cols-2 gap-3">
            <UInput v-model="pickup.proxyName" label="代領人姓名" required :error="give.fieldErrors.value.proxyName" />
            <UInput v-model="pickup.relation" label="與病人關係" placeholder="例：配偶、子女" required :error="give.fieldErrors.value.relation" />
          </div>
        </template>
        <UCheckbox v-model="pickup.proxy" label="他人代領（改為登記代領人）" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="pickupOpen = false">取消</UButton>
        <UButton type="submit" variant="success" :icon="CheckCheck" :loading="give.pending.value">確認發藥</UButton>
      </template>
    </UDialog>

    <UDialog v-model="bagOpen" title="藥袋預覽" size="lg">
      <DrugBagLabels v-if="d" :d="d" />
      <template #footer>
        <UButton variant="secondary" @click="bagOpen = false">關閉</UButton>
        <UButton :icon="Printer" @click="print">列印</UButton>
      </template>
    </UDialog>
  </div>
</template>
