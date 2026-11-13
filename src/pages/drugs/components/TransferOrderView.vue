<script setup lang="ts">
// 一張撥補單：
//   新請領（藥局）：從需求清單（低於安全庫存、門診藥局的補貨申請）勾選或自行加品項 → 送出請領
//   請領中：藥庫每一行填實撥（預設＝請領量與藥庫可用的較小者，可少撥、0＝這次不撥）→ 撥發；或取消（寫原因）
//   運送中：藥局逐批填實收（預設＝撥發量），短少寫原因 → 簽收入帳
// 退回藥庫：待審核（藥庫逐批填同意收多少，少收寫原因；或整張不收）→ 已核准（藥局送出才扣帳）→ 運送中 → 藥庫簽收
// 數量能不能撥、能不能收由服務層判斷；這裡照資料顯示、把欄位錯誤標在那一列。
import { computed, reactive, ref, watch } from 'vue'
import { Ban, Check, PackageCheck, Plus, Send, Trash2, Truck } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState, USelect, UTextarea } from '@/components/ui'
import { masterApi, transferApi } from '@/services'
import { today } from '@/utils/date'
import type { ReturnDisposition } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { useCan } from '@/composables/useCan'
import { useUi } from '@/stores/ui'
import { transferStatusOf } from './transferStatus'

const props = defineProps<{ transferId?: string; toLocationId: string; toLocationName?: string }>()
const emit = defineEmits<{ created: [id: string] }>()
const auth = useAuth()
const ui = useUi()
const isPharmacist = computed(() => auth.user?.role === 'pharmacist')
// 藥庫端（撥發、審核退回）跟權限走（transfer.warehouse，可只指定給藥庫藥師）
const can = useCan()
const isWarehouse = computed(() => isPharmacist.value && can('transfer.warehouse'))

const { data, loading } = useQuery(async () => (props.transferId ? transferApi.getTransfer(props.transferId) : undefined), [() => props.transferId])
const tr = computed(() => data.value)
const md = (t?: string) => (t ? t.slice(5, 16).replace('-', '/') : '')

// ---------- 新請領 ----------
type FormLine = { drugId: string | number; qty?: number; restockId?: string }
const form = reactive({ note: '', lines: [] as FormLine[] })
const { data: drugs } = useQuery(() => masterApi.listDrugs())
const drugOptions = computed(() => (drugs.value ?? []).map((d) => ({ label: `${d.name}（${d.nameZh}）`, value: d.id })))
const { data: candidates } = useQuery(async () => (!props.transferId && isPharmacist.value ? transferApi.transferCandidates(props.toLocationId) : []), [() => props.toLocationId])
const inForm = (id: string) => form.lines.some((l) => l.drugId === id)
function toggle(c: NonNullable<typeof candidates.value>[number], on: boolean) {
  if (on && !inForm(c.drugId)) form.lines.push({ drugId: c.drugId, qty: c.suggestedQty || undefined, restockId: c.restock?.id })
  if (!on) form.lines = form.lines.filter((l) => l.drugId !== c.drugId)
}
function candNote(c: NonNullable<typeof candidates.value>[number]) {
  const base = c.restock ? `補貨申請尚欠 ${c.restock.outstanding}${c.restock.waiting ? `（${c.restock.waiting} 人等）` : ''}` : `低於安全庫存（可用 ${c.usable}／安全 ${c.safetyStock}）`
  return `${base}・建議 ${c.suggestedQty} ${c.unit}${c.onTheWay ? `（已請領／運送中 ${c.onTheWay}）` : ''}`
}
const request = useAction(transferApi.requestTransfer, { success: (t) => `已送出請領 ${t.no}，等藥庫撥發` })
async function onRequest() {
  const t = await request.run({
    toLocationId: props.toLocationId,
    note: form.note,
    lines: form.lines.map((l) => ({ drugId: String(l.drugId ?? ''), qty: l.qty as number, ...(l.restockId ? { restockId: l.restockId } : {}) })),
  })
  if (t) emit('created', t.id)
}

