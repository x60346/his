<script setup lang="ts">
// 隔離與 DNR（護理站、醫師住院醫囑頁的分頁）：
//   - 隔離：醫師、護理師開；要檢討時（前次就醫開的、滿 14 天）按「確認延續」；解除只限醫師、要原因
//   - DNR／預立醫療決定：醫師登錄（文件要件由服務層檢查）、撤回要原因；新文件取代舊的，紀錄都留著
// 住進來之後才開的隔離，目前的床可能不合（同房有沒隔離的人、空氣隔離不在單人房）：上方紅條提醒安排轉床
import { computed, reactive, ref } from 'vue'
import { ShieldPlus, FileSignature } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import ReasonDialog from './ReasonDialog.vue'
import {
  DNR_DOC_LABEL, DNR_ITEMS, DNR_CPR_ITEMS, DNR_RELATIONS, flagApi, ISOLATION_KIND_LABEL, ISOLATION_PRESETS, ISOLATION_REVIEW_TEXT, masterApi,
  type DnrView, type IsolationView,
} from '@/services'
import type { DnrDoc, DnrItem, IsolationKind } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import { today } from '@/utils/date'

const props = defineProps<{ patientId: string }>()
const auth = useAuth()
const ui = useUi()
const isDoctor = computed(() => auth.user?.role === 'doctor')
const canIsolate = computed(() => auth.user?.role === 'doctor' || auth.user?.role === 'nurse')
const { data, loading } = useQuery(() => flagApi.getPatientFlags(props.patientId), [() => props.patientId])
const f = computed(() => (data.value?.patientId === props.patientId ? data.value : undefined))
const { data: doctors } = useQuery(() => masterApi.listDoctors(undefined, true))

// ---------- 開始隔離 ----------
const KINDS: IsolationKind[] = ['contact', 'droplet', 'airborne']
const isoOpen = ref(false)
const iso = reactive({ kind: 'contact' as IsolationKind, organism: '', note: '' })
function openIso() {
  Object.assign(iso, { kind: 'contact', organism: '', note: '' })
  start.fieldErrors.value = {}
  isoOpen.value = true
}
const start = useAction(flagApi.startIsolation, { success: (r) => `已開始${ISOLATION_KIND_LABEL[r.isolation.kind]}（${r.isolation.organism}）` })
async function submitIso() {
  const r = await start.run({ patientId: props.patientId, ...iso })
  if (!r) return
  isoOpen.value = false
  if (r.placementWarning) ui.toast.warning(`請安排轉床：${r.placementWarning}`)
}

// ---------- 檢討、解除 ----------
const review = useAction(flagApi.reviewIsolation, { success: '已確認延續隔離（重新起算 14 天）' })
const ending = ref<IsolationView>()
const endOpen = computed({ get: () => !!ending.value, set: (v) => !v && (ending.value = undefined) })
const end = useAction(flagApi.endIsolation, { success: (i) => (i.ended?.exception ? '已例外解除隔離' : '已解除隔離') })
const endF = reactive({ reason: '', exception: false, symptomFree24h: false })
function openEnd(i: IsolationView) {
  Object.assign(endF, { reason: '', exception: false, symptomFree24h: false })
  end.fieldErrors.value = {}
  ending.value = i
}
async function confirmEnd() {
  if (ending.value && (await end.run(ending.value.id, endF.reason, { exception: endF.exception, symptomFree24h: endF.symptomFree24h }))) ending.value = undefined
}
// 建議醫囑：勾選後一次開（同一筆隔離開過的不能再勾）
const picks = reactive<Record<string, string[]>>({})
const togglePick = (isoId: string, key: string, on: boolean) => (picks[isoId] = on ? [...new Set([...(picks[isoId] ?? []), key])] : (picks[isoId] ?? []).filter((k) => k !== key))
const bundleAct = useAction(flagApi.orderIsolationBundle, { success: '已開立隔離相關醫囑（護理站核對後執行）' })
async function orderBundle(i: IsolationView) {
  if (await bundleAct.run(i.id, picks[i.id] ?? [])) picks[i.id] = []
}

