<script setup lang="ts">
// 加護病房（住院醫囑的病人分頁）：
//   - 不在加護病房：轉入申請（類別、原因）與結果
//   - 在加護病房：SOFA 每天（缺的項目「—」）、APACHE II（轉入 24 小時內；慢性病、手術醫師填）、轉出摘要（寫了才能轉出）
//   - 住加護病房的紀錄（48 小時內再轉回標出來）
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UCheckbox, UDialog, UQueryState, USelect, UTextarea } from '@/components/ui'
import { APACHE_CATEGORIES, apacheCategoryLabel, APACHE_LABEL, ICU_CATEGORIES, ICU_SUMMARY_FIELDS, icuMoveApi, SOFA_LABEL, type ApacheKey, type SofaKey } from '@/services'
import type { IcuCategory } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import NewsPanel from './NewsPanel.vue'
import VasoPanel from './VasoPanel.vue'

const props = defineProps<{ admissionId: string }>()
const { data, loading, reload } = useQuery(() => icuMoveApi.patientIcu(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const statusText = { pending: '待加護病房主治同意', accepted: '已同意，候床中', declined: '不同意', cancelled: '已取消', placed: '已轉入' } as const
const sofaKeys = Object.keys(SOFA_LABEL) as SofaKey[]
const apacheKeys = Object.keys(APACHE_LABEL) as ApacheKey[]
const surgeryText = { none: '非手術', emergency: '急診手術後', elective: '常規手術後' } as const

// 申請
const reqOpen = ref(false)
const req = reactive({ category: '' as IcuCategory | '', reason: '' })
const reqAct = useAction(icuMoveApi.requestIcu, { success: '已送出轉入申請' })
async function submitReq() {
  if (await reqAct.run(props.admissionId, { category: req.category as IcuCategory, reason: req.reason })) {
    reqOpen.value = false
    reload()
  }
}
const cancelAct = useAction(icuMoveApi.cancelIcuRequest, { success: '已取消申請' })
async function cancelReq() {
  if (v.value?.request && (await cancelAct.run(v.value.request.id))) reload()
}
// APACHE 手動欄位
const ap = reactive({ chronic: false, surgery: 'none' as 'none' | 'emergency' | 'elective', category: '' as string })
const apOpen = ref(false)
function openAp() {
  Object.assign(ap, { chronic: v.value?.apache?.input.chronic ?? false, surgery: v.value?.apache?.input.surgery ?? 'none', category: v.value?.apache?.input.category ?? '' })
  apOpen.value = true
}
const apAct = useAction(icuMoveApi.setApacheInput, { success: '已更新 APACHE II' })
async function submitAp() {
  if (await apAct.run(props.admissionId, { chronic: ap.chronic, surgery: ap.surgery, ...(ap.category ? { category: ap.category } : {}) })) {
    apOpen.value = false
    reload()
  }
}
// 轉出摘要
const sumOpen = ref(false)
const sum = reactive({ diagnosis: '', course: '', lines: '', todo: '' })
function openSum() {
  const it = (label: string) => v.value?.summary?.items.find((x) => x.label === label)?.text ?? ''
  Object.assign(sum, { diagnosis: it('診斷'), course: it('加護病房經過與處置'), lines: it('目前管路'), todo: it('轉出後待追蹤') })
  sumAct.fieldErrors.value = {}
  sumOpen.value = true
}
const sumAct = useAction(icuMoveApi.writeIcuSummary, { success: '已寫轉出摘要：住院中心可以轉床' })
async function submitSum() {
  if (await sumAct.run(props.admissionId, { ...sum })) {
    sumOpen.value = false
    reload()
  }
}
const pts = (n: number | null) => (n === null ? '—' : n)
</script>

<template>
  <div class="space-y-4 p-4 text-sm">
    <UQueryState :loading="loading && !v" :ready="!!v">
      <template v-if="v">
        <NewsPanel v-if="!v.inIcu" :admission-id="admissionId" />
        <!-- 轉入申請 -->
        <section v-if="!v.inIcu" class="rounded-md border border-slate-200 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold text-slate-700">轉入加護病房</span>
            <UBadge v-if="v.request" :tone="v.request.status === 'pending' || v.request.status === 'accepted' ? 'yellow' : v.request.status === 'declined' ? 'red' : 'gray'">{{ statusText[v.request.status] }}</UBadge>
            <UButton v-if="v.canRequest" class="ml-auto" size="sm" variant="secondary" @click="Object.assign(req, { category: '', reason: '' }); reqAct.fieldErrors.value = {}; reqOpen = true">申請轉入</UButton>
            <UButton v-else-if="v.request && (v.request.status === 'pending' || v.request.status === 'accepted')" class="ml-auto" size="sm" variant="ghost" :loading="cancelAct.pending.value" @click="cancelReq">取消申請</UButton>
          </div>
          <div v-if="v.request" class="mt-1 text-slate-700">
            {{ v.request.categoryLabel }}：{{ v.request.reason }}
            <div class="text-xs text-slate-500">{{ v.request.requestedAt.slice(5).replace('-', '/') }} {{ v.request.requestedByName }}申請<template v-if="v.request.decidedByName">・{{ v.request.decidedAt?.slice(5).replace('-', '/') }} {{ v.request.decidedByName }}{{ v.request.decideNote ? `：${v.request.decideNote}` : '' }}</template></div>
          </div>
          <p v-else class="mt-1 text-slate-500">需要加護病房照護時，由主治申請；加護病房主治同意後排床（沒床先候床）。</p>
        </section>

        <template v-else>
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold text-slate-700">加護病房</span>
            <span class="text-xs text-slate-500">{{ v.since?.slice(5, 16).replace('-', '/') }} 轉入</span>
          </div>
          <VasoPanel :admission-id="admissionId" @changed="reload" />
          <!-- SOFA -->
          <section class="rounded-md border border-slate-200 p-3">
            <div class="mb-1 font-semibold text-slate-700">SOFA（每天，各項取當天最差）</div>
            <div class="overflow-x-auto">
              <table class="tabular w-full min-w-[30rem] text-xs">
                <thead class="text-slate-500"><tr><th class="py-1 text-left font-medium">日期</th><th v-for="k in sofaKeys" :key="k" class="px-1 py-1 text-center font-medium">{{ SOFA_LABEL[k].split('（')[0] }}</th><th class="px-1 py-1 text-center font-medium">總分</th></tr></thead>
                <tbody>
                  <tr v-for="s in v.sofa" :key="s.date" class="border-t border-slate-100">
                    <td class="py-1">{{ s.date.slice(5).replace('-', '/') }}{{ s.partial ? '（到現在）' : '' }}</td>
                    <td v-for="k in sofaKeys" :key="k" :class="['px-1 py-1 text-center', (s.parts[k] ?? 0) >= 3 && 'font-semibold text-red-600', s.parts[k] === null && 'text-slate-300']">{{ pts(s.parts[k]) }}</td>
                    <td class="px-1 py-1 text-center font-semibold">{{ s.total }}<span v-if="s.missing.length" class="font-normal text-slate-400" :title="`缺：${s.missing.map((m) => SOFA_LABEL[m as SofaKey]).join('、')}`">＋</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="mt-1 text-xs text-slate-500">「—」＝當天沒有資料（不硬算，總分後面的「＋」表示可能更高）。心血管用升壓劑時依當天最高劑量（Norepinephrine ≤0.1 → 3、>0.1 → 4；Dopamine >5 → 3、>15 → 4；Vasopressin → 3），沒用才看 MAP；呼吸要有動脈血液氣體分析，沒接呼吸器最多 2 分；插管的 GCS（言語 T）不算神經項。</p>
          </section>
          <!-- APACHE II -->
          <section v-if="v.apache" class="rounded-md border border-slate-200 p-3">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-semibold text-slate-700">APACHE II（轉入 24 小時內）</span>
              <span class="tabular text-lg font-semibold text-slate-800">{{ v.apache.total }}</span>
              <UBadge v-if="v.apache.partial" tone="gray">還不滿 24 小時（暫定）</UBadge>
              <UBadge tone="purple" class="tabular" :title="'診斷類別：' + (apacheCategoryLabel(v.apache.input.category) || '未選（以 0 計）')">預估死亡率 {{ v.apache.mortality }}%</UBadge>
              <UButton v-if="v.canSummary" class="ml-auto" size="sm" variant="secondary" @click="openAp">慢性病／手術／診斷類別</UButton>
            </div>
            <div class="tabular mt-1 text-xs text-slate-600">生理 {{ v.apache.aps }}＋年齡 {{ v.apache.agePts }}＋慢性病 {{ v.apache.chronicPts }}（{{ v.apache.input.chronic ? '有嚴重慢性病' : '無嚴重慢性病' }}・{{ surgeryText[v.apache.input.surgery] }}{{ v.apache.input.set ? '' : '，醫師還沒填' }}）</div>
            <div class="tabular mt-1 flex flex-wrap gap-1 text-xs">
              <span v-for="k in apacheKeys" :key="k" :class="['rounded px-1.5 py-0.5', v.apache.parts[k] === null ? 'bg-slate-50 text-slate-400' : (v.apache.parts[k] ?? 0) >= 3 ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-700']">{{ APACHE_LABEL[k] }} {{ pts(v.apache.parts[k]) }}</span>
            </div>
            <p v-if="v.apache.missing.length" class="mt-1 text-xs text-amber-800">缺 {{ v.apache.missing.length }} 項（{{ v.apache.missing.map((m) => APACHE_LABEL[m as ApacheKey]).join('、') }}）以 0 分計：分數可能低估</p>
          </section>
          <!-- 轉出摘要 -->
          <section class="rounded-md border border-slate-200 p-3">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-semibold text-slate-700">轉出摘要</span>
              <UBadge v-if="v.summary" tone="green">{{ v.summary.at.slice(5, 16).replace('-', '/') }} {{ v.summary.byName }}</UBadge>
              <UBadge v-else tone="gray">還沒寫（寫了住院中心才能轉床出去）</UBadge>
              <UButton v-if="v.canSummary" class="ml-auto" size="sm" variant="secondary" @click="openSum">{{ v.summary ? '重寫' : '寫轉出摘要' }}</UButton>
            </div>
            <dl v-if="v.summary" class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-slate-700">
              <template v-for="it in v.summary.items" :key="it.label"><dt class="text-xs text-slate-500">{{ it.label }}</dt><dd class="whitespace-pre-line">{{ it.text }}</dd></template>
            </dl>
          </section>
        </template>

        <section v-if="v.stays.length" class="text-xs text-slate-600">
          <span class="font-semibold text-slate-700">住加護病房的紀錄</span>
          <span v-for="s in v.stays" :key="s.from" class="tabular ml-3">{{ s.from.slice(5, 16).replace('-', '/') }}–{{ s.to?.slice(5, 16).replace('-', '/') ?? '現在' }}（{{ s.days }} 天）<UBadge v-if="s.bounce" tone="red">48 小時內再轉回</UBadge></span>
        </section>
      </template>
    </UQueryState>

    <UDialog v-model="reqOpen" title="申請轉入加護病房" size="sm" @submit="submitReq">
      <div class="space-y-2">
        <div><USelect v-model="req.category" label="類別" :options="[{ label: '請選', value: '' }, ...ICU_CATEGORIES.map((c) => ({ label: c.label, value: c.key }))]" :error="reqAct.fieldErrors.value.category" /></div>
        <UTextarea v-model="req.reason" label="原因" :rows="3" required :error="reqAct.fieldErrors.value.reason" placeholder="例：血壓 82/45，輸液 2 L 後仍低，乳酸 4.2" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="reqOpen = false">取消</UButton>
        <UButton type="submit" :loading="reqAct.pending.value">送出</UButton>
      </template>
    </UDialog>
    <UDialog v-model="apOpen" title="APACHE II：慢性病、手術、診斷類別" size="sm" @submit="submitAp">
      <div class="space-y-2">
        <UCheckbox v-model="ap.chronic" label="嚴重慢性病（肝硬化、心衰竭 NYHA IV、慢性呼吸衰竭、洗腎、免疫抑制）" />
        <div><USelect v-model="ap.surgery" label="這次" :options="Object.entries(surgeryText).map(([value, label]) => ({ label, value }))" /></div>
        <div><USelect v-model="ap.category" label="診斷類別（預估死亡率用）" :options="[{ label: '未選（以 0 計）', value: '' }, ...APACHE_CATEGORIES.map((c) => ({ label: c.label, value: c.key }))]" :error="apAct.fieldErrors.value.category" /></div>
        <p class="text-xs text-slate-500">有嚴重慢性病：非手術或急診手術後 +5、常規手術後 +2。預估死亡率＝APACHE II 公式（診斷類別係數、急診手術後再加），只供參考。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="apOpen = false">取消</UButton>
        <UButton type="submit" :loading="apAct.pending.value">儲存</UButton>
      </template>
    </UDialog>
    <UDialog v-model="sumOpen" title="加護病房轉出摘要" @submit="submitSum">
      <div class="space-y-2">
        <UTextarea v-for="fd in ICU_SUMMARY_FIELDS" :key="fd.key" v-model="sum[fd.key]" :label="fd.label" :rows="fd.key === 'course' ? 4 : 2" :required="fd.key !== 'lines'" :error="sumAct.fieldErrors.value[fd.key]" />
        <p class="text-xs text-slate-500">轉出後 48 小時內，接手病房的交班會帶出這份摘要。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="sumOpen = false">取消</UButton>
        <UButton type="submit" :loading="sumAct.pending.value">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
