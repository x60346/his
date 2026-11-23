<script setup lang="ts">
// 管路（護理站病人分頁「管路」、住院醫囑分頁「管路」共用）：在身上的管路——放了幾天（幾小時）、部位尺寸放置者、
// 提醒（今天還沒評估還需要嗎、評估可移除、留置針滿 96 小時、滿 7 天請主治評估）；每天評估、移除寫原因；登錄放置；已移除的紀錄。
// 提醒只提醒不擋；判斷都在 line-rules（服務層回 state，畫面只顯示）
import { computed, reactive, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState, USelect, UTextarea } from '@/components/ui'
import { CHEST_APPEARANCES, CHEST_BLEED_MLH, CONSENT_LINE_KINDS, LINE_CONSENT_WAIVERS, lineApi, LINE_KINDS, LINE_REMOVE_REASONS, lineKind, type LineView } from '@/services'
import type { LineKind } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { now } from '@/utils/date'

const props = defineProps<{ admissionId: string }>()
const auth = useAuth()
const { data, loading } = useQuery(async () => ({ id: props.admissionId, v: await lineApi.listLines(props.admissionId) }), [() => props.admissionId])
const lines = computed(() => (data.value?.id === props.admissionId ? data.value.v : undefined))
const ageText = (l: LineView) => (l.state.hours < 72 ? `${l.state.hours} 小時` : `第 ${l.state.day} 天`)

// ---------- 登錄放置 ----------
const addOpen = ref(false)
const form = reactive({ kind: 'pivc' as LineKind, site: '', size: '', insertedAt: '', placedBy: '', consentWaiver: '' })
const meta = computed(() => lineKind(form.kind))
// 中心靜脈導管、胃造口：要有還沒用掉的侵入性處置同意書；沒有的話只能選「緊急」或「外院已放置」
const needConsent = computed(() => CONSENT_LINE_KINDS.includes(form.kind))
const consentReady = computed(() => !!lines.value?.consentReady.includes(form.kind))
function openAdd() {
  Object.assign(form, { kind: 'pivc', site: '', size: '', insertedAt: now().slice(0, 16).replace(' ', 'T'), placedBy: auth.user?.name ?? '', consentWaiver: '' })
  add.fieldErrors.value = {}
  addOpen.value = true
}
const add = useAction(lineApi.addLine, { success: (l) => `已登錄${l.label}（${l.site}）` })
async function submitAdd() {
  const { consentWaiver, ...rest } = form
  if (await add.run({ admissionId: props.admissionId, ...rest, insertedAt: form.insertedAt.replace('T', ' '), ...(needConsent.value && !consentReady.value && consentWaiver ? { consentWaiver } : {}) })) addOpen.value = false
}

// ---------- 每天評估 ----------
const need = useAction(lineApi.checkLineNeed, { success: (l) => `${l.label}：${l.needChecks.at(-1)?.needed ? '還需要' : '可以移除'}` })
const notNeed = ref<LineView>()
const notNeedOpen = computed({ get: () => !!notNeed.value, set: (x) => !x && (notNeed.value = undefined) })
const notNeedNote = ref('')
async function submitNotNeed() {
  if (notNeed.value && (await need.run(notNeed.value.id, false, notNeedNote.value))) notNeed.value = undefined
}

// ---------- 胸管引流 ----------
// 胸管在「床邊處置」登錄，這裡不能選
const addKinds = LINE_KINDS.filter((k) => !k.bedsideOnly)
const dr = ref<LineView>()
const drOpen = computed({ get: () => !!dr.value, set: (x) => !x && (dr.value = undefined) })
const drForm = reactive({ ml: '' as string | number, appearance: '', airLeak: false })
function openDr(l: LineView) {
  const last = l.drainage?.at(-1)
  Object.assign(drForm, { ml: '', appearance: last?.appearance ?? '', airLeak: !!last?.airLeak })
  drain.fieldErrors.value = {}
  dr.value = l
}
const drain = useAction(lineApi.recordDrainage, { success: (l) => `已記引流：24 小時 ${l.state.chest?.ml24 ?? 0} mL` })
async function submitDr() {
  if (dr.value && (await drain.run(dr.value.id, { ml: drForm.ml, appearance: drForm.appearance, airLeak: drForm.airLeak }))) dr.value = undefined
}

