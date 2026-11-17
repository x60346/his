<script setup lang="ts">
// 出院準備（護理站病人分頁、住院醫囑分頁、出院準備頁共用）：篩選（系統自動勾年齡、管路、30 天內再住院；符合兩項收案，即時算）、
// 需求評估、轉介（開單 → 列印送出 → 記對方回覆）、出院後電話追蹤。沒有「出院準備」權限的人（醫師）只看
import { computed, reactive, ref } from 'vue'
import { Printer } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState, USelect, UTextarea } from '@/components/ui'
import { dischargePlanApi, PLAN_CRITERIA, PLAN_ENROLL_FROM, PLAN_NEEDS, REFERRAL_KINDS, type PlanView } from '@/services'
import type { DischargeReferralKind } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { HOSPITAL } from '@/utils/hospital'

const props = defineProps<{ admissionId: string }>()
const { data, loading } = useQuery(() => dischargePlanApi.patientPlan(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const p = computed(() => v.value?.plan)
const dueText: Record<string, string> = { todo: '待篩選', due: '快到期', overdue: '逾時' }

// ---------- 篩選 ----------
const scOpen = ref(false)
const picked = ref<string[]>([])
function openScreen() {
  picked.value = [...new Set([...(p.value?.criteria ?? []), ...(v.value?.auto ?? [])])]
  scOpen.value = true
}
const liveEnrolled = computed(() => new Set([...picked.value, ...(v.value?.auto ?? [])]).size >= PLAN_ENROLL_FROM)
const screen = useAction(dischargePlanApi.screenPlan, { success: (x) => (x.enrolled ? '已收案：請做需求評估' : '已篩選：不收案') })
async function submitScreen() {
  if (await screen.run(props.admissionId, picked.value)) scOpen.value = false
}
const toggle = (arr: string[], k: string, on: boolean) => (on ? [...arr, k] : arr.filter((x) => x !== k))

// ---------- 需求評估 ----------
const ndOpen = ref(false)
const nd = reactive({ needs: [] as string[], assessment: '' })
function openNeeds() {
  Object.assign(nd, { needs: [...(p.value?.needs ?? [])], assessment: p.value?.assessment ?? '' })
  needs.fieldErrors.value = {}
  ndOpen.value = true
}
const needs = useAction(dischargePlanApi.saveNeeds, { success: '已存需求評估' })
async function submitNeeds() {
  if (await needs.run(props.admissionId, { ...nd })) ndOpen.value = false
}

// ---------- 轉介 ----------
const rfOpen = ref(false)
const rf = reactive({ kind: '' as DischargeReferralKind | '', agency: '', note: '' })
const agencies = computed(() => REFERRAL_KINDS.find((k) => k.kind === rf.kind)?.agencies ?? [])
function openRef() {
  Object.assign(rf, { kind: '', agency: '', note: '' })
  addRef.fieldErrors.value = {}
  rfOpen.value = true
}
const addRef = useAction(dischargePlanApi.addPlanReferral, { success: '已開轉介單：列印送出後記「已送出」' })
async function submitRef() {
  if (rf.kind && (await addRef.run(props.admissionId, { kind: rf.kind, agency: rf.agency, note: rf.note }))) rfOpen.value = false
}
const printing = ref<PlanView['referralViews'][number]>()
const send = useAction(dischargePlanApi.sendPlanReferral)
async function print() {
  if (!printing.value) return
  const x = await send.run(props.admissionId, printing.value.id)
  if (x) window.print()
}
const replying = ref<PlanView['referralViews'][number]>()
const rpOpen = computed({ get: () => !!replying.value, set: (x) => !x && (replying.value = undefined) })
const rp = reactive({ status: 'approved' as 'approved' | 'denied', note: '' })
const reply = useAction(dischargePlanApi.replyPlanReferral, { success: '已記回覆' })
async function submitReply() {
  if (replying.value && (await reply.run(props.admissionId, replying.value.id, { ...rp }))) replying.value = undefined
}

// ---------- 出院後追蹤 ----------
const fuOpen = ref(false)
const fu = reactive({ reached: true, result: '' })
const follow = useAction(dischargePlanApi.recordFollowUp, { success: '已記追蹤' })
async function submitFollow() {
  if (await follow.run(props.admissionId, { ...fu })) fuOpen.value = false
}
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <UQueryState :loading="loading && !v" :ready="!!v">
      <template v-if="v">
        <section class="rounded-md border border-slate-200 p-3">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span class="font-semibold text-slate-700">篩選</span>
            <UBadge v-if="!p && v.plannable" :tone="v.screen.status === 'overdue' ? 'red' : v.screen.status === 'due' ? 'yellow' : 'cyan'">{{ dueText[v.screen.status] }}（{{ v.screen.dueAt.slice(5) }} 前）</UBadge>
            <UBadge v-if="p" :tone="p.enrolled ? 'purple' : 'gray'">{{ p.enrolled ? '收案' : '不收案' }}</UBadge>
            <UButton v-if="v.canEdit && v.plannable" class="ml-auto" size="sm" variant="secondary" @click="openScreen">{{ p ? '重新篩選' : '篩選' }}</UButton>
          </div>
          <p v-if="!p" class="text-xs text-slate-500">入院 72 小時內篩選；系統已勾：{{ v.auto.length ? v.auto.map((k) => PLAN_CRITERIA.find((c) => c.key === k)?.label).join('、') : '無' }}。</p>
          <p v-else class="text-xs text-slate-600">{{ p.screenedAt.slice(5) }} {{ p.screenedByName }}：{{ p.criteriaText.join('、') || '都不符合' }}</p>
        </section>

        <template v-if="p?.enrolled">
          <section class="rounded-md border border-slate-200 p-3">
            <div class="mb-2 flex items-center gap-2">
              <span class="font-semibold text-slate-700">需求評估</span>
              <UButton v-if="v.canEdit && v.plannable" class="ml-auto" size="sm" variant="secondary" @click="openNeeds">{{ p.needs.length ? '修改' : '評估' }}</UButton>
            </div>
            <p v-if="!p.needs.length" class="text-xs text-amber-800">已收案，還沒評估需求。</p>
            <template v-else>
              <div class="flex flex-wrap gap-1"><UBadge v-for="n in p.needsText" :key="n" tone="blue">{{ n }}</UBadge></div>
              <p class="mt-1 text-slate-700">{{ p.assessment }}</p>
            </template>
          </section>

          <section class="rounded-md border border-slate-200 p-3">
            <div class="mb-2 flex items-center gap-2">
              <span class="font-semibold text-slate-700">轉介</span>
              <UBadge v-if="p.unreferred" tone="red">還沒有送出的轉介</UBadge>
              <UButton v-if="v.canEdit && p.needs.length && v.plannable" class="ml-auto" size="sm" variant="secondary" @click="openRef">開轉介單</UButton>
            </div>
            <p v-if="!p.referralViews.length" class="text-xs text-slate-500">還沒有轉介。</p>
            <ul v-else class="divide-y divide-slate-100">
              <li v-for="r in p.referralViews" :key="r.id" class="flex flex-wrap items-center gap-2 py-1.5">
                <b class="text-slate-800">{{ r.kindLabel }}</b><span class="text-slate-600">{{ r.agency }}</span>
                <UBadge v-if="r.reply" :tone="r.reply.status === 'approved' ? 'green' : 'red'">{{ r.reply.status === 'approved' ? '核定' : '未核定' }}{{ r.reply.note ? `：${r.reply.note}` : '' }}</UBadge>
                <UBadge v-else-if="r.sentAt" tone="yellow">{{ r.sentAt.slice(5, 10) }} 送出・待回覆</UBadge>
                <UBadge v-else tone="gray">未送出</UBadge>
                <span v-if="v.canEdit" class="ml-auto flex gap-1">
                  <UButton size="sm" variant="ghost" :icon="Printer" @click="printing = r">{{ r.sentAt ? '重印' : '列印送出' }}</UButton>
                  <UButton v-if="r.sentAt && !r.reply" size="sm" variant="secondary" @click="(rp.status = 'approved'), (rp.note = ''), (reply.fieldErrors.value = {}), (replying = r)">記回覆</UButton>
                </span>
              </li>
            </ul>
          </section>

          <section v-if="v.followUp" class="rounded-md border border-slate-200 p-3">
            <div class="mb-2 flex items-center gap-2">
              <span class="font-semibold text-slate-700">出院後追蹤</span>
              <UBadge :tone="v.followUp.status === 'done' ? 'green' : v.followUp.status === 'overdue' ? 'red' : 'yellow'">{{ v.followUp.status === 'done' ? '已追蹤' : `${v.followUp.dueAt.slice(5, 10)} 前電話追蹤` }}</UBadge>
              <UButton v-if="v.canEdit && !p.followUp" class="ml-auto" size="sm" @click="(fu.reached = true), (fu.result = ''), (follow.fieldErrors.value = {}), (fuOpen = true)">記追蹤</UButton>
            </div>
            <p v-if="p.followUp" class="text-slate-700">{{ p.followUp.at.slice(5) }} {{ p.followUpByName }}・{{ p.followUp.reached ? '聯絡到' : '聯絡不到' }}：{{ p.followUp.result }}</p>
          </section>
        </template>
      </template>
    </UQueryState>

    <UDialog v-model="scOpen" title="出院準備篩選" @submit="submitScreen">
      <div class="space-y-2 text-sm">
        <UCheckbox v-for="c in PLAN_CRITERIA" :key="c.key" :model-value="picked.includes(c.key) || (c.auto && v?.auto.includes(c.key))" :disabled="c.auto" :label="`${c.label}${c.auto ? '（系統判斷）' : ''}`" @update:model-value="(on: boolean) => (picked = toggle(picked, c.key, on))" />
        <p :class="['rounded px-2 py-1', liveEnrolled ? 'bg-violet-50 text-violet-800' : 'bg-slate-50 text-slate-600']">{{ liveEnrolled ? `符合 ${PLAN_ENROLL_FROM} 項以上：收案` : '不收案' }}</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="scOpen = false">取消</UButton>
        <UButton type="submit" :loading="screen.pending.value">送出</UButton>
      </template>
    </UDialog>

    <UDialog v-model="ndOpen" title="需求評估" @submit="submitNeeds">
      <div class="space-y-2 text-sm">
        <div class="grid grid-cols-1 gap-1 sm:grid-cols-2"><UCheckbox v-for="n in PLAN_NEEDS" :key="n.key" :model-value="nd.needs.includes(n.key)" :label="n.label" @update:model-value="(on: boolean) => (nd.needs = toggle(nd.needs, n.key, on))" /></div>
        <p v-if="needs.fieldErrors.value.needs" class="text-xs text-red-600">{{ needs.fieldErrors.value.needs }}</p>
        <UTextarea v-model="nd.assessment" label="評估" :rows="3" required placeholder="主要照顧者、居家環境、出院後安排" :error="needs.fieldErrors.value.assessment" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="ndOpen = false">取消</UButton>
        <UButton type="submit" :loading="needs.pending.value">儲存</UButton>
      </template>
    </UDialog>

    <UDialog v-model="rfOpen" title="開轉介單" size="sm" @submit="submitRef">
      <div class="space-y-3">
        <USelect v-model="rf.kind" label="轉介" required placeholder="選擇" :options="REFERRAL_KINDS.map((k) => ({ label: k.label, value: k.kind }))" :error="addRef.fieldErrors.value.kind" @update:model-value="rf.agency = agencies[0] ?? ''" />
        <UInput v-model="rf.agency" label="轉介單位" required :error="addRef.fieldErrors.value.agency" />
        <UInput v-model="rf.note" label="說明（選填）" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="rfOpen = false">取消</UButton>
        <UButton type="submit" :loading="addRef.pending.value">開單</UButton>
      </template>
    </UDialog>

    <UDialog v-model="rpOpen" :title="`轉介回覆：${replying?.kindLabel ?? ''}`" size="sm" @submit="submitReply">
      <div class="space-y-3 text-sm">
        <fieldset class="flex gap-4">
          <label class="flex items-center gap-1.5"><input v-model="rp.status" type="radio" value="approved" class="h-4 w-4" />核定</label>
          <label class="flex items-center gap-1.5"><input v-model="rp.status" type="radio" value="denied" class="h-4 w-4" />未核定</label>
        </fieldset>
        <UInput v-model="rp.note" :label="rp.status === 'denied' ? '原因' : '核定內容（選填）'" :required="rp.status === 'denied'" :error="reply.fieldErrors.value.note" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="rpOpen = false">取消</UButton>
        <UButton type="submit" :loading="reply.pending.value">儲存</UButton>
      </template>
    </UDialog>

    <UDialog v-model="fuOpen" title="出院後電話追蹤" size="sm" @submit="submitFollow">
      <div class="space-y-3 text-sm">
        <fieldset class="flex gap-4">
          <label class="flex items-center gap-1.5"><input v-model="fu.reached" type="radio" :value="true" class="h-4 w-4" />聯絡到</label>
          <label class="flex items-center gap-1.5"><input v-model="fu.reached" type="radio" :value="false" class="h-4 w-4" />聯絡不到</label>
        </fieldset>
        <UTextarea v-model="fu.result" :label="fu.reached ? '追蹤結果' : '聯絡情形'" :rows="3" required :error="follow.fieldErrors.value.result" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="fuOpen = false">取消</UButton>
        <UButton type="submit" :loading="follow.pending.value">儲存</UButton>
      </template>
    </UDialog>

    <UDialog :model-value="!!printing" title="出院準備轉介單" size="lg" @update:model-value="(x: boolean) => !x && (printing = undefined)">
      <div v-if="printing && p" class="print-area">
        <article class="border-2 border-slate-800 p-6 text-sm leading-relaxed text-slate-900">
          <header class="border-b-2 border-slate-800 pb-2 text-center">
            <div class="text-lg font-bold">{{ HOSPITAL.name }}</div>
            <div class="text-2xl font-bold tracking-[0.3em]">出院準備轉介單</div>
          </header>
          <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
            <dt class="text-slate-600">病人</dt><dd class="font-semibold">{{ v!.patient.name }}（{{ v!.patient.gender }}，{{ v!.patient.age }} 歲）病歷號 {{ v!.patient.chartNo }}・住院號 {{ v!.patient.admitNo }}</dd>
            <dt class="text-slate-600">診斷</dt><dd>{{ v!.patient.diagnosis }}</dd>
            <dt class="text-slate-600">聯絡電話</dt><dd class="tabular">{{ v!.patient.phone || '—' }}</dd>
            <dt class="text-slate-600">轉介</dt><dd class="font-semibold">{{ printing.kindLabel }}・{{ printing.agency }}</dd>
            <dt class="text-slate-600">篩選結果</dt><dd>{{ p.criteriaText.join('、') }}</dd>
            <dt class="text-slate-600">需求</dt><dd>{{ p.needsText.join('、') }}</dd>
            <dt class="text-slate-600">評估</dt><dd>{{ p.assessment }}</dd>
            <dt v-if="printing.note" class="text-slate-600">說明</dt><dd v-if="printing.note">{{ printing.note }}</dd>
            <dt class="text-slate-600">開單</dt><dd class="tabular">{{ printing.createdAt.slice(0, 10) }}</dd>
          </dl>
          <p class="mt-6 text-right">出院準備個管師＿＿＿＿＿＿＿　聯絡電話＿＿＿＿＿＿＿</p>
        </article>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="printing = undefined">關閉</UButton>
        <UButton :icon="Printer" :loading="send.pending.value" @click="print">列印{{ printing?.sentAt ? '' : '（記為已送出）' }}</UButton>
      </template>
    </UDialog>
  </div>
</template>