// ---------- DNR ----------
const DOCS: DnrDoc[] = ['self', 'family', 'ad']
const dnrOpen = ref(false)
const dnr = reactive({ doc: 'self' as DnrDoc, signedAt: today(), signerName: '', relation: '' as string | number | undefined, w1: '', w2: '', d1: '' as string | number | undefined, d2: '' as string | number | undefined, acpDate: '', withhold: [...DNR_CPR_ITEMS] as DnrItem[], nhiCard: false })
function openDnr() {
  Object.assign(dnr, { doc: 'self', signedAt: today(), signerName: '', relation: '', w1: '', w2: '', d1: auth.user?.doctorId ?? '', d2: '', acpDate: '', withhold: [...DNR_CPR_ITEMS], nhiCard: false })
  save.fieldErrors.value = {}
  dnrOpen.value = true
}
const items = computed(() => DNR_ITEMS.filter((i) => i.key !== 'feeding' || dnr.doc === 'ad'))
function toggleItem(k: DnrItem, on: boolean) {
  dnr.withhold = on ? [...new Set([...dnr.withhold, k])] : dnr.withhold.filter((x) => x !== k)
}
const save = useAction(flagApi.saveDnr, { success: (d) => `已登錄 ${d.label}` })
async function submitDnr() {
  const withhold = dnr.withhold.filter((k) => k !== 'feeding' || dnr.doc === 'ad')
  const ok = await save.run({
    patientId: props.patientId, doc: dnr.doc, signedAt: dnr.signedAt, withhold, nhiCard: dnr.nhiCard,
    ...(dnr.doc === 'family' ? { signerName: dnr.signerName, relation: String(dnr.relation ?? ''), doctorIds: [String(dnr.d1 ?? ''), String(dnr.d2 ?? '')] } : { witnesses: [dnr.w1, dnr.w2] }),
    ...(dnr.doc === 'ad' ? { acpDate: dnr.acpDate } : {}),
  })
  if (ok) dnrOpen.value = false
}
const revoking = ref<DnrView>()
const revokeOpen = computed({ get: () => !!revoking.value, set: (v) => !v && (revoking.value = undefined) })
const revoke = useAction(flagApi.revokeDnr, { success: '已撤回 DNR' })
async function confirmRevoke(reason: string) {
  if (revoking.value && (await revoke.run(revoking.value.id, reason))) revoking.value = undefined
}
const docWho = (d: DnrView) =>
  d.doc === 'family' ? `${d.signerName}（${d.relation}）簽署；確認醫師 ${d.doctorNames.join('、')}` : `見證人 ${d.witnesses?.join('、')}${d.acpDate ? `；諮商 ${d.acpDate}` : ''}`
</script>

