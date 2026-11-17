<script setup lang="ts">
// 病人自控止痛 PCA（護理站病人分頁、住院醫囑分頁共用）：
//   醫師：開 PCA（每小時理論最大量即時算）、取消還沒架設的、處理警示
//   護理師：雙人核對架設 → 每 4 小時紀錄（鎮靜 ≥3 或呼吸 <10 紅字警示、要寫處置）→ 結束（剩餘量雙人見證銷毀，記進管制藥簿冊）
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UDialog, UInput, UQueryState, USelect, UTextarea } from '@/components/ui'
import WitnessDialog from '@/components/WitnessDialog.vue'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { checkPcaInput, PCA_END_REASONS, pcaAlert, pcaApi, pcaMaxPerHour, POSS, witnessApi, type PcaView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'

const props = defineProps<{ admissionId: string }>()
const ui = useUi()
const { data, loading } = useQuery(() => pcaApi.patientPca(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const statusView = { ordered: { text: '已開，待架設', tone: 'yellow' }, running: { text: '使用中', tone: 'blue' }, ended: { text: '已結束', tone: 'gray' }, cancelled: { text: '已取消', tone: 'gray' } } as const

// ---------- 醫師開 PCA ----------
const orOpen = ref(false)
const or = reactive({ drugId: '' as string | number | undefined, bolusMg: 1 as number | undefined, lockoutMin: 10 as number | undefined, hourLimitMg: 6 as number | undefined, basalMgH: 0 as number | undefined })
const num = (x: unknown) => Number(x)
const liveErr = computed(() => checkPcaInput({ bolusMg: num(or.bolusMg), lockoutMin: num(or.lockoutMin), hourLimitMg: num(or.hourLimitMg), basalMgH: num(or.basalMgH) }))
const liveMax = computed(() => (Object.keys(liveErr.value).length ? undefined : pcaMaxPerHour({ bolusMg: num(or.bolusMg), lockoutMin: num(or.lockoutMin), hourLimitMg: num(or.hourLimitMg), basalMgH: num(or.basalMgH) })))
function openOrder() {
  Object.assign(or, { drugId: v.value?.drugs[0]?.id ?? '', bolusMg: 1, lockoutMin: 10, hourLimitMg: 6, basalMgH: 0 })
  order.fieldErrors.value = {}
  orOpen.value = true
}
const order = useAction(pcaApi.orderPca, { success: '已開 PCA：請護理師雙人核對架設' })
async function submitOrder() {
  if (await order.run(props.admissionId, { drugId: String(or.drugId ?? ''), bolusMg: num(or.bolusMg), lockoutMin: num(or.lockoutMin), hourLimitMg: num(or.hourLimitMg), basalMgH: num(or.basalMgH) })) orOpen.value = false
}
const cancelFor = ref<PcaView>()
const cancel = useAction(pcaApi.cancelPca, { success: '已取消 PCA' })
async function onCancel(reason: string) {
  if (cancelFor.value && (await cancel.run(cancelFor.value.id, reason))) cancelFor.value = undefined
}
const ackFor = ref<PcaView>()
const ack = useAction(pcaApi.ackPcaAlert, { success: '已處理 PCA 警示' })
async function onAck(note: string) {
  if (ackFor.value && (await ack.run(ackFor.value.id, note))) ackFor.value = undefined
}

// ---------- 護理師：架設（雙人核對） ----------
const witnessFor = ref<{ p: PcaView; stage: 'setup' | 'end' }>()
const witnessOpen = computed({ get: () => !!witnessFor.value, set: (x) => !x && (witnessFor.value = undefined) })
const approve = (cred: { username: string; password: string }) => witnessApi.approveWitness({ purpose: 'pca', pcaId: witnessFor.value!.p.id, stage: witnessFor.value!.stage, ...cred })
const setup = useAction(pcaApi.setupPca, { success: 'PCA 已架設（住院藥局扣一袋）' })
const end = useAction(pcaApi.endPca, { success: (p) => `PCA 已結束，剩餘 ${p.end?.residualMl} ml 已銷毀` })
async function onWitness(token: string) {
  const w = witnessFor.value
  if (!w) return
  witnessFor.value = undefined
  if (w.stage === 'setup') await setup.run(w.p.id, token)
  else if (await end.run(w.p.id, { reason: String(ef.reason ?? ''), residualMl: num(ef.residualMl), witness: token })) endFor.value = undefined
}

// ---------- 護理師：紀錄 ----------
const recFor = ref<PcaView>()
const recOpen = computed({ get: () => !!recFor.value, set: (x) => !x && (recFor.value = undefined) })
const rf = reactive({ demands: undefined as number | undefined, delivered: undefined as number | undefined, usedMl: undefined as number | undefined, pain: undefined as number | undefined, sedation: undefined as number | undefined, resp: undefined as number | undefined, note: '' })
function openRec(p: PcaView) {
  Object.assign(rf, { demands: undefined, delivered: undefined, usedMl: undefined, pain: undefined, sedation: undefined, resp: undefined, note: '' })
  rec.fieldErrors.value = {}
  recFor.value = p
}
const liveAlert = computed(() => rf.sedation !== undefined && rf.resp !== undefined && (rf.resp as unknown) !== '' && pcaAlert({ sedation: num(rf.sedation), resp: num(rf.resp) }))
const rec = useAction(pcaApi.recordPca)
async function submitRec() {
  if (!recFor.value) return
  const r = await rec.run(recFor.value.id, { demands: num(rf.demands), delivered: num(rf.delivered), usedMl: num(rf.usedMl), pain: num(rf.pain), sedation: num(rf.sedation) as 1, resp: num(rf.resp), note: rf.note })
  if (r) {
    recFor.value = undefined
    if (r.warning) ui.toast.warning(r.warning)
    else ui.toast.success('已記錄 PCA')
  }
}

// ---------- 護理師：結束 ----------
const endFor = ref<PcaView>()
const endOpen = computed({ get: () => !!endFor.value, set: (x) => !x && (endFor.value = undefined) })
const ef = reactive({ reason: '' as string | number | undefined, residualMl: undefined as number | undefined })
function openEnd(p: PcaView) {
  Object.assign(ef, { reason: '', residualMl: p.volumeMl - p.usedMl })
  end.fieldErrors.value = {}
  endFor.value = p
}
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <UQueryState :loading="loading && !v" :ready="!!v">
      <template v-if="v">
        <div class="flex items-center">
          <span class="font-semibold text-slate-700">病人自控止痛（PCA）</span>
          <UButton v-if="v.canOrder && !v.pcas.some((p) => p.status === 'ordered' || p.status === 'running')" class="ml-auto" size="sm" @click="openOrder">開 PCA</UButton>
        </div>
        <p v-if="!v.pcas.length" class="rounded-md border border-slate-200 px-3 py-4 text-center text-slate-400">沒有 PCA</p>
        <section v-for="p in v.pcas" :key="p.id" class="space-y-2 rounded-md border border-slate-200 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <b class="text-slate-800">{{ p.drugName }}</b>
            <UBadge :tone="statusView[p.status].tone">{{ statusView[p.status].text }}</UBadge>
            <span class="text-xs text-slate-500">單次 {{ p.bolusMg }} mg・鎖定 {{ p.lockoutMin }} 分・每小時上限 {{ p.hourLimitMg }} mg・基礎 {{ p.basalMgH }} mg/h（每小時最多 {{ p.maxPerHour }} mg）・{{ p.orderedByName }} {{ p.orderedAt.slice(5) }}</span>
          </div>
          <p v-if="p.setup" class="text-xs text-slate-600">{{ p.setup.at.slice(5) }} 架設：{{ p.setupByName }}、核對 {{ p.setupWitnessName }}・累計用量 {{ p.usedMl }}／{{ p.volumeMl }} ml</p>
          <div v-if="p.openAlert" class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">
            <b>警示：{{ p.openAlert.text }}</b>（{{ p.openAlert.at.slice(5) }}）{{ p.openAlert.note }}
            <UButton v-if="v.canOrder" size="sm" variant="danger" class="ml-2" @click="ackFor = p">處理</UButton>
            <span v-else class="ml-1 text-xs">建議暫停 PCA、通知醫師</span>
          </div>
          <p v-if="p.alertAck && !p.openAlert" class="text-xs text-slate-600">{{ p.alertAck.at.slice(5) }} 醫師處理：{{ p.alertAck.note }}</p>
          <p v-if="p.recordDue" :class="['text-xs', p.recordDue.status === 'overdue' ? 'font-semibold text-red-700' : p.recordDue.status === 'due' ? 'text-amber-800' : 'text-slate-500']">下次紀錄：{{ p.recordDue.dueAt.slice(5) }}{{ p.recordDue.status === 'overdue' ? '（逾時）' : '' }}</p>
          <div class="flex flex-wrap gap-1.5">
            <UButton v-if="v.canNurse && p.status === 'ordered'" size="sm" @click="witnessFor = { p, stage: 'setup' }">雙人核對架設</UButton>
            <UButton v-if="v.canOrder && p.status === 'ordered'" size="sm" variant="ghost" @click="cancelFor = p">取消</UButton>
            <UButton v-if="v.canNurse && p.status === 'running'" size="sm" @click="openRec(p)">紀錄</UButton>
            <UButton v-if="v.canNurse && p.status === 'running'" size="sm" variant="ghost" @click="openEnd(p)">結束</UButton>
          </div>
          <table v-if="p.recordViews.length" class="w-full text-left text-xs">
            <thead class="whitespace-nowrap text-slate-500"><tr><th class="py-1">時間</th><th>按壓/給藥</th><th>累計 ml</th><th>疼痛</th><th>鎮靜</th><th>呼吸</th><th>紀錄</th></tr></thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="r in p.recordViews" :key="r.at" :class="r.alert && 'bg-red-50 text-red-800'">
                <td class="tabular py-1">{{ r.at.slice(5) }}</td><td class="tabular">{{ r.demands }}/{{ r.delivered }}</td><td class="tabular">{{ r.usedMl }}</td><td class="tabular">{{ r.pain }}</td><td class="tabular">{{ r.sedation }}</td><td class="tabular">{{ r.resp }}</td><td>{{ r.byName }}{{ r.note ? `：${r.note}` : '' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="p.end" class="text-xs text-slate-600">{{ p.end.at.slice(5) }} 結束（{{ p.end.reason }}）：剩餘 {{ p.end.residualMl }} ml 銷毀，{{ p.endByName }}、見證 {{ p.endWitnessName }}</p>
        </section>
      </template>
    </UQueryState>

    <UDialog v-model="orOpen" title="開 PCA" @submit="submitOrder">
      <div class="space-y-3 text-sm">
        <USelect v-model="or.drugId" label="藥袋" required :options="(v?.drugs ?? []).map((d) => ({ label: d.name, value: d.id }))" :error="order.fieldErrors.value.drugId" />
        <div class="grid grid-cols-2 gap-3">
          <UInput v-model="or.bolusMg" type="number" step="0.5" label="單次劑量 mg" :error="order.fieldErrors.value.bolusMg ?? liveErr.bolusMg" />
          <UInput v-model="or.lockoutMin" type="number" label="鎖定時間（分）" :error="order.fieldErrors.value.lockoutMin ?? liveErr.lockoutMin" />
          <UInput v-model="or.hourLimitMg" type="number" label="每小時上限 mg" :error="order.fieldErrors.value.hourLimitMg ?? liveErr.hourLimitMg" />
          <UInput v-model="or.basalMgH" type="number" step="0.5" label="基礎速率 mg/h（沒有填 0）" :error="order.fieldErrors.value.basalMgH ?? liveErr.basalMgH" />
        </div>
        <p v-if="liveMax !== undefined" class="rounded bg-slate-50 px-2 py-1 text-slate-700">每小時理論最多 <b>{{ liveMax }}</b> mg（鎖定時間限制按壓次數、再受上限限制）</p>
        <p class="text-xs text-slate-500">第二級管制藥：開立的醫師要有有效的管制藥執照。架設要兩位護理師核對。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="orOpen = false">取消</UButton>
        <UButton type="submit" :loading="order.pending.value">開立</UButton>
      </template>
    </UDialog>

    <UDialog v-model="recOpen" title="PCA 紀錄（每 4 小時）" @submit="submitRec">
      <div class="space-y-3 text-sm">
        <div class="grid grid-cols-3 gap-3">
          <UInput v-model="rf.demands" type="number" label="按壓次數" :error="rec.fieldErrors.value.demands" />
          <UInput v-model="rf.delivered" type="number" label="實際給藥次數" :error="rec.fieldErrors.value.delivered" />
          <UInput v-model="rf.usedMl" type="number" label="累計用量 ml" :hint="recFor ? `上次 ${recFor.usedMl} ml` : undefined" :error="rec.fieldErrors.value.usedMl" />
          <UInput v-model="rf.pain" type="number" label="疼痛 0–10" :error="rec.fieldErrors.value.pain" />
          <UInput v-model="rf.resp" type="number" label="呼吸 次/分" :error="rec.fieldErrors.value.resp" />
        </div>
        <fieldset>
          <legend class="mb-1 text-slate-700">鎮靜（POSS）</legend>
          <label v-for="o in POSS" :key="o.score" class="flex items-center gap-2 py-0.5"><input v-model="rf.sedation" type="radio" :value="o.score" class="h-4 w-4" /><b>{{ o.score }}</b> {{ o.text }}</label>
          <p v-if="rec.fieldErrors.value.sedation" class="text-xs text-red-600">{{ rec.fieldErrors.value.sedation }}</p>
        </fieldset>
        <p v-if="liveAlert" class="rounded bg-red-50 px-2 py-1 text-red-800">警示：鎮靜 ≥3 或呼吸 &lt;10——建議暫停 PCA、給氧、通知醫師，下面寫處置</p>
        <UTextarea v-model="rf.note" :label="liveAlert ? '處置' : '備註（選填）'" :rows="2" :required="liveAlert" :error="rec.fieldErrors.value.note" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="recOpen = false">取消</UButton>
        <UButton type="submit" :loading="rec.pending.value">送出</UButton>
      </template>
    </UDialog>

    <UDialog v-model="endOpen" title="結束 PCA" size="sm" @submit="witnessFor = endFor ? { p: endFor, stage: 'end' } : undefined">
      <div class="space-y-3">
        <USelect v-model="ef.reason" label="原因" required placeholder="選擇" :options="PCA_END_REASONS.map((x) => ({ label: x, value: x }))" :error="end.fieldErrors.value.reason" />
        <UInput v-model="ef.residualMl" type="number" label="剩餘量 ml（銷毀）" :hint="endFor ? `一袋 ${endFor.volumeMl} ml − 累計 ${endFor.usedMl} ml` : undefined" :error="end.fieldErrors.value.residualMl" />
        <p class="text-xs text-slate-500">下一步請另一位護理師輸入帳密，見證剩餘量銷毀（記進管制藥簿冊）。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="endOpen = false">取消</UButton>
        <UButton type="submit" :disabled="!ef.reason">下一步：見證銷毀</UButton>
      </template>
    </UDialog>

    <WitnessDialog v-model="witnessOpen" :title="witnessFor?.stage === 'setup' ? 'PCA 架設雙人核對' : 'PCA 剩餘量銷毀見證'" who="核對護理師" :subject="witnessFor ? `${witnessFor.p.drugName}・單次 ${witnessFor.p.bolusMg} mg、鎖定 ${witnessFor.p.lockoutMin} 分、上限 ${witnessFor.p.hourLimitMg} mg/h${witnessFor.stage === 'end' ? `・剩餘 ${ef.residualMl} ml` : ''}` : ''" :note="witnessFor?.stage === 'setup' ? '核對病人、藥袋、機器設定與醫囑相同。' : '當場看著剩餘量銷毀。'" :ok-text="witnessFor?.stage === 'setup' ? '核對無誤' : '見證銷毀'" :approve="approve" @approved="onWitness" />
    <ReasonDialog :model-value="!!cancelFor" title="取消 PCA" label="原因" :presets="['病人拒絕', '改其他止痛方式']" :pending="cancel.pending.value" :error="cancel.fieldErrors.value.reason" @update:model-value="(x: boolean) => !x && (cancelFor = undefined)" @confirm="onCancel" />
    <ReasonDialog :model-value="!!ackFor" title="處理 PCA 警示" label="處置" :presets="['停止基礎速率、繼續觀察', '暫停 PCA、改口服止痛', '給 Naloxone 0.04 mg IV，持續監測']" :pending="ack.pending.value" :error="ack.fieldErrors.value.note" @update:model-value="(x: boolean) => !x && (ackFor = undefined)" @confirm="onAck" />
  </div>
</template>