// ---------- 撥發 ----------
const issueQty = reactive<Record<string, number>>({})
watch(tr, (t) => {
  if (t?.status !== 'requested') return
  for (const l of t.lines) if (!(l.id in issueQty)) issueQty[l.id] = Math.min(l.qty, l.available ?? l.qty)
}, { immediate: true })
const issue = useAction(transferApi.issueTransfer, { success: (t) => `${t.no} 已撥發，運送中（等 ${t.toName} 簽收）` })
async function onIssue() {
  const t = tr.value
  if (!t) return
  const short = t.lines.filter((l) => (issueQty[l.id] ?? 0) < l.qty).length
  const ok = await ui.confirm({ title: '撥發', message: `從${t.fromName}撥出 ${t.lines.length} 項${short ? `（${short} 項少於請領量）` : ''}，依效期先到先出扣批號；${t.toName}簽收後才入帳。`, okText: '撥發' })
  if (ok) await issue.run(t.id, { ...issueQty })
}

// ---------- 簽收 ----------
// 退回藥庫：逐批選「入庫／待報廢／拒收」（過期的預設待報廢、不能入庫——服務層也擋）
const recv = reactive<Record<string, number[]>>({})
const shortReasons = reactive<Record<string, string>>({})
const disp = reactive<Record<string, ReturnDisposition[]>>({})
const rejectReasons = reactive<Record<string, string>>({})
const todayStr = today()
watch(tr, (t) => {
  if (t?.status !== 'issued') return
  for (const l of t.lines) if (l.lots?.length && !recv[l.id]) recv[l.id] = l.lots.map((x) => x.qty)
  if (t.kind === 'return') for (const l of t.lines) if (l.lots?.length && !disp[l.id]) disp[l.id] = l.lots.map((x) => (x.expiry < todayStr ? 'quarantine' : 'stock'))
}, { immediate: true })
const dispOptions = (expiry: string) => [
  ...(expiry < todayStr ? [] : [{ label: '入庫', value: 'stock' }]),
  { label: '待報廢', value: 'quarantine' },
  { label: '拒收退回', value: 'rejected' },
]
const DISP_LABEL: Record<ReturnDisposition, string> = { stock: '入庫', quarantine: '待報廢', rejected: '拒收退回' }
const hasReject = (lineId: string) => (disp[lineId] ?? []).includes('rejected')
const shortOf = (lineId: string) => (tr.value?.lines.find((l) => l.id === lineId)?.lots ?? []).reduce((n, x, k) => n + (x.qty - (Number(recv[lineId]?.[k]) || 0)), 0)
const receive = useAction(transferApi.receiveTransfer, { success: (t) => (t.kind === 'return' ? `${t.no} 已簽收（入庫、待報廢、拒收依各批）` : `${t.no} 已簽收入 ${t.toName}`) })
async function onReceive() {
  const t = tr.value
  if (!t) return
  const received = Object.fromEntries(Object.entries(recv).map(([k, v]) => [k, v.map((x) => Number(x))]))
  await receive.run(t.id, { received, shortReasons: { ...shortReasons }, ...(t.kind === 'return' ? { dispositions: { ...disp }, rejectReasons: { ...rejectReasons } } : {}) })
}

// ---------- 退回藥庫：審核、不收、送出 ----------
const approveQty = reactive<Record<string, number[]>>({})
const approveReasons = reactive<Record<string, string>>({})
watch(tr, (t) => {
  if (t?.kind !== 'return' || t.status !== 'requested') return
  for (const l of t.lines) if (!approveQty[l.id]) approveQty[l.id] = (l.lots ?? []).map((x) => x.requestedQty ?? x.qty)
}, { immediate: true })
const lessThanAsked = (lineId: string) => (tr.value?.lines.find((l) => l.id === lineId)?.lots ?? []).some((x, k) => (Number(approveQty[lineId]?.[k]) || 0) < (x.requestedQty ?? x.qty))
const approve = useAction(transferApi.approveReturn, { success: (t) => `已核准 ${t.no}：等${t.fromName}送出` })
async function onApprove() {
  const t = tr.value
  if (!t) return
  const approved = Object.fromEntries(Object.entries(approveQty).map(([k, v]) => [k, v.map((x) => Number(x))]))
  await approve.run(t.id, { approved, reasons: { ...approveReasons } })
}
const declineOpen = ref(false)
const declineReason = ref('')
const decline = useAction(transferApi.declineReturn, { success: (t) => `${t.no} 不收：藥留在${t.fromName}` })
async function onDecline() {
  if (tr.value && (await decline.run(tr.value.id, declineReason.value))) declineOpen.value = false
}
const ship = useAction(transferApi.shipReturn, { success: (t) => `${t.no} 已送出：運送中，等${t.toName}簽收` })
async function onShip() {
  const t = tr.value
  if (!t) return
  const short = t.lines.some((l) => (l.lots ?? []).some((x, k) => (x.approvedQty ?? 0) > (l.lotsOnHand?.[k] ?? 0)))
  const ok = await ui.confirm({ title: '送出退回', message: `從${t.fromName}送出藥庫同意收的批號，這時才扣帳（運送中）。${short ? '\n有批號已經發掉一些，照現有的少送。' : ''}`, okText: '送出' })
  if (ok) await ship.run(t.id)
}

