<script setup lang="ts">
// 住院病人的影像檢查（護理站、住院醫囑的病人分頁「檢查」）：排了哪些檢查、幾點、在哪一間、到哪一步；
// 檢查前後 30 分鐘內有還沒給的藥標出來（病人可能不在病房，要提早或延後給）；檢查前準備（禁食、顯影劑同意書）提醒病房先做好、
// 含顯影劑的腎功能判斷；過了時間沒去的標「未到」；還沒排的列出來（等檢查室排程）。
// 顯影劑安全（醫師）：過敏要放行（前置用藥）、CrCl 30–45 一鍵開水化醫囑、做完後暫停 Metformin 的提醒按已處理
import { computed, ref } from 'vue'
import { UBadge, UButton, UQueryState } from '@/components/ui'
import ContrastClearDialog from '@/components/ContrastClearDialog.vue'
import { EXAM_MAR_MARGIN, examApi, ipdApi, type ExamView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'

const props = defineProps<{ admissionId: string }>()
const { data, loading } = useQuery(() => examApi.admissionExams(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const TONE = { scheduled: 'blue', arrived: 'yellow', done: 'green' } as const
const auth = useAuth()
const isDoctor = computed(() => auth.user?.role === 'doctor')
const clearing = ref<ExamView>()
const clearOpen = computed({ get: () => !!clearing.value, set: (x) => !x && (clearing.value = undefined) })
const hydrate = useAction(ipdApi.orderContrastHydration, { success: (o) => `已開立：${o.content}` })
const ackMet = useAction(examApi.ackMetforminAlert, { success: '已處理 Metformin 暫停提醒' })
</script>

<template>
  <UQueryState :loading="loading && !v" :ready="!!v">
    <div v-if="v" class="space-y-2 text-sm">
      <p v-if="!v.exams.length && !v.unscheduled.length" class="text-slate-400">沒有待做的影像檢查。</p>
      <ul v-if="v.exams.length" class="divide-y divide-slate-100 rounded border border-slate-200">
        <li v-for="e in v.exams" :key="e.id" class="space-y-0.5 px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="tabular font-semibold">{{ e.start.slice(5) }}–{{ e.end.slice(11) }}</span>
            <span>{{ e.procName }}・{{ e.roomName }}</span>
            <UBadge :tone="e.noShow ? 'red' : TONE[e.stage]" class="ml-auto">{{ e.stageLabel }}</UBadge>
          </div>
          <div v-if="e.marConflicts.length" class="text-xs font-medium text-amber-800">檢查前後 {{ EXAM_MAR_MARGIN }} 分鐘內有給藥：{{ e.marConflicts.map((t) => t.slice(11)).join('、') }}（病人可能不在病房，請提早或延後給）</div>
          <div v-if="e.prepItems.length" class="text-xs text-indigo-800">檢查前準備：{{ e.prepItems.map((p) => `${p.label}${p.ok === true ? '✓' : p.ok === false ? `✗（${p.note}）` : ''}`).join('、') }}</div>
          <div v-if="e.contrast && e.contrast.level !== 'ok'" :class="['text-xs', e.contrast.level === 'block' ? 'font-semibold text-red-700' : 'text-amber-800']">顯影劑：{{ e.contrast.text }}</div>
          <div v-if="e.safety.allergy" :class="['flex flex-wrap items-center gap-2 text-xs', e.safety.allergy.cleared ? 'text-slate-600' : 'font-semibold text-red-700']">
            顯影劑過敏（{{ e.safety.allergy.text }}）：{{ e.safety.allergy.cleared ? `${e.safety.allergy.cleared.byName} 已放行（${e.safety.allergy.cleared.reason}）` : '醫師確認前置用藥並放行前，檢查室不能報到' }}
            <UButton v-if="isDoctor && !e.safety.allergy.cleared" size="sm" variant="danger" @click="clearing = e">放行</UButton>
          </div>
          <div v-if="e.safety.metformin" class="text-xs font-medium text-amber-800">{{ e.safety.metformin }}</div>
          <div v-if="e.safety.hydration" class="flex flex-wrap items-center gap-2 text-xs text-amber-800">
            建議水化：{{ e.safety.hydration.text }}<span v-if="e.hydrationOrderId" class="text-slate-500">（已開醫囑）</span>
            <UButton v-else-if="isDoctor" size="sm" variant="secondary" :loading="hydrate.pending.value" @click="hydrate.run(e.id)">開水化醫囑</UButton>
          </div>
          <div v-if="e.noShow" class="text-xs font-medium text-red-700">過了排程時間還沒到檢查室：請送病人過去，或請檢查室改時間</div>
        </li>
      </ul>
      <div v-for="m in v.metforminAlerts" :key="m.id" class="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
        <span class="min-w-0 flex-1">{{ m.procName }} {{ m.doneAt?.slice(5) }} 做完：{{ m.metforminAlertText }}</span>
        <UButton v-if="isDoctor" size="sm" :loading="ackMet.pending.value" @click="ackMet.run(m.id)">已處理</UButton>
      </div>
      <p v-if="v.unscheduled.length" class="text-xs text-slate-600">等檢查室排程：{{ v.unscheduled.join('、') }}</p>
    </div>
  </UQueryState>
  <ContrastClearDialog v-model="clearOpen" :exam-key="clearing?.key ?? ''" :subject="clearing ? `${clearing.patientName} ${clearing.procName}（${clearing.start.slice(5)}）：過敏 ${clearing.safety.allergy?.text}` : ''" />
</template>
