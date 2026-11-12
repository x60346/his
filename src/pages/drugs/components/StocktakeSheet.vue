<script setup lang="ts">
// 一張盤點單：
//   清點中：每批填實點數量（看不到帳上數量——服務層根本不給），可加「架上有、表上沒有」的批號，列印清點表，送出
//   待覆核：揭露帳上數量（清點那一刻的）與差異；另一人（沒清點、沒送出）寫差異原因後過帳，或退回重盤
//   已過帳／已取消：唯讀
// 誰能覆核由服務層判斷（reviewBlocked）；這裡只照它顯示。
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { Printer, Plus, Send } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UQueryState, USelect, UTextarea } from '@/components/ui'
import { checkStocktakeActual, masterApi, stocktakeApi, type StocktakeView } from '@/services'
import { errorMessage, useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import { HOSPITAL } from '@/utils/hospital'
import { now, toRoc } from '@/utils/date'

const props = defineProps<{ sheetId: string; statusView: Record<StocktakeView['status'], { label: string; tone: 'yellow' | 'blue' | 'green' | 'gray' }> }>()
const auth = useAuth()
const ui = useUi()
const { data, loading } = useQuery(async () => ({ id: props.sheetId, sheet: await stocktakeApi.getStocktake(props.sheetId) }), [() => props.sheetId])
const s = computed(() => (data.value?.id === props.sheetId ? data.value.sheet : undefined))
const isPharmacist = computed(() => auth.user?.role === 'pharmacist')

// ---------- 清點：每列的輸入草稿，離開欄位（或 Enter）才存 ----------
const drafts = reactive<Record<string, string>>({})
const lineErr = reactive<Record<string, string>>({})
watch(s, (v) => {
  if (!v) return
  for (const l of v.lines) if (!(l.id in drafts) || drafts[l.id] === '') drafts[l.id] = l.counted === undefined ? '' : String(l.counted)
})
watch(() => props.sheetId, () => {
  for (const k of Object.keys(drafts)) delete drafts[k]
  for (const k of Object.keys(lineErr)) delete lineErr[k]
})
// 存檔排隊、一列一列送：清點時手很快（填完按 Enter 或 Tab 馬上下一列），
// 以前共用一個 useAction，上一列還在存時下一列的存檔被「進行中」擋掉——數字留在格子裡、其實沒存，送出時才發現少一列
const saving = reactive<Record<string, boolean>>({})
let queue: Promise<unknown> = Promise.resolve()
function saveLine(lineId: string) {
  const v = s.value
  if (!v || v.status !== 'counting') return queue
  // type="number" 的 v-model 會給數字（Vue 自動轉型），比對前統一成字串
  const raw = String(drafts[lineId] ?? '')
  const line = v.lines.find((l) => l.id === lineId)
  if (raw === '' || (line?.counted !== undefined && String(line.counted) === raw)) return queue
  const n = Number(raw)
  // 和服務層同一條規則（stock-rules.checkStocktakeActual）：負數、小數、非數字不送
  const err = checkStocktakeActual(n)
  lineErr[lineId] = err ?? ''
  if (err) return queue
  saving[lineId] = true
  const sheetId = v.id
  queue = queue.then(async () => {
    try {
      await stocktakeApi.countLine(sheetId, lineId, n)
      lineErr[lineId] = ''
    } catch (e) {
      lineErr[lineId] = errorMessage(e)
    } finally {
      saving[lineId] = false
    }
  })
  return queue
}

const submit = useAction(stocktakeApi.submitStocktake, { success: (x) => `已送出 ${x.no}，請另一位藥師或管理員覆核` })
async function onSubmit() {
  // 先把還在格子裡、沒存的數字存掉，並等排隊中的存檔都完成，再問要不要送出
  for (const l of s.value?.lines ?? []) saveLine(l.id)
  await queue
  const v = s.value
  if (!v) return
  const ok = await ui.confirm({ title: '送出盤點', message: `送出後就不能再改數量，交給另一人覆核（${v.total} 批）。`, okText: '送出' })
  if (ok) await submit.run(v.id)
}

// ---------- 加批號：架上有、表上沒有 ----------
const foundOpen = ref(false)
const found = ref({ drugId: '' as string | number, lotNo: '', expiry: '', counted: undefined as number | undefined })
const { data: drugs } = useQuery(() => masterApi.listDrugs())
const scopeDrugs = computed(() => {
  const sc = s.value?.scope
  return (drugs.value ?? []).filter((d) => !sc || sc.kind === 'all' || (sc.kind === 'category' ? d.category === sc.category : sc.drugIds.includes(d.id)))
})
const addFound = useAction(stocktakeApi.addFoundLot, { success: '已加入清點表' })
async function onAddFound() {
  const v = s.value
  if (!v) return
  const f = found.value
  if (await addFound.run(v.id, { drugId: String(f.drugId), lotNo: f.lotNo, expiry: f.expiry, counted: f.counted as number })) foundOpen.value = false
}
watch(foundOpen, (o) => o && ((found.value = { drugId: '', lotNo: '', expiry: '', counted: undefined }), (addFound.fieldErrors.value = {})))

// ---------- 覆核 ----------
const reasons = reactive<Record<string, string>>({})
const post = useAction(stocktakeApi.postStocktake, { success: (x) => `${x.no} 已過帳（${x.diffCount ? `${x.diffCount} 批調整` : '帳實相符'}）` })
async function onPost() {
  const v = s.value
  if (!v) return
  const msg = v.diffCount ? `有 ${v.diffCount} 批差異，過帳後會寫入盤點調整（單號 ${v.no}）。` : '全部帳實相符，過帳後不會產生調整。'
  if (await ui.confirm({ title: '覆核過帳', message: msg, okText: '過帳' })) await post.run(v.id, { ...reasons })
}
const back = useAction(stocktakeApi.returnStocktake, { success: (x) => `已退回 ${x.no} 重盤` })
const cancel = useAction(stocktakeApi.cancelStocktake, { success: (x) => `已取消 ${x.no}` })
const reasonOpen = ref<'' | 'return' | 'cancel'>('')
const reasonText = ref('')
async function onReason() {
  const v = s.value
  if (!v) return
  const r = reasonOpen.value === 'return' ? await back.run(v.id, reasonText.value) : await cancel.run(v.id, reasonText.value)
  if (r) reasonOpen.value = ''
}
function openReason(k: 'return' | 'cancel') {
  reasonText.value = ''
  back.fieldErrors.value = {}
  cancel.fieldErrors.value = {}
  reasonOpen.value = k
}

// ---------- 列印清點表：只有藥名、批號、效期與空白欄（不印帳上數量） ----------
const printedAt = ref('')
async function print() {
  printedAt.value = now()
  await nextTick()
  window.print()
}
const diffText = (n?: number) => (n === undefined ? '' : n > 0 ? `+${n}` : String(n))
</script>

<template>
  <UQueryState :loading="loading && !s" :ready="!!s">
    <div v-if="s" class="print-area space-y-3">
      <header class="no-print flex flex-wrap items-start gap-2">
        <div class="min-w-0 flex-1">
          <h2 class="tabular flex items-center gap-2 text-lg font-bold text-slate-800">{{ s.no }}<UBadge :tone="statusView[s.status].tone">{{ statusView[s.status].label }}</UBadge></h2>
          <p class="text-xs text-slate-500">{{ s.locationName }}・{{ s.scopeText }}・{{ s.createdByName }} {{ s.createdAt.slice(5, 16).replace('-', '/') }} 建立</p>
          <p v-if="s.submittedByName" class="text-xs text-slate-500">{{ s.submittedByName }} {{ s.submittedAt!.slice(5, 16).replace('-', '/') }} 送出</p>
          <p v-if="s.reviewedByName" class="text-xs text-emerald-700">{{ s.reviewedByName }} {{ s.reviewedAt!.slice(5, 16).replace('-', '/') }} 覆核過帳</p>
          <p v-if="s.status === 'cancelled'" class="text-xs text-slate-500">{{ s.cancelledByName }} 取消：{{ s.cancelReason }}</p>
          <p v-for="(r, i) in s.returns ?? []" :key="i" class="text-xs text-amber-700">曾退回重盤：{{ r.reason }}</p>
        </div>
        <template v-if="s.status === 'counting'">
          <UButton size="sm" variant="secondary" :icon="Printer" @click="print">列印清點表</UButton>
          <UButton v-if="isPharmacist" size="sm" variant="secondary" :icon="Plus" @click="foundOpen = true">加批號</UButton>
          <UButton v-if="isPharmacist" size="sm" :icon="Send" :loading="submit.pending.value" @click="onSubmit">送出（{{ s.countedCount }}/{{ s.total }}）</UButton>
        </template>
        <UButton v-if="s.status === 'counting' || s.status === 'submitted'" size="sm" variant="ghost" @click="openReason('cancel')">取消盤點</UButton>
      </header>

      <p v-if="s.status === 'counting'" class="no-print rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900">
        盲盤：照架上實物填數量（沒有請填 0）。帳上數量在送出前不顯示；清點期間照常發藥，差異以每一批「填數量那一刻」的帳為準。
      </p>
      <p v-else-if="s.status === 'submitted' && s.reviewBlocked" class="no-print rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{{ s.reviewBlocked }}</p>

      <!-- 列印表頭 -->
      <header class="hidden border-b-2 border-slate-800 pb-2 print:block">
        <h1 class="text-center text-lg font-bold">{{ HOSPITAL.name }}　藥品盤點清點表</h1>
        <div class="mt-1 flex justify-between text-xs">
          <span>{{ s.no }}・{{ s.locationName }}・{{ s.scopeText }}</span>
          <span>列印：{{ printedAt ? toRoc(printedAt.slice(0, 10)) + printedAt.slice(10) : '' }}・{{ auth.user?.name }}</span>
        </div>
      </header>

      <div class="overflow-x-auto rounded-md border border-slate-200">
        <table class="tabular w-full text-sm">
          <thead class="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th class="px-3 py-1.5 text-left font-medium">藥品</th>
              <th class="px-2 text-left font-medium">批號</th>
              <th class="px-2 text-left font-medium">效期</th>
              <th v-if="s.revealed" class="px-2 text-right font-medium">帳上</th>
              <th class="px-2 text-right font-medium">實點</th>
              <th v-if="s.revealed" class="px-2 text-right font-medium">差異</th>
              <th v-if="s.revealed" class="px-3 text-left font-medium">原因</th>
              <th v-else class="px-3 text-left font-medium print:w-24">清點人</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="l in s.lines" :key="l.id" :class="[(l.diff ?? 0) !== 0 && s.revealed && 'bg-amber-50/60']">
              <td class="px-3 py-1.5">
                <div class="font-medium text-slate-800">{{ l.drugName }}</div>
                <div class="text-xs text-slate-500">{{ l.drugNameZh }}・{{ l.spec }}<template v-if="!l.lotId">・<span class="text-violet-700">架上找到</span></template></div>
              </td>
              <td class="px-2">{{ l.lotNo }}</td>
              <td class="px-2 text-xs">{{ l.expiry }}</td>
              <td v-if="s.revealed" class="px-2 text-right text-slate-600">{{ l.systemQty }}</td>
              <td class="whitespace-nowrap px-2 text-right">
                <template v-if="s.status === 'counting' && isPharmacist">
                  <input
                    v-model="drafts[l.id]"
                    type="number"
                    min="0"
                    step="1"
                    :aria-label="`${l.drugName} 批號 ${l.lotNo} 實點數量`"
                    :class="['form-control no-print w-20 text-right', lineErr[l.id] && 'form-control-error']"
                    @blur="saveLine(l.id)"
                    @keydown.enter.prevent="saveLine(l.id)"
                  />
                  <span class="hidden print:inline">&nbsp;</span>
                  <span v-if="saving[l.id]" class="no-print ml-1 text-xs text-slate-400">儲存中</span>
                  <div v-if="lineErr[l.id]" class="text-xs text-red-600">{{ lineErr[l.id] }}</div>
                </template>
                <span v-else class="font-medium">{{ l.counted ?? '' }}</span>
                <span class="text-xs text-slate-400"> {{ l.unit }}</span>
              </td>
              <td v-if="s.revealed" :class="['px-2 text-right font-semibold', (l.diff ?? 0) > 0 ? 'text-emerald-700' : (l.diff ?? 0) < 0 ? 'text-red-600' : 'text-slate-400']">{{ diffText(l.diff) || '0' }}</td>
              <td v-if="s.revealed" class="px-3 py-1">
                <template v-if="s.status === 'submitted' && !s.reviewBlocked && (l.diff ?? 0) !== 0">
                  <input v-model="reasons[l.id]" type="text" :aria-label="`${l.drugName} 批號 ${l.lotNo} 差異原因`" placeholder="破損、計數錯誤…" :class="['form-control w-40', post.fieldErrors.value[`reason-${l.id}`] && 'form-control-error']" />
                  <div v-if="post.fieldErrors.value[`reason-${l.id}`]" class="text-xs text-red-600">{{ post.fieldErrors.value[`reason-${l.id}`] }}</div>
                </template>
                <span v-else class="text-xs text-slate-600">{{ l.reason ?? '' }}</span>
              </td>
              <td v-else class="px-3 text-xs text-slate-500">{{ l.countedByName ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <footer v-if="s.status === 'submitted' && !s.reviewBlocked" class="no-print flex flex-wrap justify-end gap-2">
        <UButton variant="secondary" @click="openReason('return')">退回重盤</UButton>
        <UButton :loading="post.pending.value" @click="onPost">覆核過帳</UButton>
      </footer>

      <UDialog v-model="foundOpen" title="加批號（架上有、清點表上沒有）" size="sm" @submit="onAddFound">
        <div class="space-y-3">
          <USelect v-model="found.drugId" label="藥品" placeholder="請選擇" :options="scopeDrugs.map((d) => ({ label: `${d.name}（${d.nameZh}）`, value: d.id }))" :error="addFound.fieldErrors.value.drugId" />
          <UInput v-model="found.lotNo" label="批號" :error="addFound.fieldErrors.value.lotNo" />
          <UInput v-model="found.expiry" label="效期" type="date" :error="addFound.fieldErrors.value.expiry" />
          <UInput v-model="found.counted" label="實點數量" type="number" :error="addFound.fieldErrors.value.counted" />
        </div>
        <template #footer>
          <UButton variant="secondary" @click="foundOpen = false">取消</UButton>
          <UButton type="submit" :loading="addFound.pending.value">加入</UButton>
        </template>
      </UDialog>

      <UDialog :model-value="!!reasonOpen" :title="reasonOpen === 'return' ? '退回重盤' : '取消盤點'" size="sm" @update:model-value="(v) => !v && (reasonOpen = '')" @submit="onReason">
        <UTextarea v-model="reasonText" :label="reasonOpen === 'return' ? '退回原因（例：第 3 列差異大，請重點）' : '取消原因'" :rows="2" :error="(reasonOpen === 'return' ? back : cancel).fieldErrors.value.reason" />
        <template #footer>
          <UButton variant="secondary" @click="reasonOpen = ''">返回</UButton>
          <UButton type="submit" :variant="reasonOpen === 'cancel' ? 'danger' : 'primary'" :loading="back.pending.value || cancel.pending.value">{{ reasonOpen === 'return' ? '退回' : '取消盤點' }}</UButton>
        </template>
      </UDialog>
    </div>
  </UQueryState>
</template>