// ---------- 移除 ----------
const rm = ref<LineView>()
const rmOpen = computed({ get: () => !!rm.value, set: (x) => !x && (rm.value = undefined) })
const rmForm = reactive({ reason: '' as string | number | undefined, note: '' })
function openRm(l: LineView) {
  Object.assign(rmForm, { reason: l.state.removable ? '不需要了' : l.state.replaceDue ? '到期更換' : '', note: '' })
  remove.fieldErrors.value = {}
  rm.value = l
}
const remove = useAction(lineApi.removeLine, { success: (l) => `已移除${l.label}：${l.removeReason}` })
async function submitRm() {
  if (rm.value && (await remove.run(rm.value.id, String(rmForm.reason ?? ''), rmForm.note))) rm.value = undefined
}
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <div class="flex items-center justify-between">
      <span class="font-semibold text-slate-700">管路</span>
      <UButton size="sm" variant="secondary" :icon="Plus" @click="openAdd">登錄放置</UButton>
    </div>
    <UQueryState :loading="loading && !lines" :ready="!!lines" >
      <template v-if="lines">
        <p v-if="!lines.active.length" class="rounded-md border border-slate-200 px-3 py-4 text-center text-slate-400">目前沒有管路</p>
        <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
          <li v-for="l in lines.active" :key="l.id" class="space-y-1 px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <b class="text-slate-800">{{ l.label }}</b>
              <span class="text-slate-600">{{ l.site }}・{{ l.size }}</span>
              <span class="tabular text-xs text-slate-500">{{ l.insertedAt.slice(5) }} 放置（{{ l.placedBy }}）・已放 {{ ageText(l) }}</span>
              <span v-if="l.consentNo" class="text-xs text-slate-500">同意書 {{ l.consentNo }}</span>
              <UBadge v-else-if="l.consentWaiver" tone="gray" :title="l.consentWaiver">無同意書：{{ l.consentWaiver.startsWith('緊急') ? '緊急' : '外院放置' }}</UBadge>
              <template v-if="l.state.chest">
                <span class="text-xs text-slate-600">24 小時 {{ l.state.chest.ml24 }} mL<template v-if="l.state.chest.lastAt">・最近 {{ l.state.chest.lastAt.slice(5) }}</template></span>
                <UBadge v-if="l.state.chest.airLeak" tone="yellow">漏氣</UBadge>
                <UBadge v-if="l.state.chest.bleeding" tone="red">每小時 {{ l.state.chest.lastRate }} mL（≥{{ CHEST_BLEED_MLH }}）：通知醫師</UBadge>
                <UBadge v-if="l.state.chest.recordDue" tone="cyan">該記引流量了</UBadge>
                <UBadge v-if="l.state.chest.removeHint" tone="yellow">可評估拔管</UBadge>
              </template>
              <UBadge v-if="l.state.attendingAlert" tone="red">滿 7 天：請主治評估</UBadge>
              <UBadge v-if="l.state.replaceDue" tone="red">滿 96 小時：請更換</UBadge>
              <UBadge v-if="l.state.removable" tone="yellow">評估可移除</UBadge>
              <UBadge v-else-if="l.state.needCheckDue" tone="cyan">今天還沒評估</UBadge>
            </div>
            <details v-if="l.drainage?.length" class="text-xs text-slate-600">
              <summary class="cursor-pointer">引流紀錄 {{ l.drainage.length }} 筆</summary>
              <ul class="mt-1 space-y-0.5">
                <li v-for="d in [...l.drainage].reverse()" :key="d.at" class="tabular">{{ d.at.slice(5) }}・{{ d.ml }} mL・{{ d.appearance }}{{ d.airLeak ? '・漏氣' : '' }}</li>
              </ul>
            </details>
            <div v-if="l.needChecks.length" class="text-xs text-slate-500">最近評估：{{ l.needChecks.at(-1)!.at.slice(5) }} {{ l.needChecks.at(-1)!.byName }}・{{ l.needChecks.at(-1)!.needed ? '還需要' : `可以移除（${l.needChecks.at(-1)!.note}）` }}</div>
            <div class="flex flex-wrap gap-1.5">
              <template v-if="lineKind(l.kind).dailyNeed">
                <UButton size="sm" variant="secondary" :loading="need.pending.value" @click="need.run(l.id, true)">還需要</UButton>
                <UButton size="sm" variant="secondary" @click="(notNeedNote = ''), (notNeed = l)">可以移除</UButton>
              </template>
              <UButton v-if="l.kind === 'chest'" size="sm" variant="secondary" @click="openDr(l)">記引流量</UButton>
              <UButton size="sm" variant="ghost" @click="openRm(l)">移除</UButton>
            </div>
          </li>
        </ul>
        <details v-if="lines.removed.length" class="text-xs text-slate-600">
          <summary class="cursor-pointer">已移除 {{ lines.removed.length }} 條</summary>
          <ul class="mt-1 space-y-0.5">
            <li v-for="l in lines.removed" :key="l.id">{{ l.label }} {{ l.site }} {{ l.size }}・{{ l.insertedAt.slice(5) }} → {{ l.removedAt!.slice(5) }}（{{ l.state.day }} 天）・{{ l.removeReason }}・{{ l.removedByName }}</li>
          </ul>
        </details>
        <p class="text-xs text-slate-500">導尿管、中心靜脈導管每天評估還需要嗎，滿 7 天提醒主治；周邊留置針滿 96 小時提醒更換；胸管每班記引流量（每小時 ≥200 mL 通知醫師，24 小時 &lt;200 mL 又沒漏氣可評估拔管）。胸管在住院醫囑「床邊處置」登錄。只提醒，不擋。</p>
      </template>
    </UQueryState>

    <UDialog v-model="addOpen" title="登錄管路放置" @submit="submitAdd">
      <div class="space-y-3 text-sm">
        <div class="flex flex-wrap gap-2">
          <label v-for="k in addKinds" :key="k.kind" :class="['cursor-pointer rounded-md border-2 px-3 py-1', form.kind === k.kind ? 'border-brand-500 bg-brand-50' : 'border-slate-200']">
            <input v-model="form.kind" type="radio" :value="k.kind" class="sr-only" @change="(form.site = ''), (form.size = ''), (form.consentWaiver = '')" />{{ k.label }}
          </label>
        </div>
        <div v-if="needConsent" :class="['rounded-md border px-3 py-2', consentReady ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50']">
          <p v-if="consentReady" class="text-green-800">侵入性處置同意書已簽，登錄後這張同意書就算用掉了。</p>
          <template v-else>
            <p class="text-amber-800">{{ meta.label }}要先有侵入性處置同意書（醫師在病患資料「同意書」分頁記錄）。緊急或外院已放置的，選原因才能登錄：</p>
            <USelect v-model="form.consentWaiver" class="mt-1" label="沒有同意書的原因" :options="[{ label: '（請選）', value: '' }, ...LINE_CONSENT_WAIVERS.map((w) => ({ label: w, value: w }))]" :error="add.fieldErrors.value.consentWaiver" />
          </template>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <UInput v-model="form.site" label="部位" required :error="add.fieldErrors.value.site" />
            <div class="mt-1 flex flex-wrap gap-1"><button v-for="s in meta.sites" :key="s" type="button" class="rounded border border-slate-300 px-1.5 text-xs hover:bg-slate-100" @click="form.site = s">{{ s }}</button></div>
          </div>
          <div>
            <UInput v-model="form.size" label="尺寸" required :error="add.fieldErrors.value.size" />
            <div class="mt-1 flex flex-wrap gap-1"><button v-for="s in meta.sizes" :key="s" type="button" class="rounded border border-slate-300 px-1.5 text-xs hover:bg-slate-100" @click="form.size = s">{{ s }}</button></div>
          </div>
          <UInput v-model="form.insertedAt" type="datetime-local" label="放置時間" required :error="add.fieldErrors.value.insertedAt" />
          <UInput v-model="form.placedBy" label="放置者" required hint="醫師、外院放的寫實際的人或醫院" :error="add.fieldErrors.value.placedBy" />
        </div>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="addOpen = false">取消</UButton>
        <UButton type="submit" :loading="add.pending.value">登錄</UButton>
      </template>
    </UDialog>

    <UDialog v-model="notNeedOpen" :title="`評估可以移除：${notNeed?.label ?? ''}`" size="sm" @submit="submitNotNeed">
      <UTextarea v-model="notNeedNote" label="依據" :rows="2" required placeholder="例：已可自解、意識清楚可下床" :error="need.fieldErrors.value.note" />
      <template #footer>
        <UButton variant="secondary" @click="notNeedOpen = false">取消</UButton>
        <UButton type="submit" :loading="need.pending.value">送出</UButton>
      </template>
    </UDialog>

    <UDialog v-model="drOpen" :title="`記引流量：胸管（${dr?.site ?? ''}）`" size="sm" @submit="submitDr">
      <div class="space-y-3 text-sm">
        <UInput v-model="drForm.ml" type="number" label="這一段的引流量（mL）" required :hint="dr?.drainage?.at(-1) ? `上一筆 ${dr.drainage.at(-1)!.at.slice(5)} 之後` : undefined" :error="drain.fieldErrors.value.ml" />
        <div>
          <div class="mb-1 text-slate-700">外觀</div>
          <div class="flex flex-wrap gap-1.5">
            <label v-for="a in CHEST_APPEARANCES" :key="a" :class="['cursor-pointer rounded-md border-2 px-2 py-0.5', drForm.appearance === a ? 'border-brand-500 bg-brand-50' : 'border-slate-200']"><input v-model="drForm.appearance" type="radio" :value="a" class="sr-only" />{{ a }}</label>
          </div>
          <p v-if="drain.fieldErrors.value.appearance" class="mt-1 text-xs text-red-600">{{ drain.fieldErrors.value.appearance }}</p>
        </div>
        <UCheckbox v-model="drForm.airLeak" label="水封瓶有氣泡（漏氣）" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="drOpen = false">取消</UButton>
        <UButton type="submit" :loading="drain.pending.value">記錄</UButton>
      </template>
    </UDialog>

    <UDialog v-model="rmOpen" :title="`移除：${rm?.label ?? ''}（${rm?.site ?? ''}）`" size="sm" @submit="submitRm">
      <div class="space-y-3">
        <USelect v-model="rmForm.reason" label="原因" required placeholder="選擇原因" :options="LINE_REMOVE_REASONS.map((r) => ({ label: r, value: r }))" :error="remove.fieldErrors.value.reason" />
        <UInput v-model="rmForm.note" :label="rmForm.reason === '其他' ? '說明' : '說明（選填）'" :required="rmForm.reason === '其他'" :error="remove.fieldErrors.value.note" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="rmOpen = false">取消</UButton>
        <UButton type="submit" :loading="remove.pending.value">移除</UButton>
      </template>
    </UDialog>
  </div>
</template>
