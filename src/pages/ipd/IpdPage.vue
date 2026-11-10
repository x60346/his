<script setup lang="ts">
// 住院醫囑：醫師的住院病人 → 長期／臨時醫囑、病程紀錄。
// 長期給藥醫囑會連動護理站的給藥排程（由服務層處理），停止醫囑時未執行的排程一併刪除。
import { useRevealOnNarrow } from '@/composables/useRevealOnNarrow'
import { computed, reactive, ref, watch } from 'vue'
import { Plus, Square } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UEmpty, UQueryState, USelect, UTabs, UTextarea } from '@/components/ui'
import PatientBanner from '@/components/PatientBanner.vue'
import OrderDialog from './components/OrderDialog.vue'
import { admissionApi, ipdApi, masterApi, nursingApi } from '@/services'
import type { OrderView } from '@/services/ipd'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import type { IpdOrderCategory } from '@/types'

const auth = useAuth()
const ui = useUi()

// ---------- 病人清單 ----------
const isAdmin = auth.user?.role === 'admin'
const doctorFilter = ref<string | number | undefined>(isAdmin ? '' : auth.user?.doctorId)
const { data: doctors } = useQuery(async () => (isAdmin ? masterApi.listDoctors() : []))
const { data: admitted, loading } = useQuery(() => admissionApi.listAdmissions({ status: ['admitted'] }))
const myPatients = computed(() =>
  (admitted.value ?? []).filter((a) => !doctorFilter.value || a.doctorId === doctorFilter.value).sort((a, b) => (a.bed?.bedNo ?? '').localeCompare(b.bed?.bedNo ?? '')),
)

const admissionId = ref<string>()
useRevealOnNarrow(admissionId) // 窄螢幕點選後把明細捲進畫面
const adm = computed(() => admitted.value?.find((a) => a.id === admissionId.value))
// 病人出院後從清單消失，取消選取
watch(adm, (a) => {
  if (!a && admissionId.value && admitted.value) admissionId.value = undefined
})

// ---------- 醫囑 ----------
const { data: orders, loading: ordersLoading } = useQuery(async () => (admissionId.value ? ipdApi.listOrders(admissionId.value) : []), [admissionId])
const longOrders = computed(() => (orders.value ?? []).filter((o) => o.type === 'long'))
const statOrders = computed(() => (orders.value ?? []).filter((o) => o.type === 'stat'))

const categoryLabel: Record<IpdOrderCategory, { label: string; tone: 'blue' | 'cyan' | 'yellow' | 'green' }> = {
  medication: { label: '給藥', tone: 'blue' },
  procedure: { label: '檢驗處置', tone: 'cyan' },
  diet: { label: '飲食', tone: 'yellow' },
  nursing: { label: '護理', tone: 'green' },
}
const statusLabel = { active: '執行中', stopped: '已停止', done: '已完成' } as const

const orderOpen = ref(false)
const stop = useAction(ipdApi.stopOrder, { success: (o) => `已停止：${o.content}` })
async function onStop(o: OrderView) {
  const extra = o.category === 'medication' && o.type === 'long' ? '\n尚未執行的給藥排程會一併刪除。' : ''
  if (await ui.confirm({ title: '停止醫囑', message: `確定停止「${o.content}」？${extra}`, okText: '停止', danger: true })) stop.run(o.id)
}

// ---------- 最新生命徵象（護理站記錄，醫師參考） ----------
const { data: vitals } = useQuery(async () => (admissionId.value ? nursingApi.listVitals(admissionId.value) : []), [admissionId])
const latestVital = computed(() => vitals.value?.[vitals.value.length - 1])

// ---------- 病程紀錄 ----------
const tab = ref('orders')
const { data: notes } = useQuery(async () => (admissionId.value ? ipdApi.listProgressNotes(admissionId.value) : []), [admissionId])
const note = reactive({ subjective: '', objective: '', assessment: '', plan: '' })
const addNote = useAction(ipdApi.addProgressNote, { success: '已新增病程紀錄' })
async function submitNote() {
  if (!admissionId.value) return
  if (await addNote.run({ admissionId: admissionId.value, ...note })) Object.assign(note, { subjective: '', objective: '', assessment: '', plan: '' })
}
</script>

