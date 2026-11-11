<script setup lang="ts">
// 辦理出院（住院中心、護理師）：只辦手續，不寫病摘——能不能出院、轉歸與病摘由醫師在住院醫囑頁簽署。
// 醫師還沒准予出院時，這裡只說明原因，不能辦理（服務層也會擋）。
// 開啟時先列出「還沒做完的事」（dischargeCheck）：逾時沒給的藥、沒執行的臨時醫囑要勾選確認才能出院；
// 出院時醫囑停止、逾時沒給的藥標「暫停：出院時未給藥」保留紀錄、還沒到時間的排程取消、病床改為清潔中。
import { computed, ref, watch } from 'vue'
import { UButton, UCheckbox, UDialog, UQueryState } from '@/components/ui'
import DischargeSummaryView from '@/components/DischargeSummaryView.vue'
import { admissionApi, type AdmissionView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ admission?: AdmissionView }>()

const confirmUnfinished = ref(false)
watch(open, (v) => v && (confirmUnfinished.value = false))

const ready = computed(() => !!props.admission?.dischargeReady)
// 對話框打開、醫師已准予出院時才查，資料是「按下出院那一刻」附近的狀態
const { data: check, loading } = useQuery(
  async () => (open.value && ready.value && props.admission ? admissionApi.dischargeCheck(props.admission.id) : undefined),
  [open, ready, () => props.admission?.id],
)
const unfinished = computed(() => (check.value ? check.value.overdueMar.length + check.value.pendingStat.length : 0))

const discharge = useAction(admissionApi.discharge, { success: (a) => `${a.patientName} 已辦理出院，${a.bed?.bedNo ?? '病床'} 改為清潔中` })
async function submit() {
  if (!props.admission) return
  const ok = await discharge.run(props.admission.id, { confirmUnfinished: confirmUnfinished.value })
  if (ok) open.value = false
}
const md = (s: string) => `${s.slice(5, 10).replace('-', '/')} ${s.slice(11)}`
</script>

<template>
  <UDialog v-model="open" :title="`辦理出院：${admission?.patientName ?? ''}`" size="md">
    <div class="space-y-3 text-sm">
      <p class="text-slate-600">住院號 {{ admission?.admitNo }}・住院第 {{ admission?.days }} 天・{{ admission?.diagnosis }}</p>

      <!-- 醫師還沒准予出院：說明要等誰、做什麼，不給按 -->
      <div v-if="!ready" class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
        <div class="font-medium">醫師尚未准予出院</div>
        <p class="mt-1 text-xs">出院病摘與轉歸由醫師在「住院醫囑」頁撰寫並簽署（主治：{{ admission?.doctorName }}）。簽署後這裡才能辦理出院。</p>
        <p v-if="admission?.dischargeSummary" class="mt-1 text-xs">目前病摘為草稿（{{ admission.dischargeSummary.writtenAt }} 儲存，未簽署）。</p>
      </div>

      <template v-else>
        <section class="rounded-md border border-slate-200 p-3">
          <h3 class="mb-2 font-semibold text-slate-700">出院病摘（醫師簽署）</h3>
          <DischargeSummaryView v-if="admission?.dischargeSummary" :summary="admission.dischargeSummary" :doctor-name="admission.summaryDoctorName" />
        </section>

        <UQueryState :loading="loading && !check" :ready="!!check">
          <template v-if="check">
            <!-- 還沒做完的事：要逐項看過、勾選確認 -->
            <div v-if="unfinished" class="space-y-2 rounded-md border border-red-200 bg-red-50 px-3 py-2">
              <div class="font-medium text-red-800">還有 {{ unfinished }} 項未執行</div>
              <ul class="tabular space-y-0.5 text-xs text-red-800">
                <li v-for="m in check.overdueMar" :key="m.scheduledAt + m.content">逾時未給藥：{{ md(m.scheduledAt) }} {{ m.content }}</li>
                <li v-for="o in check.pendingStat" :key="o.startAt + o.content">未執行臨時醫囑：{{ o.content }}（{{ md(o.startAt) }} 開立）</li>
              </ul>
              <UCheckbox v-model="confirmUnfinished" label="已確認以上未執行項目，仍要辦理出院" />
              <p v-if="discharge.fieldErrors.value.confirmUnfinished" class="text-xs text-red-700">{{ discharge.fieldErrors.value.confirmUnfinished }}</p>
            </div>
            <p v-else class="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">沒有逾時未給的藥、也沒有未執行的臨時醫囑。</p>
            <p v-if="check.unacked" class="mt-2 text-xs text-amber-700">另有 {{ check.unacked }} 項醫囑異動護理師尚未核對。</p>
            <p class="mt-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
              出院後：{{ check.activeLong }} 項長期醫囑停止<template v-if="check.laterMar">、{{ check.laterMar }} 筆還沒到時間的給藥排程取消</template><template v-if="check.overdueMar.length">、逾時未給的藥記為「暫停：出院時未給藥」</template>、病床改為「清潔中」。
            </p>
          </template>
        </UQueryState>
      </template>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">{{ ready ? '取消' : '關閉' }}</UButton>
      <UButton v-if="ready" variant="danger" :disabled="unfinished > 0 && !confirmUnfinished" :loading="discharge.pending.value" @click="submit">確認出院</UButton>
    </template>
  </UDialog>
</template>
