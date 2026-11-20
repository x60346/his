<script setup lang="ts">
// 主治：我主治的出院病人，病歷還沒完成的（出院後 14 天內要完成：出院病摘簽署、手術紀錄、死亡證明書、會診回覆、每天的病程紀錄）。
// 缺什麼、期限、逾期由服務層判斷（record-audit.ts）；病程紀錄缺的日期在這裡直接補寫，其他到各自的頁面補
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UDialog, UQueryState, USelect, UTextarea } from '@/components/ui'
import { recordAuditApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => recordAuditApi.myIncompleteRecords(), [])
// 住院中：最近 7 天每天至少一筆病程紀錄（在「住院醫囑」頁寫；過了那天的在這裡補寫）
const { data: prog } = useQuery(() => recordAuditApi.myMissingProgressNotes(), [])

// ---------- 補寫病程紀錄 ----------
const late = ref<{ admissionId: string; patientName: string; dates: string[] }>()
const lateOpen = computed({ get: () => !!late.value, set: (x) => !x && (late.value = undefined) })
const f = reactive({ forDate: '' as string | number | undefined, subjective: '', objective: '', assessment: '', plan: '' })
function openLate(x: NonNullable<typeof late.value>) {
  Object.assign(f, { forDate: x.dates[0], subjective: '', objective: '', assessment: '', plan: '' })
  act.fieldErrors.value = {}
  late.value = x
}
const act = useAction(recordAuditApi.addLateProgressNote, { success: (n) => `已補寫 ${n.lateFor} 的病程紀錄` })
async function submitLate() {
  if (late.value && (await act.run({ admissionId: late.value.admissionId, forDate: String(f.forDate ?? ''), subjective: f.subjective, objective: f.objective, assessment: f.assessment, plan: f.plan }))) late.value = undefined
}
</script>

<template>
  <section class="space-y-2">
    <template v-if="prog?.length">
      <h2 class="font-semibold text-slate-700">住院中病程紀錄缺漏<span class="ml-2 text-xs font-normal text-slate-500">每天至少一筆（看最近 7 天；當天的在「住院醫囑」頁寫，過了的在這裡補寫）</span></h2>
      <ul class="space-y-1 text-sm">
        <li v-for="p in prog" :key="p.admissionId" class="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-white px-3 py-1.5">
          <div class="min-w-0 flex-[1_1_14rem]">
            <b>{{ p.patientName }}</b><span class="text-xs text-slate-500">・{{ p.admitNo }}{{ p.bedText ? `・${p.bedText}` : '' }}・入院 {{ p.admittedAt.slice(5, 10) }}</span>
            <div class="text-xs text-amber-800">沒有病程紀錄：{{ p.dates.map((d) => d.slice(5)).join('、') }}</div>
          </div>
          <UButton size="sm" variant="secondary" @click="openLate({ admissionId: p.admissionId, patientName: p.patientName, dates: p.dates })">補寫</UButton>
        </li>
      </ul>
    </template>
    <h2 class="font-semibold text-slate-700">出院病歷待完成<span class="ml-2 text-xs font-normal text-slate-500">出院後 14 天內要完成</span></h2>
    <UQueryState :loading="loading && !data" :ready="!!data?.length" empty-title="出院病歷都完成了">
      <ul v-if="data" class="space-y-2 text-sm">
        <li v-for="x in data" :key="x.admissionId" :class="['rounded-md border bg-white px-3 py-2', x.overdue ? 'border-red-300' : 'border-slate-200']">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge v-if="x.overdue" tone="red">逾期</UBadge>
            <b>{{ x.patientName }}</b><span class="text-xs text-slate-500">{{ x.chartNo }}・{{ x.admitNo }}・出院 {{ x.dischargedAt.slice(0, 10) }}（{{ x.dischargeType }}）・期限 {{ x.due }}</span>
            <UButton v-if="x.progressGaps.length" size="sm" variant="secondary" class="ml-auto" @click="openLate({ admissionId: x.admissionId, patientName: x.patientName, dates: x.progressGaps })">補寫病程紀錄</UButton>
          </div>
          <div class="text-xs text-red-700">缺：{{ x.gaps.join('；') }}</div>
        </li>
      </ul>
    </UQueryState>
    <UDialog v-model="lateOpen" :title="`補寫病程紀錄：${late?.patientName ?? ''}`" size="md" @submit="submitLate">
      <div class="space-y-3 text-sm">
        <p class="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">補寫的紀錄會標「補寫」，時間記現在（不是補的那天）；請依當天的病況與檢查結果寫。</p>
        <USelect v-model="f.forDate" label="補哪一天" :options="(late?.dates ?? []).map((d) => ({ label: d, value: d }))" :error="act.fieldErrors.value.forDate" />
        <UTextarea v-model="f.subjective" label="S 主觀" :rows="2" />
        <UTextarea v-model="f.objective" label="O 客觀" :rows="2" />
        <UTextarea v-model="f.assessment" label="A 評估" :rows="2" />
        <UTextarea v-model="f.plan" label="P 計畫" :rows="2" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="late = undefined">取消</UButton>
        <UButton type="submit" :loading="act.pending.value">補寫</UButton>
      </template>
    </UDialog>
  </section>
</template>