// ---------- 取消 ----------
const cancelOpen = ref(false)
const cancelReason = ref('')
const cancel = useAction(transferApi.cancelTransfer, { success: (t) => `已取消 ${t.no}` })
async function onCancel() {
  if (tr.value && (await cancel.run(tr.value.id, cancelReason.value))) cancelOpen.value = false
}
const err = (k: string) => issue.fieldErrors.value[k] || receive.fieldErrors.value[k] || approve.fieldErrors.value[k] || ''
const isOpenReturn = computed(() => tr.value?.kind === 'return' && (tr.value.status === 'requested' || tr.value.status === 'approved'))
</script>

<template>
  <UQueryState :loading="!!transferId && loading && !tr" :ready="!transferId || !!tr">
    <div class="space-y-3">
      <!-- 新請領 -->
      <template v-if="!transferId">
        <h2 class="text-lg font-bold text-slate-800">向藥庫請領<template v-if="toLocationName">（{{ toLocationName }}）</template></h2>
        <section v-if="candidates?.length" class="rounded-md border border-sky-200 bg-sky-50/60 p-3">
          <h3 class="mb-1 text-sm font-semibold text-sky-900">需求清單（勾選帶入，數量為建議量，可改）</h3>
          <div class="max-h-48 space-y-1 overflow-y-auto">
            <UCheckbox v-for="c in candidates" :key="c.drugId" :model-value="inForm(c.drugId)" @update:model-value="(v) => toggle(c, v)">
              <span class="font-medium">{{ c.drugName }}</span><span class="text-xs text-slate-600">・{{ candNote(c) }}</span>
            </UCheckbox>
          </div>
        </section>
        <div class="overflow-x-auto rounded-md border border-slate-200">
          <table class="tabular w-full text-sm">
            <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500"><tr><th class="px-3 py-1.5 text-left font-medium">藥品</th><th class="px-2 text-right font-medium">請領數量</th><th></th></tr></thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="(l, i) in form.lines" :key="i">
                <td class="min-w-56 px-3 py-1.5">
                  <USelect v-model="l.drugId" :options="drugOptions" placeholder="選擇藥品" :aria-label="`第 ${i + 1} 項藥品`" />
                  <div v-if="l.restockId" class="mt-0.5 text-xs text-sky-700">補貨申請（病人在等）</div>
                  <div v-if="request.fieldErrors.value[`line-${i}`]" class="text-xs text-red-600">{{ request.fieldErrors.value[`line-${i}`] }}</div>
                </td>
                <td class="whitespace-nowrap px-2 text-right"><input v-model.number="l.qty" type="number" min="1" step="1" class="form-control w-24 text-right" :aria-label="`第 ${i + 1} 項請領數量`" /></td>
                <td class="px-2 text-right"><UButton size="sm" variant="ghost" :icon="Trash2" :aria-label="`刪除第 ${i + 1} 項`" @click="form.lines.splice(i, 1)" /></td>
              </tr>
              <tr v-if="!form.lines.length"><td colspan="3" class="px-3 py-4 text-center text-sm text-slate-400">從需求清單勾選，或按「加品項」</td></tr>
            </tbody>
          </table>
        </div>
        <p v-if="request.fieldErrors.value.lines" class="text-xs text-red-600">{{ request.fieldErrors.value.lines }}</p>
        <UInput v-model="form.note" label="備註（選填）" placeholder="例：窗口缺藥，病人在等" />
        <div class="flex justify-between gap-2">
          <UButton size="sm" variant="secondary" :icon="Plus" @click="form.lines.push({ drugId: '' })">加品項</UButton>
          <UButton size="sm" :icon="Send" :loading="request.pending.value" @click="onRequest">送出請領</UButton>
        </div>
      </template>

      <!-- 既有的單 -->
      <template v-else-if="tr">
        <header class="flex flex-wrap items-start gap-2">
          <div class="min-w-0 flex-1">
            <h2 class="tabular flex items-center gap-2 text-lg font-bold text-slate-800">{{ tr.no }}<UBadge v-if="tr.kind === 'return'" tone="gray">退回藥庫</UBadge><UBadge :tone="transferStatusOf(tr).tone">{{ transferStatusOf(tr).label }}</UBadge></h2>
            <template v-if="tr.kind === 'return'">
              <p class="text-xs text-slate-500">{{ tr.fromName }} → {{ tr.toName }}・{{ tr.requestedByName }} {{ md(tr.requestedAt) }} 申請退回・原因：{{ tr.returnReason }}</p>
              <p v-if="tr.approvedByName" class="text-xs text-slate-500">{{ tr.approvedByName }} {{ md(tr.approvedAt) }} 核准</p>
              <p v-if="tr.issuedByName" class="text-xs text-slate-500">{{ tr.issuedByName }} {{ md(tr.issuedAt) }} 送出</p>
            </template>
            <template v-else>
              <p class="text-xs text-slate-500">{{ tr.fromName }} → {{ tr.toName }}・{{ tr.requestedByName }} {{ md(tr.requestedAt) }} 請領<template v-if="tr.note">・{{ tr.note }}</template></p>
              <p v-if="tr.issuedByName" class="text-xs text-slate-500">{{ tr.issuedByName }} {{ md(tr.issuedAt) }} 撥發</p>
            </template>
            <p v-if="tr.receivedByName" class="text-xs text-emerald-700">{{ tr.receivedByName }} {{ md(tr.receivedAt) }} 簽收</p>
            <p v-if="tr.status === 'cancelled'" class="text-xs text-slate-500">{{ tr.cancelledByName }} 取消：{{ tr.cancelReason }}</p>
          </div>
          <UButton v-if="(tr.status === 'requested' || (tr.kind === 'return' && tr.status === 'approved')) && isPharmacist" size="sm" variant="ghost" @click="(cancelReason = ''), (cancelOpen = true)">{{ tr.kind === 'return' ? '取消申請' : '取消' }}</UButton>
        </header>

        <div class="overflow-x-auto rounded-md border border-slate-200">
          <table class="tabular w-full text-sm">
            <thead class="whitespace-nowrap bg-slate-50 text-xs text-slate-500">
              <tr>
                <th class="px-3 py-1.5 text-left font-medium">藥品</th>
                <th class="px-2 text-right font-medium">{{ tr.kind === 'return' ? '退回' : '請領' }}</th>
                <th v-if="tr.status === 'requested' && tr.kind !== 'return'" class="px-2 text-right font-medium">藥庫可用</th>
                <th v-if="tr.kind !== 'return'" class="px-2 text-right font-medium">{{ tr.status === 'requested' ? '實撥' : '撥發' }}</th>
                <th v-if="isOpenReturn" class="px-3 text-left font-medium">批號（效期）・申請 → 同意收<template v-if="tr.status === 'approved'">・藥局現有</template></th>
                <th v-else-if="tr.status !== 'requested'" class="px-3 text-left font-medium">批號（效期）・{{ tr.status === 'issued' ? '實收' : '已收' }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="l in tr.lines" :key="l.id" :class="[(l.shortQty || (l.issuedQty !== undefined && l.issuedQty < l.qty)) && 'bg-amber-50/60']">
                <td class="px-3 py-1.5">
                  <div class="font-medium text-slate-800">{{ l.drugName }}</div>
                  <div class="text-xs text-slate-500">{{ l.drugNameZh }}・{{ l.spec }}<template v-if="l.restockId">・補貨申請</template></div>
                </td>
                <td class="px-2 text-right">{{ l.qty }} <span class="text-xs text-slate-400">{{ l.unit }}</span></td>
                <td v-if="tr.status === 'requested' && tr.kind !== 'return'" class="px-2 text-right text-slate-600">{{ l.available ?? '盤點中' }}</td>
                <td v-if="tr.kind !== 'return'" class="whitespace-nowrap px-2 text-right">
                  <template v-if="tr.status === 'requested' && isWarehouse">
                    <input v-model.number="issueQty[l.id]" type="number" min="0" step="1" class="form-control w-20 text-right" :aria-label="`${l.drugName} 實撥數量`" />
                    <div v-if="err(`issue-${l.id}`)" class="text-xs text-red-600">{{ err(`issue-${l.id}`) }}</div>
                  </template>
                  <span v-else>{{ l.issuedQty ?? '' }}</span>
                </td>
                <td v-if="isOpenReturn" class="px-3 py-1.5">
                  <div v-for="(x, k) in l.lots ?? []" :key="x.lotNo" class="flex flex-wrap items-center gap-2 text-xs">
                    <span class="w-28 text-slate-700">{{ x.lotNo }}（{{ x.expiry }}）</span>
                    <span class="text-slate-500">申請 {{ x.requestedQty ?? x.qty }}</span>
                    <template v-if="tr.status === 'requested' && isWarehouse && approveQty[l.id]">
                      <span class="text-slate-400">→</span>
                      <input v-model.number="approveQty[l.id][k]" type="number" min="0" step="1" class="form-control w-20 text-right" :aria-label="`${l.drugName} 批號 ${x.lotNo} 同意收`" />
                      <span v-if="err(`approve-${l.id}-${k}`)" class="text-red-600">{{ err(`approve-${l.id}-${k}`) }}</span>
                    </template>
                    <template v-if="tr.status === 'approved'">
                      <span :class="(x.approvedQty ?? 0) < (x.requestedQty ?? x.qty) ? 'font-medium text-amber-800' : 'text-slate-600'">→ 同意 {{ x.approvedQty }}</span>
                    </template>
                    <span v-if="l.lotsOnHand" :class="(l.lotsOnHand[k] ?? 0) < (x.approvedQty ?? x.requestedQty ?? x.qty) ? 'font-medium text-red-700' : 'text-slate-400'">藥局現有 {{ l.lotsOnHand[k] }}</span>
                    <UBadge v-if="x.expiry < todayStr" tone="red">已過期</UBadge>
                  </div>
                  <template v-if="tr.status === 'requested' && isWarehouse && lessThanAsked(l.id)">
                    <input v-model="approveReasons[l.id]" type="text" placeholder="少收原因：藥庫也滿了、請藥局自行用完…" :class="['form-control mt-1 w-64 text-xs', err(`reason-${l.id}`) && 'form-control-error']" :aria-label="`${l.drugName} 少收原因`" />
                    <div v-if="err(`reason-${l.id}`)" class="text-xs text-red-600">{{ err(`reason-${l.id}`) }}</div>
                  </template>
                  <p v-if="l.declineReason" class="text-xs text-amber-800">少收：{{ l.declineReason }}</p>
                </td>
                <td v-else-if="tr.status !== 'requested'" class="px-3 py-1.5">
                  <div v-for="(x, k) in l.lots ?? []" :key="x.lotNo" class="flex items-center gap-2 text-xs">
                    <span class="w-28 text-slate-700">{{ x.lotNo }}（{{ x.expiry }}）</span>
                    <template v-if="tr.status === 'issued' && isPharmacist && recv[l.id]">
                      <input v-model.number="recv[l.id][k]" type="number" min="0" step="1" class="form-control w-20 text-right" :aria-label="`${l.drugName} 批號 ${x.lotNo} 實收`" />
                      <span class="text-slate-400">/ {{ x.qty }}</span>
                      <select v-if="tr.kind === 'return' && disp[l.id]" v-model="disp[l.id][k]" :class="['form-control w-24 text-xs', err(`disp-${l.id}-${k}`) && 'form-control-error']" :aria-label="`${l.drugName} 批號 ${x.lotNo} 處理方式`">
                        <option v-for="o in dispOptions(x.expiry)" :key="o.value" :value="o.value">{{ o.label }}</option>
                      </select>
                      <UBadge v-if="x.expiry < todayStr" tone="red">已過期</UBadge>
                      <span v-if="err(`recv-${l.id}-${k}`)" class="text-red-600">{{ err(`recv-${l.id}-${k}`) }}</span>
                      <span v-if="err(`disp-${l.id}-${k}`)" class="text-red-600">{{ err(`disp-${l.id}-${k}`) }}</span>
                    </template>
                    <template v-else>
                      <span class="text-slate-600">{{ x.receivedQty ?? x.qty }} / {{ x.qty }}</span>
                      <UBadge v-if="x.disposition && x.disposition !== 'stock'" :tone="x.disposition === 'rejected' ? 'yellow' : 'red'">{{ DISP_LABEL[x.disposition] }}</UBadge>
                    </template>
                  </div>
                  <p v-if="!l.lots?.length" class="text-xs text-slate-400">這次沒有撥</p>
                  <template v-if="tr.status === 'issued' && isPharmacist && shortOf(l.id) > 0">
                    <input v-model="shortReasons[l.id]" type="text" placeholder="短少原因：破損、遺失…" :class="['form-control mt-1 w-48 text-xs', err(`short-${l.id}`) && 'form-control-error']" :aria-label="`${l.drugName} 短少原因`" />
                    <div v-if="err(`short-${l.id}`)" class="text-xs text-red-600">{{ err(`short-${l.id}`) }}</div>
                  </template>
                  <template v-if="tr.status === 'issued' && isPharmacist && tr.kind === 'return' && hasReject(l.id)">
                    <input v-model="rejectReasons[l.id]" type="text" placeholder="拒收原因：未事先聯絡、包裝已拆…" :class="['form-control mt-1 w-56 text-xs', err(`reject-${l.id}`) && 'form-control-error']" :aria-label="`${l.drugName} 拒收原因`" />
                    <div v-if="err(`reject-${l.id}`)" class="text-xs text-red-600">{{ err(`reject-${l.id}`) }}</div>
                  </template>
                  <p v-if="l.shortReason" class="text-xs text-amber-800">短少 {{ l.shortQty }}：{{ l.shortReason }}</p>
                  <p v-if="l.rejectReason" class="text-xs text-amber-800">拒收：{{ l.rejectReason }}（退回{{ tr.fromName }}）</p>
                  <p v-if="l.declineReason" class="text-xs text-slate-500">審核少收：{{ l.declineReason }}</p>
                  <p v-if="l.shipNote" class="text-xs text-amber-800">送出：{{ l.shipNote }}</p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="isPharmacist" class="flex justify-end gap-2">
          <UButton v-if="tr.status === 'requested' && tr.kind !== 'return' && isWarehouse" size="sm" :icon="Truck" :loading="issue.pending.value" @click="onIssue">撥發</UButton>
          <template v-if="tr.status === 'requested' && tr.kind === 'return' && isWarehouse">
            <UButton size="sm" variant="secondary" :icon="Ban" @click="(declineReason = ''), (declineOpen = true)">不收</UButton>
            <UButton size="sm" :icon="Check" :loading="approve.pending.value" @click="onApprove">核准</UButton>
          </template>
          <UButton v-if="tr.status === 'approved'" size="sm" :icon="Send" :loading="ship.pending.value" @click="onShip">送出</UButton>
          <UButton v-if="tr.status === 'issued'" size="sm" :icon="PackageCheck" :loading="receive.pending.value" @click="onReceive">簽收入帳</UButton>
        </div>
        <p v-if="tr.kind === 'return' && tr.status === 'requested'" class="text-xs text-slate-500">待{{ tr.toName }}審核：逐批填同意收多少（少收或不收寫原因），或整張「不收」。藥還在{{ tr.fromName }}、還沒扣帳，期間照常發藥。</p>
        <p v-if="tr.status === 'approved'" class="text-xs text-slate-500">{{ tr.toName }}已同意：{{ tr.fromName }}按「送出」才扣帳（運送中）。批號申請後已發掉一些的，照現有的少送。</p>
        <p v-if="tr.status === 'issued'" class="text-xs text-slate-500">運送中：{{ tr.fromName }}已扣、{{ tr.toName }}還沒入帳。照實物逐批填實收，短少寫原因。<template v-if="tr.kind === 'return'">退回的每一批選「入庫」（可用）、「待報廢」（放待報廢區，過期的只能這樣）或「拒收退回」（寫原因，帳回到{{ tr.fromName }}）。</template></p>
      </template>

      <UDialog v-model="declineOpen" title="不收這張退回" size="sm" @submit="onDecline">
        <UTextarea v-model="declineReason" label="不收的原因" :rows="2" placeholder="例：近效期請藥局自行用完、改向廠商退貨" :error="decline.fieldErrors.value.reason" />
        <template #footer>
          <UButton variant="secondary" @click="declineOpen = false">返回</UButton>
          <UButton type="submit" variant="danger" :loading="decline.pending.value">不收</UButton>
        </template>
      </UDialog>
      <UDialog v-model="cancelOpen" title="取消撥補單" size="sm" @submit="onCancel">
        <UTextarea v-model="cancelReason" label="取消原因" :rows="2" :error="cancel.fieldErrors.value.reason" />
        <template #footer>
          <UButton variant="secondary" @click="cancelOpen = false">返回</UButton>
          <UButton type="submit" variant="danger" :loading="cancel.pending.value">取消撥補單</UButton>
        </template>
      </UDialog>
    </div>
  </UQueryState>
</template>
