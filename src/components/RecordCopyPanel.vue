<script setup lang="ts">
// 病歷影本申請（病患資料頁的分頁，櫃台）：
//   - 新申請：申請人（本人核對姓名與身分證號；代理人登錄關係、勾委託書已核對）、用途、勾選要印的紀錄 → 收費（開收據、進日結）→ 列印
//   - 申請紀錄：補印（記次數）、當天作廢（收據一起作廢）
// 申請人檢查和服務層同一份 checkCopyApplicant；費用依主檔單價（可排生效日）
import { computed, reactive, ref } from 'vue'
import { FilePlus2, Printer } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import ReasonDialog from './ReasonDialog.vue'
import RecordCopyPrint from './RecordCopyPrint.vue'
import { checkCash, COPY_KIND_LABEL, COPY_PURPOSES, COPY_RELATIONS, copyApi, copyFee, type CopyPrint, type RecordCopyView } from '@/services'
import type { CopyItemKind, PayMethod } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'

const props = defineProps<{ patientId: string }>()
const ui = useUi()
const { data: list, loading } = useQuery(() => copyApi.listRecordCopies(props.patientId), [() => props.patientId])

// ---------- 新申請 ----------
const open = ref(false)
const { data: src } = useQuery(async () => (open.value ? copyApi.copySources(props.patientId) : undefined), [open, () => props.patientId])
const form = reactive({ kind: 'self' as 'self' | 'agent', name: '', idNo: '', relation: '' as string | number | undefined, authorizationChecked: false, purpose: '' as string | number | undefined, payMethod: 'cash' as PayMethod, received: undefined as number | undefined })
const picked = ref<string[]>([])
const kindFilter = ref<CopyItemKind | ''>('')
function openNew() {
  Object.assign(form, { kind: 'self', name: '', idNo: '', relation: '', authorizationChecked: false, purpose: '', payMethod: 'cash', received: undefined })
  picked.value = []
  kindFilter.value = ''
  create.fieldErrors.value = {}
  open.value = true
}
const key = (s: { kind: string; refId: string }) => `${s.kind}|${s.refId}`
const shown = computed(() => (src.value?.sources ?? []).filter((s) => !kindFilter.value || s.kind === kindFilter.value))
const toggle = (k: string, on: boolean) => (picked.value = on ? [...new Set([...picked.value, k])] : picked.value.filter((x) => x !== k))
const allShown = computed(() => shown.value.length > 0 && shown.value.every((s) => picked.value.includes(key(s))))
const toggleAll = (on: boolean) => (picked.value = on ? [...new Set([...picked.value, ...shown.value.map(key)])] : picked.value.filter((k) => !shown.value.some((s) => key(s) === k)))
const pages = computed(() => (src.value?.sources ?? []).filter((s) => picked.value.includes(key(s))).reduce((n, s) => n + s.pages, 0))
const amount = computed(() => (src.value ? copyFee(src.value.fee.base, src.value.fee.perPage, pages.value) : 0))
const cashProblem = computed(() => (form.payMethod === 'cash' && form.received !== undefined ? checkCash(amount.value, form.received) : null))

const create = useAction(copyApi.createRecordCopy)
async function submit() {
  const r = await create.run({
    patientId: props.patientId,
    applicant: { kind: form.kind, name: form.name, idNo: form.idNo, ...(form.kind === 'agent' ? { relation: String(form.relation ?? ''), authorizationChecked: form.authorizationChecked } : {}) },
    purpose: String(form.purpose ?? ''),
    items: picked.value.map((k) => ({ kind: k.split('|')[0] as CopyItemKind, refId: k.split('|')[1] })),
    payMethod: form.payMethod,
    ...(form.payMethod === 'cash' ? { received: form.received } : {}),
  })
  if (!r) return
  open.value = false
  ui.toast.success(`已收費 ${r.amount} 元（收據 ${r.receiptNo}）${r.change ? `，找零 ${r.change} 元` : ''}`)
  await openPrint(r)
}

