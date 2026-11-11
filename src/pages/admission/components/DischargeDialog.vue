<script setup lang="ts">
// 出院：選擇轉歸、填寫摘要。開啟時先列出「還沒做完的事」（dischargeCheck）：
// 逾時沒給的藥、沒執行的臨時醫囑要勾選確認才能出院（服務層也會擋）；
// 出院時醫囑停止、逾時沒給的藥標「暫停：出院時未給藥」保留紀錄、還沒到時間的排程取消、病床改為清潔中。
import { computed, reactive, watch } from 'vue'
import { UButton, UCheckbox, UDialog, UQueryState, USelect, UTextarea } from '@/components/ui'
import { admissionApi, masterApi, type AdmissionView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ admission?: AdmissionView }>()

const form = reactive({ dischargeType: '治癒出院' as string | number | undefined, dischargeSummary: '', confirmUnfinished: false })
watch(open, (v) => {
  if (v) Object.assign(form, { dischargeType: '治癒出院', dischargeSummary: '', confirmUnfinished: false })
})

// 對話框打開時才查，資料是「按下出院那一刻」附近的狀態
const { data: check, loading } = useQuery(async () => (open.value && props.admission ? admissionApi.dischargeCheck(props.admission.id) : undefined), [open, () => props.admission?.id])
const unfinished = computed(() => (check.value ? check.value.overdueMar.length + check.value.pendingStat.length : 0))

const discharge = useAction(admissionApi.discharge, { success: (a) => `${a.patientName} 已辦理出院，${a.bed?.bedNo ?? '病床'} 改為清潔中` })
async function submit() {
  if (!props.admission) return
  const ok = await discharge.run(props.admission.id, { dischargeType: String(form.dischargeType), dischargeSummary: form.dischargeSummary, confirmUnfinished: form.confirmUnfinished })
  if (ok) open.value = false
}
const md = (s: string) => `${s.slice(5, 10).replace('-', '/')} ${s.slice(11)}`
</script>

<template>
  <UDialog v-model="open" :title="`辦理出院：${admission?.patientName ?? ''}`" size="md">
    <div class="space-y-3 text-sm">
      <p class="text-slate-600">住院號 {{ admission?.admitNo }}・住院第 {{ admission?.days }} 天・{{ admission?.diagnosis }}</p>

      <UQueryState :loading="loading && !check" :ready="!!check">
        <template v-if="check">
          <!-- 還沒做完的事：要逐項看過、勾選確認 -->
          <div v-if="unfinished" class="space-y-2 rounded-md border border-red-200 bg-red-50 px-3 py-2">
            <div class="font-medium text-red-800">還有 {{ unfinished }} 項未執行</div>
            <ul class="tabular space-y-0.5 text-xs text-red-800">
              <li v-for="m in check.overdueMar" :key="m.scheduledAt + m.content">逾時未給藥：{{ md(m.scheduledAt) }} {{ m.content }}</li>
              <li v-for="o in check.pendingStat" :key="o.startAt + o.content">未執行臨時醫囑：{{ o.content }}（{{ md(o.startAt) }} 開立）</li>
            </ul>
            <UCheckbox v-model="form.confirmUnfinished" label="已確認以上未執行項目，仍要辦理出院" />
            <p v-if="discharge.fieldErrors.value.confirmUnfinished" class="text-xs text-red-700">{{ discharge.fieldErrors.value.confirmUnfinished }}</p>
          </div>
          <p v-else class="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">沒有逾時未給的藥、也沒有未執行的臨時醫囑。</p>
          <p v-if="check.unacked" class="text-xs text-amber-700">另有 {{ check.unacked }} 項醫囑異動護理師尚未核對。</p>
        </template>
      </UQueryState>

      <USelect v-model="form.dischargeType" label="出院轉歸" :options="masterApi.staticCodes.dischargeTypes" />
      <UTextarea v-model="form.dischargeSummary" label="出院摘要" :rows="4" placeholder="住院經過、出院時狀況、出院後追蹤計畫" />
      <p v-if="check" class="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
        出院後：{{ check.activeLong }} 項長期醫囑停止<template v-if="check.laterMar">、{{ check.laterMar }} 筆還沒到時間的給藥排程取消</template><template v-if="check.overdueMar.length">、逾時未給的藥記為「暫停：出院時未給藥」</template>、病床改為「清潔中」。
      </p>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton variant="danger" :disabled="unfinished > 0 && !form.confirmUnfinished" :loading="discharge.pending.value" @click="submit">確認出院</UButton>
    </template>
  </UDialog>
</template>
