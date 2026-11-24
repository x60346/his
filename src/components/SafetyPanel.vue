<script setup lang="ts">
// 譫妄與約束（護理站病人分頁、住院醫囑分頁共用）：
//   - 譫妄 CAM：護理師逐項勾，結果即時算（和服務層同一個 camPositive）；65 歲以上、術後 72 小時內每班評；陽性主治按「確認」
//   - 身體約束：醫師「開約束醫囑」（24 小時）、護理師「緊急約束」（1 小時內要補醫囑）；每 2 小時查核；醫師補醫囑或續開；解除寫原因
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import { CAM_ITEMS, camPositive, deliriumApi, RESTRAINT_END_REASONS, RESTRAINT_METHODS, RESTRAINT_REASONS, RESTRAINT_SITES, type RestraintView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'

const props = defineProps<{ admissionId: string }>()
const auth = useAuth()
const isNurse = computed(() => auth.user?.role === 'nurse')
const { data, loading } = useQuery(() => deliriumApi.patientSafety(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const orderText = (r: RestraintView) =>
  ({ ok: `醫囑有效到 ${r.state.orderUntil?.slice(5).replace('-', '/')}`, pending: '緊急約束：等醫師補醫囑（1 小時內）', missing: '緊急約束超過 1 小時沒有醫囑', expired: `醫囑已在 ${r.state.orderUntil?.slice(5).replace('-', '/')} 到期` })[r.state.order]

// ---------- CAM ----------
const camOpen = ref(false)
const cam = reactive({ acute: false, inattention: false, disorganized: false, consciousness: false, note: '' })
function openCam() {
  Object.assign(cam, { acute: false, inattention: false, disorganized: false, consciousness: false, note: '' })
  saveCam.fieldErrors.value = {}
  camOpen.value = true
}
const livePositive = computed(() => camPositive(cam))
const saveCam = useAction(deliriumApi.saveDelirium, { success: (x) => `CAM ${x.positive ? '陽性（主治首頁會看到）' : '陰性'}` })
async function submitCam() {
  if (await saveCam.run(props.admissionId, { ...cam })) camOpen.value = false
}
const ack = useAction(deliriumApi.ackDelirium, { success: '已確認譫妄評估' })

// ---------- 約束 ----------
const startOpen = ref(false)
const st = reactive({ reason: '', sites: [] as string[], method: '' as string | number | undefined })
function openStart() {
  Object.assign(st, { reason: '', sites: [], method: '' })
  start.fieldErrors.value = {}
  startOpen.value = true
}
const start = useAction(deliriumApi.startRestraint, { success: (r) => (r.emergency ? '已開始緊急約束：請醫師 1 小時內補醫囑' : '已開約束醫囑（24 小時）') })
async function submitStart() {
  if (await start.run(props.admissionId, { reason: st.reason, sites: st.sites, method: String(st.method ?? '') })) startOpen.value = false
}
const toggleSite = (s: string, on: boolean) => (st.sites = on ? [...st.sites, s] : st.sites.filter((x) => x !== s))
const order = useAction(deliriumApi.orderRestraint, { success: '約束醫囑有效 24 小時' })

const chk = ref<RestraintView>()
const chkOpen = computed({ get: () => !!chk.value, set: (x) => !x && (chk.value = undefined) })
const cf = reactive({ circulationOk: true, skinOk: true, stillNeeded: true, note: '' })
function openCheck(r: RestraintView) {
  Object.assign(cf, { circulationOk: true, skinOk: true, stillNeeded: true, note: '' })
  check.fieldErrors.value = {}
  chk.value = r
}
const check = useAction(deliriumApi.checkRestraint, { success: '已查核' })
async function submitCheck() {
  if (chk.value && (await check.run(chk.value.id, { ...cf }))) chk.value = undefined
}

const endR = ref<RestraintView>()
const endOpen = computed({ get: () => !!endR.value, set: (x) => !x && (endR.value = undefined) })
const ef = reactive({ reason: '' as string | number | undefined, note: '' })
const end = useAction(deliriumApi.endRestraint, { success: '已解除約束' })
async function submitEnd() {
  if (endR.value && (await end.run(endR.value.id, String(ef.reason ?? ''), ef.note))) endR.value = undefined
}
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <UQueryState :loading="loading && !v" :ready="!!v">
      <template v-if="v">
        <section class="rounded-md border border-slate-200 p-3">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span class="font-semibold text-slate-700">譫妄評估（CAM）</span>
            <UBadge v-if="v.target" :tone="v.thisShift ? 'green' : 'cyan'">{{ v.target }}：每班評・{{ v.thisShift ? '本班已評' : '本班還沒評' }}</UBadge>
            <UBadge v-else-if="v.rassSkip" tone="gray">{{ v.rassSkip }}</UBadge>
            <UButton v-if="v.canAssess" class="ml-auto" size="sm" variant="secondary" @click="openCam">評估</UButton>
          </div>
          <p v-if="!v.assessments.length" class="text-xs text-slate-500">還沒有評估。</p>
          <ul v-else class="space-y-1 text-xs text-slate-600">
            <li v-for="x in v.assessments" :key="x.id" class="flex flex-wrap items-center gap-1.5">
              <span class="tabular">{{ x.at.slice(5).replace('-', '/') }}</span>{{ x.byName }}
              <UBadge :tone="x.positive ? 'red' : 'green'">{{ x.positive ? '陽性' : '陰性' }}</UBadge>
              <span v-if="x.note">{{ x.note }}</span>
              <template v-if="x.positive">
                <UBadge v-if="x.ackAt" tone="gray">{{ x.ackByName }} 已確認</UBadge>
                <UButton v-else-if="v.canOrder" size="sm" :loading="ack.pending.value" @click="ack.run(x.id)">確認</UButton>
                <UBadge v-else tone="yellow">主治未確認</UBadge>
              </template>
            </li>
          </ul>
        </section>

        <section class="rounded-md border border-slate-200 p-3">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span class="font-semibold text-slate-700">身體約束</span>
            <UButton v-if="!v.active.length && (v.canOrder || isNurse)" class="ml-auto" size="sm" :variant="v.canOrder ? 'primary' : 'danger'" @click="openStart">{{ v.canOrder ? '開約束醫囑' : '緊急約束' }}</UButton>
          </div>
          <p v-if="!v.active.length" class="text-xs text-slate-500">目前沒有約束。先試替代措施（家屬陪伴、移除不必要的管路、調整環境）。</p>
          <div v-for="r in v.active" :key="r.id" class="space-y-1 rounded bg-slate-50 px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <b class="text-slate-800">{{ r.sites.join('、') }}・{{ r.method }}</b>
              <span class="text-slate-600">{{ r.reason }}</span>
              <UBadge v-if="r.emergency" tone="red">緊急約束</UBadge>
              <span class="tabular text-xs text-slate-500">{{ r.startedAt.slice(5).replace('-', '/') }} 開始（{{ r.startedByName }}）・已 {{ r.state.hours }} 小時</span>
            </div>
            <div :class="['text-xs', r.state.order === 'ok' ? 'text-slate-600' : 'font-semibold text-red-700']">{{ orderText(r) }}</div>
            <div :class="['text-xs', r.state.check === 'overdue' ? 'font-semibold text-red-700' : r.state.check === 'due' ? 'text-amber-800' : 'text-slate-600']">下次查核：{{ r.state.checkDueAt.slice(5).replace('-', '/') }}{{ r.state.check === 'overdue' ? '（逾時）' : r.state.check === 'due' ? '（快到了）' : '' }}</div>
            <ul v-if="r.checkTexts.length" class="text-xs text-slate-500"><li v-for="c in r.checkTexts" :key="c">{{ c }}</li></ul>
            <div class="flex flex-wrap gap-1.5 pt-1">
              <UButton v-if="isNurse" size="sm" @click="openCheck(r)">查核</UButton>
              <UButton v-if="v.canOrder" size="sm" variant="secondary" :loading="order.pending.value" @click="order.run(r.id)">{{ r.orders.length ? '續開 24 小時' : '補醫囑' }}</UButton>
              <UButton size="sm" variant="ghost" @click="(ef.reason = ''), (ef.note = ''), (end.fieldErrors.value = {}), (endR = r)">解除</UButton>
            </div>
          </div>
          <details v-if="v.ended.length" class="mt-2 text-xs text-slate-600">
            <summary class="cursor-pointer">已解除 {{ v.ended.length }} 次</summary>
            <ul class="mt-1"><li v-for="r in v.ended" :key="r.id">{{ r.startedAt.slice(5).replace('-', '/') }} → {{ r.endedAt!.slice(5).replace('-', '/') }}（{{ r.state.hours }} 小時）{{ r.sites.join('、') }} {{ r.method }}・{{ r.endReason }}</li></ul>
          </details>
        </section>
      </template>
    </UQueryState>

    <UDialog v-model="camOpen" title="譫妄評估（CAM）" @submit="submitCam">
      <div class="space-y-2 text-sm">
        <label v-for="i in CAM_ITEMS" :key="i.key" class="flex items-start gap-2"><input v-model="cam[i.key]" type="checkbox" class="mt-0.5 h-4 w-4" /><span><b>{{ i.label }}</b><span class="block text-xs text-slate-500">{{ i.hint }}</span></span></label>
        <p :class="['rounded px-2 py-1', livePositive ? 'bg-red-50 text-red-800' : 'bg-slate-50 text-slate-700']">{{ livePositive ? '陽性：1 和 2 都有，加上 3 或 4' : '陰性' }}</p>
        <UInput v-model="cam.note" :label="livePositive ? '觀察到的表現' : '備註（選填）'" :required="livePositive" :error="saveCam.fieldErrors.value.note" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="camOpen = false">取消</UButton>
        <UButton type="submit" :loading="saveCam.pending.value">送出</UButton>
      </template>
    </UDialog>

    <UDialog v-model="startOpen" :title="v?.canOrder ? '開約束醫囑（24 小時）' : '緊急約束（1 小時內請醫師補醫囑）'" @submit="submitStart">
      <div class="space-y-3 text-sm">
        <div>
          <UInput v-model="st.reason" label="原因" required :error="start.fieldErrors.value.reason" />
          <div class="mt-1 flex flex-wrap gap-1"><button v-for="x in RESTRAINT_REASONS" :key="x" type="button" class="rounded border border-slate-300 px-1.5 text-xs hover:bg-slate-100" @click="st.reason = x">{{ x }}</button></div>
        </div>
        <fieldset>
          <legend class="mb-1 text-slate-700">部位</legend>
          <div class="flex flex-wrap gap-3"><UCheckbox v-for="x in RESTRAINT_SITES" :key="x" :model-value="st.sites.includes(x)" :label="x" @update:model-value="(on: boolean) => toggleSite(x, on)" /></div>
          <p v-if="start.fieldErrors.value.sites" class="text-xs text-red-600">{{ start.fieldErrors.value.sites }}</p>
        </fieldset>
        <USelect v-model="st.method" label="方式" required placeholder="選擇" :options="RESTRAINT_METHODS.map((x) => ({ label: x, value: x }))" :error="start.fieldErrors.value.method" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="startOpen = false">取消</UButton>
        <UButton type="submit" :loading="start.pending.value">開始約束</UButton>
      </template>
    </UDialog>

    <UDialog v-model="chkOpen" title="約束查核" size="sm" @submit="submitCheck">
      <div class="space-y-2 text-sm">
        <UCheckbox v-model="cf.circulationOk" label="末梢循環正常（顏色、溫度、腫脹）" />
        <UCheckbox v-model="cf.skinOk" label="皮膚完整（沒有發紅、破皮）" />
        <UCheckbox v-model="cf.stillNeeded" label="仍需要約束" />
        <UInput v-model="cf.note" label="處置／備註" :required="!cf.circulationOk || !cf.skinOk" :error="check.fieldErrors.value.note" />
        <p v-if="!cf.stillNeeded" class="text-xs text-amber-800">評估可以解除：查核後按「解除」寫原因。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="chkOpen = false">取消</UButton>
        <UButton type="submit" :loading="check.pending.value">送出</UButton>
      </template>
    </UDialog>

    <UDialog v-model="endOpen" title="解除約束" size="sm" @submit="submitEnd">
      <div class="space-y-3">
        <USelect v-model="ef.reason" label="原因" required placeholder="選擇原因" :options="RESTRAINT_END_REASONS.map((x) => ({ label: x, value: x }))" :error="end.fieldErrors.value.reason" />
        <UInput v-model="ef.note" :label="ef.reason === '其他' ? '說明' : '說明（選填）'" :required="ef.reason === '其他'" :error="end.fieldErrors.value.note" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="endOpen = false">取消</UButton>
        <UButton type="submit" :loading="end.pending.value">解除</UButton>
      </template>
    </UDialog>
  </div>
</template>