// ---------- 列印、作廢 ----------
const printing = ref<CopyPrint>()
const doPrint = useAction(copyApi.printRecordCopy)
async function openPrint(r: RecordCopyView) {
  const p = await doPrint.run(r.id)
  if (p) printing.value = p
}
const voiding = ref<RecordCopyView>()
const voidOpen = computed({ get: () => !!voiding.value, set: (v) => !v && (voiding.value = undefined) })
const voidAct = useAction(copyApi.voidRecordCopy, { success: '已作廢（收據一起作廢）' })
async function confirmVoid(reason: string) {
  if (voiding.value && (await voidAct.run(voiding.value.id, reason))) voiding.value = undefined
}
const printNow = () => window.print()
const PAY: Record<PayMethod, string> = { cash: '現金', card: '刷卡', mobile: '行動支付' }
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <div class="flex items-center gap-2">
      <p class="text-slate-500">病人本人或代理人申請病歷影本：核對證件、當場收費、列印（每頁標「影本」）。</p>
      <UButton size="sm" class="ml-auto" :icon="FilePlus2" @click="openNew">新申請</UButton>
    </div>
    <UQueryState :loading="loading && !list" :ready="!!list">
      <p v-if="!list?.length" class="py-6 text-center text-slate-400">沒有申請紀錄</p>
      <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
        <li v-for="r in list" :key="r.id" :class="['px-3 py-2', r.voided && 'opacity-60']">
          <div class="flex flex-wrap items-center gap-2">
            <span class="tabular font-medium text-slate-800">{{ r.no }}</span>
            <UBadge v-if="r.voided" tone="gray">已作廢</UBadge>
            <UBadge v-else-if="r.printed.length" tone="green">已印 {{ r.printed.length }} 次</UBadge>
            <UBadge v-else tone="yellow">還沒印</UBadge>
            <span class="text-slate-600">{{ r.applicantText }}・{{ r.purpose }}・{{ r.items.length }} 項 {{ r.pages }} 頁</span>
            <span class="tabular text-xs text-slate-500">{{ r.createdAt.slice(0, 16) }}・{{ r.createdByName }}・收據 {{ r.receiptNo }} {{ r.amount }} 元（{{ PAY[r.payMethod] }}）</span>
            <span class="ml-auto flex gap-1.5">
              <UButton v-if="!r.voided" size="sm" variant="secondary" :icon="Printer" :loading="doPrint.pending.value" @click="openPrint(r)">{{ r.printed.length ? '補印' : '列印' }}</UButton>
              <UButton v-if="r.canVoid" size="sm" variant="ghost" class="text-red-700" @click="voiding = r">作廢</UButton>
            </span>
          </div>
          <details class="mt-1 text-xs text-slate-500">
            <summary class="cursor-pointer">內容</summary>
            <ul class="mt-1 space-y-0.5"><li v-for="x in r.items" :key="x.kind + x.refId">{{ x.label }}</li></ul>
          </details>
          <p v-if="r.voided" class="text-xs text-slate-500">作廢：{{ r.voided.reason }}・{{ r.voidedByName }} {{ r.voided.at.slice(5).replace('-', '/') }}</p>
        </li>
      </ul>
    </UQueryState>

    <UDialog v-model="open" :title="`病歷影本申請：${src?.patientName ?? ''}`" size="lg" @submit="submit">
      <div v-if="src" class="space-y-3 text-sm">
        <fieldset class="flex flex-wrap gap-4">
          <label class="flex items-center gap-1.5"><input v-model="form.kind" type="radio" name="copy-kind" value="self" class="h-4 w-4 text-brand-600" />本人</label>
          <label class="flex items-center gap-1.5"><input v-model="form.kind" type="radio" name="copy-kind" value="agent" class="h-4 w-4 text-brand-600" />代理人</label>
        </fieldset>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UInput v-model="form.name" label="申請人姓名" required :error="create.fieldErrors.value.name" />
          <UInput v-model="form.idNo" label="申請人身分證號" required :error="create.fieldErrors.value.idNo" />
          <template v-if="form.kind === 'agent'">
            <USelect v-model="form.relation" label="和病人的關係" required :options="COPY_RELATIONS" placeholder="選擇關係" :error="create.fieldErrors.value.relation" />
            <div class="pt-6">
              <UCheckbox v-model="form.authorizationChecked" label="已核對病人的委託書（或關係證明）" />
              <p v-if="create.fieldErrors.value.authorizationChecked" class="text-xs text-red-600">{{ create.fieldErrors.value.authorizationChecked }}</p>
            </div>
          </template>
          <USelect v-model="form.purpose" label="用途" required :options="COPY_PURPOSES" placeholder="選擇用途" :error="create.fieldErrors.value.purpose" />
        </div>
        <p v-if="form.kind === 'self'" class="text-xs text-slate-500">本人申請：姓名、身分證號要和病人資料一樣（核對證件）。</p>

        <div class="space-y-1.5">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium text-slate-700">要影印的紀錄</span>
            <button v-for="k in (['', 'opd', 'discharge', 'lab', 'imaging'] as const)" :key="k" type="button" :class="['rounded border px-2 py-0.5 text-xs', kindFilter === k ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-300 hover:bg-slate-100']" @click="kindFilter = k">
              {{ k ? COPY_KIND_LABEL[k] : '全部' }}
            </button>
            <UCheckbox class="ml-auto" :model-value="allShown" label="全選" @update:model-value="toggleAll" />
          </div>
          <p v-if="!src.sources.length" class="text-slate-500">這位病人沒有可以影印的紀錄。</p>
          <ul v-else class="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200">
            <li v-for="s in shown" :key="key(s)" class="px-2 py-1">
              <UCheckbox :model-value="picked.includes(key(s))" :label="`${s.date}　${s.kindLabel}　${s.label}`" @update:model-value="(v) => toggle(key(s), v)" />
            </li>
          </ul>
          <p v-if="create.fieldErrors.value.items" class="text-xs text-red-600">{{ create.fieldErrors.value.items }}</p>
        </div>

        <div class="flex flex-wrap items-end gap-3 rounded-md bg-slate-50 p-3">
          <div>
            <div class="text-xs text-slate-500">基本費 {{ src.fee.base }} 元＋每頁 {{ src.fee.perPage }} 元 × {{ pages }} 頁</div>
            <div class="text-lg font-bold text-slate-800">應收 {{ amount }} 元</div>
          </div>
          <div class="w-32"><USelect v-model="form.payMethod" label="付款方式" :options="[{ label: '現金', value: 'cash' }, { label: '刷卡', value: 'card' }, { label: '行動支付', value: 'mobile' }]" /></div>
          <div v-if="form.payMethod === 'cash'" class="w-32"><UInput v-model="form.received" type="number" label="實收" :error="create.fieldErrors.value.received ?? cashProblem ?? undefined" /></div>
          <div v-if="form.payMethod === 'cash' && form.received !== undefined && !cashProblem" class="pb-2 text-slate-600">找零 {{ form.received - amount }} 元</div>
        </div>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton type="submit" :disabled="!picked.length" :loading="create.pending.value">收費並列印</UButton>
      </template>
    </UDialog>

    <UDialog :model-value="!!printing" :title="`病歷影本 ${printing?.no ?? ''}`" size="lg" @update:model-value="(v: boolean) => !v && (printing = undefined)">
      <RecordCopyPrint v-if="printing" :c="printing" />
      <template #footer>
        <UButton variant="secondary" @click="printing = undefined">關閉</UButton>
        <UButton :icon="Printer" @click="printNow">列印（{{ printing?.pages.length }} 頁）</UButton>
      </template>
    </UDialog>

    <ReasonDialog
      v-model="voidOpen"
      title="作廢病歷影本申請"
      :subject="voiding ? `${voiding.no}・收據 ${voiding.receiptNo} ${voiding.amount} 元（一起作廢）` : ''"
      label="作廢原因"
      :presets="['申請人改變主意，已退還現金', '選錯項目，重新申請', '收錯金額']"
      ok-text="作廢"
      danger
      :pending="voidAct.pending.value"
      :error="voidAct.fieldErrors.value.reason"
      @confirm="confirmVoid"
    />
  </div>
</template>