<template>
  <div class="space-y-4 p-4 text-sm">
    <UQueryState :loading="loading && !f" :ready="!!f">
      <template v-if="f">
        <p v-if="f.placementWarning" class="rounded-md border border-red-300 bg-red-50 px-3 py-2 font-medium text-red-800" role="alert">請安排轉床：{{ f.placementWarning }}</p>
        <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <!-- 隔離 -->
          <section class="space-y-2 rounded-md border border-slate-200 p-3">
            <div class="flex items-center gap-2">
              <h3 class="font-semibold text-slate-700">隔離</h3>
              <UBadge v-if="!f.isolations.length" tone="gray">沒有隔離</UBadge>
              <UButton v-if="canIsolate" size="sm" class="ml-auto" :icon="ShieldPlus" @click="openIso">開始隔離</UButton>
            </div>
            <ul v-if="f.isolations.length" class="space-y-2">
              <li v-for="i in f.isolations" :key="i.id" class="rounded border border-amber-200 bg-amber-50/50 px-3 py-2">
                <div class="flex flex-wrap items-center gap-2">
                  <UBadge :tone="i.kind === 'airborne' ? 'red' : i.kind === 'droplet' ? 'cyan' : 'yellow'">{{ ISOLATION_KIND_LABEL[i.kind] }}</UBadge>
                  <b class="text-slate-800">{{ i.organism }}</b>
                  <span class="tabular text-xs text-slate-500">{{ i.startedAt.slice(0, 16) }} 起・第 {{ i.days }} 天・{{ i.startedByName }}</span>
                </div>
                <p v-if="i.note" class="mt-0.5 text-xs text-slate-600">{{ i.note }}</p>
                <p v-if="i.reviewedAt" class="text-xs text-slate-500">上次檢討：{{ i.reviewedAt.slice(5) }} {{ i.reviewedByName }}</p>
                <p v-if="i.review" class="mt-1 text-xs font-semibold text-amber-800">{{ ISOLATION_REVIEW_TEXT[i.review] }}</p>
                <p class="mt-1 text-xs text-slate-700">防護：<b>{{ i.ppe.join('、') }}</b><template v-if="i.release">　解除條件：<span :class="i.release.met ? 'text-emerald-700' : 'text-amber-800'">{{ i.release.met ? '已達到' : '未達到' }}（{{ i.release.text }}）</span></template></p>
                <div v-if="i.bundle && isDoctor && i.admissionId" class="mt-1 rounded bg-white/70 px-2 py-1 text-xs">
                  <div class="font-semibold text-slate-600">建議醫囑</div>
                  <div class="flex flex-wrap gap-x-4">
                    <UCheckbox v-for="b in i.bundle" :key="b.key" :model-value="b.ordered || (picks[i.id] ?? []).includes(b.key)" :disabled="b.ordered" :label="b.ordered ? `${b.label}（已開）` : b.label" @update:model-value="(x: boolean) => togglePick(i.id, b.key, x)" />
                  </div>
                  <UButton v-if="i.bundle.some((b) => !b.ordered)" class="mt-1" size="sm" variant="secondary" :disabled="!(picks[i.id] ?? []).length" :loading="bundleAct.pending.value" @click="orderBundle(i)">開立勾選的醫囑</UButton>
                </div>
                <div class="mt-1.5 flex gap-2">
                  <UButton v-if="canIsolate" size="sm" :variant="i.review ? 'primary' : 'secondary'" :loading="review.pending.value" @click="review.run(i.id)">確認延續</UButton>
                  <UButton v-if="isDoctor" size="sm" variant="secondary" @click="openEnd(i)">解除隔離</UButton>
                </div>
              </li>
            </ul>
            <p v-if="canIsolate && !isDoctor && f.isolations.length" class="text-xs text-slate-500">解除隔離由醫師決定。</p>
            <details v-if="f.ended.length" class="text-xs text-slate-500">
              <summary class="cursor-pointer">已解除 {{ f.ended.length }} 筆</summary>
              <ul class="mt-1 space-y-0.5">
                <li v-for="i in f.ended" :key="i.id">{{ ISOLATION_KIND_LABEL[i.kind] }}（{{ i.organism }}）{{ i.startedAt.slice(0, 10) }}～{{ i.ended!.at.slice(0, 10) }}：{{ i.ended!.reason }}・{{ i.endedByName }}</li>
              </ul>
            </details>
          </section>

          <!-- DNR -->
          <section class="space-y-2 rounded-md border border-slate-200 p-3">
            <div class="flex items-center gap-2">
              <h3 class="font-semibold text-slate-700">DNR／預立醫療決定</h3>
              <span v-if="f.dnr" class="rounded bg-slate-800 px-1.5 py-0.5 text-xs font-semibold text-white">{{ f.dnr.label }}</span>
              <UBadge v-else tone="gray">沒有</UBadge>
              <UButton v-if="isDoctor" size="sm" class="ml-auto" :icon="FileSignature" @click="openDnr">{{ f.dnr ? '登錄新文件' : '登錄 DNR' }}</UButton>
            </div>
            <div v-if="f.dnr" class="space-y-0.5 rounded border border-slate-300 bg-slate-50 px-3 py-2">
              <div class="font-medium text-slate-800">{{ f.dnr.docLabel }}</div>
              <div class="text-xs text-slate-600">{{ f.dnr.title }}</div>
              <div class="tabular text-xs text-slate-500">{{ f.dnr.signedAt }} 簽署・{{ docWho(f.dnr) }}・健保卡{{ f.dnr.nhiCard ? '已註記' : '未註記' }}</div>
              <div class="text-xs text-slate-500">{{ f.dnr.recordedAt.slice(5) }} {{ f.dnr.recordedByName }} 登錄</div>
              <UButton v-if="isDoctor" size="sm" variant="ghost" class="mt-1 text-red-700" @click="revoking = f.dnr">撤回</UButton>
            </div>
            <p v-if="!isDoctor" class="text-xs text-slate-500">DNR 由醫師登錄、撤回。</p>
            <ul v-if="f.dnrHistory.length" class="divide-y divide-slate-100 rounded border border-slate-100 text-xs text-slate-400">
              <li v-for="d in f.dnrHistory" :key="d.id" class="px-2 py-1">
                <span class="line-through">{{ d.signedAt }} {{ d.label }}（{{ d.docLabel }}）</span>
                <span class="ml-1 text-slate-500">{{ d.revoked?.reason }}・{{ d.revokedByName }} {{ d.revoked?.at.slice(5) }}</span>
              </li>
            </ul>
          </section>
        </div>
      </template>
    </UQueryState>

    <UDialog v-model="isoOpen" :title="`開始隔離：${f?.patientName ?? ''}`" @submit="submitIso">
      <div class="space-y-3">
        <fieldset class="flex flex-wrap gap-4">
          <label v-for="k in KINDS" :key="k" class="flex items-center gap-1.5">
            <input v-model="iso.kind" type="radio" name="iso-kind" :value="k" class="h-4 w-4 text-brand-600" />{{ ISOLATION_KIND_LABEL[k] }}
          </label>
        </fieldset>
        <p v-if="iso.kind === 'airborne'" class="text-xs text-red-700">空氣隔離只能住單人房（示範資料沒有負壓病房，以單人房代替）。</p>
        <UInput v-model="iso.organism" label="原因或菌種" required :error="start.fieldErrors.value.organism" />
        <div class="flex flex-wrap gap-1.5">
          <button v-for="p in ISOLATION_PRESETS[iso.kind]" :key="p" type="button" class="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100" @click="iso.organism = p">{{ p }}</button>
        </div>
        <UInput v-model="iso.note" label="備註（選填，例：傷口培養、門診驗出）" />
        <p class="text-xs text-slate-500">同房的病人要隔離完全一樣才能住一起；出院不會自動解除（下次住院要確認是否延續）。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="isoOpen = false">取消</UButton>
        <UButton type="submit" :loading="start.pending.value">開始隔離</UButton>
      </template>
    </UDialog>

    <UDialog v-model="dnrOpen" :title="`登錄 DNR：${f?.patientName ?? ''}`" size="lg" @submit="submitDnr">
      <div class="space-y-3">
        <fieldset class="space-y-1">
          <label v-for="d in DOCS" :key="d" class="flex items-center gap-1.5">
            <input v-model="dnr.doc" type="radio" name="dnr-doc" :value="d" class="h-4 w-4 text-brand-600" />{{ DNR_DOC_LABEL[d] }}
          </label>
        </fieldset>
        <p v-if="f?.dnr" class="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">已有一份有效的（{{ f.dnr.label }}），登錄後由新文件取代。</p>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UInput v-model="dnr.signedAt" type="date" label="簽署日期" required :error="save.fieldErrors.value.signedAt" />
          <UInput v-if="dnr.doc === 'ad'" v-model="dnr.acpDate" type="date" label="預立醫療照護諮商日期" required :error="save.fieldErrors.value.acpDate" />
        </div>
        <div v-if="dnr.doc === 'family'" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UInput v-model="dnr.signerName" label="簽署的家屬" required :error="save.fieldErrors.value.signerName" />
          <USelect v-model="dnr.relation" label="和病人的關係" required :options="DNR_RELATIONS" placeholder="選擇關係" :error="save.fieldErrors.value.relation" />
          <USelect v-model="dnr.d1" label="確認醫師（一）" :options="(doctors ?? []).map((d) => ({ label: d.name, value: d.id }))" placeholder="選擇醫師" />
          <USelect v-model="dnr.d2" label="確認醫師（二）" :options="(doctors ?? []).map((d) => ({ label: d.name, value: d.id }))" placeholder="選擇醫師" :error="save.fieldErrors.value.doctorIds" />
          <p class="text-xs text-slate-500 sm:col-span-2">病人意識不清時由最近親屬簽；要兩位專科醫師確認為末期病人。</p>
        </div>
        <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UInput v-model="dnr.w1" label="見證人（一）" required />
          <UInput v-model="dnr.w2" label="見證人（二）" required :error="save.fieldErrors.value.witnesses" />
        </div>
        <fieldset class="rounded-md border border-slate-200 px-3 py-2">
          <legend class="px-1 font-medium text-slate-700">不施行的項目</legend>
          <div class="mb-1 flex gap-3 text-xs">
            <button type="button" class="text-brand-700 underline" @click="dnr.withhold = [...DNR_CPR_ITEMS]">全部（完整 DNR）</button>
            <button type="button" class="text-slate-500 underline" @click="dnr.withhold = []">清除</button>
          </div>
          <div class="flex flex-wrap gap-x-4 gap-y-1">
            <UCheckbox v-for="i in items" :key="i.key" :model-value="dnr.withhold.includes(i.key)" :label="i.label" @update:model-value="(v) => toggleItem(i.key, v)" />
          </div>
          <p v-if="save.fieldErrors.value.withhold" class="mt-1 text-xs text-red-600">{{ save.fieldErrors.value.withhold }}</p>
          <p class="mt-1 text-xs text-slate-500">沒勾的照常施行（部分 DNR）；畫面上會寫出不做哪些。</p>
        </fieldset>
        <UCheckbox v-model="dnr.nhiCard" label="已註記健保卡" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="dnrOpen = false">取消</UButton>
        <UButton type="submit" :loading="save.pending.value">登錄</UButton>
      </template>
    </UDialog>

    <UDialog v-model="endOpen" title="解除隔離" size="sm" @submit="confirmEnd">
      <div v-if="ending" class="space-y-2 text-sm">
        <p class="text-slate-700">{{ ISOLATION_KIND_LABEL[ending.kind] }}（{{ ending.organism }}），第 {{ ending.days }} 天</p>
        <p v-if="ending.release" :class="ending.release.met ? 'text-emerald-700' : 'text-amber-800'">解除條件：{{ ending.release.met ? '已達到' : '未達到' }}（{{ ending.release.text }}）</p>
        <UCheckbox v-if="ending.kind === 'droplet' && !ending.release?.met" v-model="endF.symptomFree24h" label="我確認症狀緩解已滿 24 小時" />
        <UCheckbox v-if="!ending.release?.met && !(ending.kind === 'droplet' && endF.symptomFree24h)" v-model="endF.exception" label="例外解除（沒達到條件，原因寫在下面）" />
        <UInput v-model="endF.reason" label="解除原因（紀錄會留著）" :error="end.fieldErrors.value.reason" placeholder="例：痰液抗酸菌塗片三套陰性" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="endOpen = false">取消</UButton>
        <UButton type="submit" :loading="end.pending.value">解除</UButton>
      </template>
    </UDialog>
    <ReasonDialog
      v-model="revokeOpen"
      title="撤回 DNR"
      :subject="revoking ? `${revoking.label}（${revoking.docLabel}）` : ''"
      label="撤回原因（紀錄會留著、劃線）"
      :presets="['病人本人撤回意願', '家屬撤回同意', '登錄錯誤']"
      ok-text="撤回"
      danger
      :pending="revoke.pending.value"
      :error="revoke.fieldErrors.value.reason"
      @confirm="confirmRevoke"
    />
  </div>
</template>
