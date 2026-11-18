<script setup lang="ts">
// 安寧（住院醫囑的病人分頁）：
//   主治：提出照會、撤回、記家屬會議
//   安寧醫師：收案（末期疾病別、兩位專科醫師、照護目標）或婉拒、訪視（五項症狀 0–10、評估與處置、靈性與社會需求；帶入共照費）
// 症狀以表格呈現（舊到新），≥7 標紅
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UDialog, UInput, USelect, UTextarea } from '@/components/ui'
import { PALLIATIVE_DISEASES, palliativeApi, SYMPTOM_SEVERE, SYMPTOMS } from '@/services'
import type { SymptomKey } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import { today } from '@/utils/date'

const props = defineProps<{ admissionId: string }>()
const { data, reload } = useQuery(() => palliativeApi.patientPalliative(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const c = computed(() => v.value?.current)
const hm = (s?: string) => s?.slice(5, 16).replace('-', '/') ?? ''
const statusText = { requested: '待收案', enrolled: '收案中', declined: '婉拒', cancelled: '已撤回' } as const
const docOpts = computed(() => [{ label: '請選', value: '' }, ...(v.value?.doctors ?? []).map((d) => ({ label: `${d.name}（${d.deptName}）`, value: d.id }))])

// 照會
const reqOpen = ref(false)
const reason = ref('')
const reqAct = useAction(palliativeApi.requestPalliative, { success: '已送出安寧照會' })
async function request() {
  if (await reqAct.run(props.admissionId, { reason: reason.value })) {
    reqOpen.value = false
    reload()
  }
}
const cancelAct = useAction(palliativeApi.cancelPalliative, { success: '已撤回' })
async function cancel() {
  if (c.value && (await cancelAct.run(c.value.id))) reload()
}
// 收案／婉拒
const decOpen = ref(false)
const dec = reactive({ accept: true, disease: '', d1: '' as string | number, d2: '' as string | number, note: '', goals: '', declineReason: '' })
function openDecide(accept: boolean) {
  Object.assign(dec, { accept, disease: '', d1: '', d2: '', note: '', goals: '', declineReason: '' })
  decAct.fieldErrors.value = {}
  decOpen.value = true
}
const decAct = useAction(palliativeApi.decidePalliative, { success: (x) => (x.status === 'enrolled' ? '已收案' : '已婉拒') })
async function decide() {
  if (c.value && (await decAct.run(c.value.id, { accept: dec.accept, disease: dec.disease, doctorIds: [String(dec.d1), String(dec.d2)], note: dec.note, goals: dec.goals, declineReason: dec.declineReason }))) {
    decOpen.value = false
    reload()
  }
}
// 訪視
const visOpen = ref(false)
const vis = reactive({ symptoms: {} as Record<SymptomKey, number | undefined>, note: '', spiritual: '', social: '', goals: '' })
function openVisit() {
  Object.assign(vis, { symptoms: Object.fromEntries(SYMPTOMS.map((s) => [s.key, c.value?.latest?.[s.key]])), note: '', spiritual: '', social: '', goals: '' })
  visAct.fieldErrors.value = {}
  visOpen.value = true
}
const visAct = useAction(palliativeApi.addPalliativeVisit, { success: '已記錄訪視（帶入安寧共照費）' })
async function visit() {
  const sym = Object.fromEntries(SYMPTOMS.map((s) => [s.key, vis.symptoms[s.key] === undefined || (vis.symptoms[s.key] as unknown) === '' ? NaN : Number(vis.symptoms[s.key])])) as Record<SymptomKey, number>
  if (c.value && (await visAct.run(c.value.id, { symptoms: sym, note: vis.note, spiritual: vis.spiritual, social: vis.social, goals: vis.goals }))) {
    visOpen.value = false
    reload()
  }
}
// 家屬會議
const mtOpen = ref(false)
const mt = reactive({ date: today(), participants: '', conclusion: '' })
const mtAct = useAction(palliativeApi.addFamilyMeeting, { success: '已記錄家屬會議' })
async function meeting() {
  if (c.value && (await mtAct.run(c.value.id, { ...mt }))) {
    mtOpen.value = false
    reload()
  }
}
</script>

<template>
  <div v-if="v" class="space-y-4 p-4 text-sm">
    <p v-if="v.dnr" class="text-xs text-slate-600">DNR：{{ v.dnr }}</p>
    <section v-if="!c" class="flex flex-wrap items-center gap-2">
      <span class="text-slate-600">沒有安寧照會。</span>
      <UButton v-if="v.canRequest" class="ml-auto" size="sm" variant="secondary" @click="reason = ''; reqAct.fieldErrors.value = {}; reqOpen = true">提出安寧照會</UButton>
    </section>

    <template v-else>
      <section class="rounded-md border border-slate-200 p-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-semibold text-slate-700">安寧共同照護</span>
          <UBadge :tone="c.status === 'enrolled' ? 'purple' : 'yellow'">{{ statusText[c.status] }}</UBadge>
          <UBadge v-if="c.visitDue && c.visitDue.status !== 'ok'" :tone="c.visitDue.status === 'overdue' ? 'red' : 'yellow'">訪視{{ c.visitDue.status === 'overdue' ? '逾時' : '到期' }}（{{ hm(c.visitDue.dueAt) }}）</UBadge>
          <span class="ml-auto flex gap-2">
            <template v-if="c.status === 'requested' && v.isTeam">
              <UButton size="sm" @click="openDecide(true)">收案</UButton>
              <UButton size="sm" variant="secondary" @click="openDecide(false)">婉拒</UButton>
            </template>
            <UButton v-if="c.status === 'requested' && v.isCare" size="sm" variant="ghost" :loading="cancelAct.pending.value" @click="cancel">撤回</UButton>
            <UButton v-if="c.status === 'enrolled' && v.isTeam" size="sm" @click="openVisit">訪視</UButton>
            <UButton v-if="c.status === 'enrolled' && (v.isTeam || v.isCare)" size="sm" variant="secondary" @click="mt.date = today(); mt.participants = ''; mt.conclusion = ''; mtAct.fieldErrors.value = {}; mtOpen = true">家屬會議</UButton>
          </span>
        </div>
        <p class="mt-1 text-slate-700">{{ c.reason }}<span class="ml-2 text-xs text-slate-500">{{ hm(c.requestedAt) }} {{ c.requestedByName }}照會</span></p>
        <template v-if="c.status === 'enrolled'">
          <p class="text-xs text-slate-600">{{ hm(c.decidedAt) }} {{ c.decidedByName }}收案・末期：{{ c.terminal?.disease }}（{{ c.terminalDoctorNames?.join('、') }}確認）</p>
          <p class="mt-1"><span class="text-xs text-slate-500">照護目標</span> {{ c.goals }}</p>
        </template>
      </section>

      <section v-if="c.visitsView.length" class="rounded-md border border-slate-200 p-3">
        <div class="mb-1 font-semibold text-slate-700">症狀評估（0–10，≥{{ SYMPTOM_SEVERE }} 標紅）</div>
        <div class="overflow-x-auto">
          <table class="tabular w-full min-w-[28rem] text-xs">
            <thead class="text-slate-500"><tr><th class="py-1 text-left font-medium">訪視</th><th v-for="s in SYMPTOMS" :key="s.key" class="px-1 text-center font-medium">{{ s.label }}</th><th class="text-left font-medium">評估與處置</th></tr></thead>
            <tbody>
              <tr v-for="x in c.visitsView" :key="x.id" class="border-t border-slate-100 align-top">
                <td class="py-1">{{ hm(x.at) }}<div class="text-slate-500">{{ x.byName }}</div></td>
                <td v-for="s in SYMPTOMS" :key="s.key" :class="['px-1 py-1 text-center', x.symptoms[s.key] >= SYMPTOM_SEVERE && 'font-semibold text-red-600']">{{ x.symptoms[s.key] }}</td>
                <td class="py-1 text-slate-700">{{ x.note }}<div v-if="x.spiritual" class="text-slate-500">靈性：{{ x.spiritual }}</div><div v-if="x.social" class="text-slate-500">社會：{{ x.social }}</div></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section v-if="c.meetingsView.length" class="rounded-md border border-slate-200 p-3">
        <div class="mb-1 font-semibold text-slate-700">家屬會議</div>
        <div v-for="m in c.meetingsView" :key="m.id" class="border-t border-slate-100 py-1 first:border-t-0"><b class="tabular">{{ m.date.slice(5).replace('-', '/') }}</b> <span class="text-xs text-slate-500">{{ m.participants }}（{{ m.byName }}記）</span><div>{{ m.conclusion }}</div></div>
      </section>
    </template>
    <p v-for="p in v.past" :key="p.id" class="text-xs text-slate-500">{{ hm(p.requestedAt) }} 照會：{{ statusText[p.status] }}<template v-if="p.declineReason">（{{ p.declineReason }}）</template></p>

    <UDialog v-model="reqOpen" title="安寧照會" size="sm" @submit="request">
      <UTextarea v-model="reason" label="照會原因" :rows="3" required :error="reqAct.fieldErrors.value.reason" placeholder="例：肺癌末期，呼吸困難加劇，家屬希望以舒適為主" />
      <template #footer>
        <UButton variant="secondary" @click="reqOpen = false">取消</UButton>
        <UButton type="submit" :loading="reqAct.pending.value">送出</UButton>
      </template>
    </UDialog>
    <UDialog v-model="decOpen" :title="dec.accept ? '安寧收案' : '婉拒安寧照會'" size="sm" @submit="decide">
      <div class="space-y-2">
        <template v-if="dec.accept">
          <USelect v-model="dec.disease" label="末期疾病別" :options="[{ label: '請選', value: '' }, ...PALLIATIVE_DISEASES.map((d) => ({ label: d, value: d }))]" :error="decAct.fieldErrors.value.disease" />
          <div class="grid grid-cols-2 gap-2">
            <USelect v-model="dec.d1" label="專科醫師一" :options="docOpts" />
            <USelect v-model="dec.d2" label="專科醫師二" :options="docOpts" />
          </div>
          <p v-if="decAct.fieldErrors.value.doctorIds" class="text-xs text-red-600">{{ decAct.fieldErrors.value.doctorIds }}</p>
          <UInput v-model="dec.note" label="末期評估說明（選填）" />
          <UTextarea v-model="dec.goals" label="照護目標" :rows="2" required :error="decAct.fieldErrors.value.goals" />
        </template>
        <UTextarea v-else v-model="dec.declineReason" label="婉拒原因" :rows="2" required :error="decAct.fieldErrors.value.declineReason" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="decOpen = false">取消</UButton>
        <UButton type="submit" :loading="decAct.pending.value">{{ dec.accept ? '收案' : '婉拒' }}</UButton>
      </template>
    </UDialog>
    <UDialog v-model="visOpen" title="安寧訪視" @submit="visit">
      <div class="space-y-2">
        <div class="grid grid-cols-5 gap-2">
          <UInput v-for="s in SYMPTOMS" :key="s.key" v-model="vis.symptoms[s.key]" type="number" :label="s.label" :error="visAct.fieldErrors.value[s.key]" />
        </div>
        <UTextarea v-model="vis.note" label="評估與處置" :rows="2" required :error="visAct.fieldErrors.value.note" placeholder="例：呼吸困難 7 分，嗎啡皮下 2 mg Q4H PRN，床頭抬高、電風扇" />
        <UInput v-model="vis.spiritual" label="靈性需求（選填）" />
        <UInput v-model="vis.social" label="社會需求（選填）" />
        <UInput v-model="vis.goals" label="更新照護目標（選填）" />
        <p class="text-xs text-slate-500">每次訪視帶入一次安寧共同照護費。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="visOpen = false">取消</UButton>
        <UButton type="submit" :loading="visAct.pending.value">儲存</UButton>
      </template>
    </UDialog>
    <UDialog v-model="mtOpen" title="家屬會議" size="sm" @submit="meeting">
      <div class="space-y-2">
        <UInput v-model="mt.date" type="date" label="日期" :error="mtAct.fieldErrors.value.date" />
        <UInput v-model="mt.participants" label="參與者" :error="mtAct.fieldErrors.value.participants" placeholder="例：配偶、長子、主治、安寧醫師、社工" />
        <UTextarea v-model="mt.conclusion" label="結論" :rows="3" required :error="mtAct.fieldErrors.value.conclusion" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="mtOpen = false">取消</UButton>
        <UButton type="submit" :loading="mtAct.pending.value">儲存</UButton>
      </template>
    </UDialog>
  </div>
</template>