<template>
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-[18rem_1fr]">
    <!-- 病人清單 -->
    <UCard :padded="false" class="self-start">
      <template #title>
        <div class="text-sm font-semibold text-slate-800">{{ isAdmin ? '住院病人' : '我的住院病人' }}</div>
        <div class="text-xs text-slate-500">共 {{ myPatients.length }} 位</div>
      </template>
      <div v-if="isAdmin" class="border-b border-slate-100 p-3">
        <USelect v-model="doctorFilter" :options="[{ label: '全部醫師', value: '' }, ...(doctors ?? []).map((d) => ({ label: d.name, value: d.id }))]" />
      </div>
      <UQueryState :loading="loading" :ready="myPatients.length > 0" empty-title="目前沒有住院病人">
        <ul class="max-h-[calc(100vh-12rem)] divide-y divide-slate-100 overflow-y-auto">
          <li v-for="a in myPatients" :key="a.id">
            <button :class="['w-full px-3 py-2.5 text-left hover:bg-slate-50', a.id === admissionId && '!bg-brand-50']" @click="admissionId = a.id">
              <div class="flex items-center gap-2">
                <span class="tabular rounded bg-slate-100 px-1.5 text-xs font-medium text-slate-700">{{ a.bed?.bedNo }}</span>
                <span class="font-medium text-slate-800">{{ a.patientName }}</span>
                <span class="ml-auto text-xs text-slate-500">第 {{ a.days }} 天</span>
              </div>
              <div class="mt-0.5 truncate text-xs text-slate-500">{{ a.diagnosis }}<template v-if="isAdmin">・{{ a.doctorName }}</template></div>
            </button>
          </li>
        </ul>
      </UQueryState>
    </UCard>

    <UCard v-if="!adm" data-detail><UEmpty title="請從清單選擇病人" description="檢視與開立住院醫囑、病程紀錄" /></UCard>
    <div v-else data-detail class="min-w-0 space-y-3">
      <PatientBanner :patient="adm">
        <UBadge tone="blue">{{ adm.bed?.bedNo }}</UBadge>
        <span class="tabular text-sm text-slate-600">住院號 {{ adm.admitNo }}・第 {{ adm.days }} 天</span>
      </PatientBanner>
      <div class="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm">
        <span class="text-slate-500">入院診斷</span><span class="text-slate-800">{{ adm.diagnosis }}</span>
        <template v-if="latestVital">
          <span class="text-slate-500">最新生命徵象（{{ latestVital.at.slice(5) }}）</span>
          <span class="tabular text-slate-800">
            T <b :class="(latestVital.temp ?? 0) >= 38 && 'text-red-600'">{{ latestVital.temp }}</b>・P {{ latestVital.pulse }}・BP {{ latestVital.sbp }}/{{ latestVital.dbp }}・SpO2
            <b :class="(latestVital.spo2 ?? 100) < 94 && 'text-red-600'">{{ latestVital.spo2 }}</b>
          </span>
        </template>
      </div>

      <UCard :padded="false">
        <div class="flex items-center px-4 pt-1">
          <UTabs v-model="tab" :tabs="[{ key: 'orders', label: '醫囑', count: orders?.filter((o) => o.status === 'active').length }, { key: 'notes', label: '病程紀錄', count: notes?.length }]" />
          <UButton v-if="tab === 'orders'" class="ml-auto" size="sm" :icon="Plus" @click="orderOpen = true">新增醫囑</UButton>
        </div>

        <!-- 醫囑 -->
        <div v-if="tab === 'orders'" class="space-y-5 p-4">
          <UQueryState :loading="ordersLoading" :ready="!!orders">
            <section v-for="sec in [{ title: '長期醫囑', list: longOrders }, { title: '臨時醫囑', list: statOrders }]" :key="sec.title" class="mb-5 last:mb-0">
              <h3 class="mb-2 text-sm font-semibold text-slate-700">{{ sec.title }}</h3>
              <p v-if="!sec.list.length" class="text-sm text-slate-400">沒有{{ sec.title }}</p>
              <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200">
                <li v-for="o in sec.list" :key="o.id" :class="['flex items-center gap-3 px-3 py-2 text-sm', o.status !== 'active' && 'bg-slate-50 text-slate-400']">
                  <UBadge :tone="o.status === 'active' ? categoryLabel[o.category].tone : 'gray'">{{ categoryLabel[o.category].label }}</UBadge>
                  <div class="min-w-0 flex-1">
                    <div :class="['font-medium', o.status === 'active' && 'text-slate-800', o.status === 'stopped' && 'line-through']">
                      {{ o.content }}
                      <UBadge v-if="o.highAlert && o.status === 'active'" tone="purple" class="ml-1">高警訊</UBadge>
                    </div>
                    <div v-if="o.category === 'medication'" class="tabular text-xs">每次 {{ o.dose }} {{ o.unit }}・{{ o.freq }}（{{ o.freqLabel }}）・{{ o.route }}</div>
                  </div>
                  <div class="tabular text-right text-xs">
                    <div>{{ o.startAt.slice(5) }} 開立</div>
                    <div v-if="o.stopAt">{{ o.stopAt.slice(5) }} 停止</div>
                  </div>
                  <span class="w-12 text-xs">{{ statusLabel[o.status] }}</span>
                  <UButton v-if="o.status === 'active'" size="sm" variant="ghost" :icon="Square" @click="onStop(o)">停止</UButton>
                  <span v-else class="w-[4.25rem]" />
                </li>
              </ul>
            </section>
          </UQueryState>
        </div>

        <!-- 病程紀錄 -->
        <div v-else class="space-y-4 p-4">
          <div class="rounded-md border border-slate-200 bg-slate-50 p-3">
            <div class="mb-2 text-sm font-semibold text-slate-700">新增今日病程（SOAP）</div>
            <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
              <UTextarea v-model="note.subjective" label="S 主觀" :rows="2" />
              <UTextarea v-model="note.objective" label="O 客觀" :rows="2" />
              <UTextarea v-model="note.assessment" label="A 評估" :rows="2" />
              <UTextarea v-model="note.plan" label="P 計畫" :rows="2" />
            </div>
            <div class="mt-2 text-right"><UButton size="sm" :loading="addNote.pending.value" @click="submitNote">儲存病程紀錄</UButton></div>
          </div>
          <article v-for="n in notes" :key="n.id" class="rounded-md border border-slate-200 p-3 text-sm">
            <header class="mb-1.5 flex justify-between text-xs text-slate-500"><span class="tabular font-medium text-slate-700">{{ n.at }}</span><span>{{ n.doctorName }}</span></header>
            <dl class="grid gap-1">
              <div v-for="[k, v] in [['S', n.subjective], ['O', n.objective], ['A', n.assessment], ['P', n.plan]]" :key="k" class="flex gap-2">
                <dt class="w-4 font-bold text-brand-700">{{ k }}</dt><dd class="text-slate-700">{{ v || '—' }}</dd>
              </div>
            </dl>
          </article>
        </div>
      </UCard>
    </div>

    <OrderDialog v-model="orderOpen" :admission="adm" />
  </div>
</template>
