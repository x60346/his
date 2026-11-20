<script setup lang="ts">
// 健保審查回覆（主治醫師）：事前審查（填寫、補件、自費、緊急先用）；我的病人被健保核減的——申復（寫理由）或接受，之後看得到申復結果。
// 申復後仍維持的，申報組可再申請爭議審議（醫師這裡看得到進度）。誰能回覆、只回覆一次由服務層判斷（claim-cut.replyCut）
import { computed, reactive, ref } from 'vue'
import { UBadge, UButton, UDialog, UPageHeader, UQueryState, USelect, UTextarea } from '@/components/ui'
import { CLAIM_KIND_LABEL, claimCutApi, CUT_STATUS_TONE as TONE, type CutItem } from '@/services'
import PreAuthDoctorSection from './PreAuthDoctorSection.vue'
import CodingDoctorSection from './CodingDoctorSection.vue'
import RecordDoctorSection from './RecordDoctorSection.vue'
import OpdReviewDoctorSection from './OpdReviewDoctorSection.vue'
import { useAction, useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => claimCutApi.myCuts(), [])
const fmt = (n: number) => n.toLocaleString('zh-TW')
const rep = ref<CutItem>()
const open = computed({ get: () => !!rep.value, set: (x) => !x && (rep.value = undefined) })
const f = reactive({ action: 'appeal' as string | number | undefined, text: '' })
function openRep(c: CutItem) {
  Object.assign(f, { action: 'appeal', text: '' })
  act.fieldErrors.value = {}
  rep.value = c
}
const act = useAction(claimCutApi.replyCut, { success: (c) => (c.reply?.action === 'appeal' ? '已申復，等健保署結果' : '已接受核減') })
async function submit() {
  if (rep.value && (await act.run(rep.value.id, { action: f.action as 'appeal' | 'accept', text: f.text }))) rep.value = undefined
}
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="健保審查回覆" description="事前審查的填寫與補件；病歷室修改的編碼；出院病歷待完成；門診病歷抽審；我的病人被健保核減的：申復（寫理由）或接受" />
    <PreAuthDoctorSection />
    <CodingDoctorSection />
    <RecordDoctorSection />
    <OpdReviewDoctorSection />
    <h2 class="font-semibold text-slate-700">核減</h2>
    <UQueryState :loading="loading && !data" :ready="!!data" empty-title="沒有核減">
      <ul v-if="data" class="space-y-2 text-sm">
        <li v-for="c in data" :key="c.id" class="rounded-md border border-slate-200 bg-white px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge :tone="TONE[c.status]">{{ c.statusLabel }}</UBadge>
            <b>{{ c.patientName }}</b><span class="text-xs text-slate-500">{{ c.chartNo }}・{{ c.month }} {{ CLAIM_KIND_LABEL[c.kind] }}・{{ c.date }}・{{ c.diagnosis }}</span>
            <span class="tabular ml-auto font-semibold text-red-700">−{{ fmt(c.points) }} 點</span>
          </div>
          <div class="text-xs text-slate-700">{{ c.item }}・{{ c.codeLabel }}<template v-if="c.reason">：{{ c.reason }}</template></div>
          <div v-if="c.replyText" class="text-xs text-slate-600">我的回覆：{{ c.replyText }}</div>
          <div v-else-if="c.status === 'reply'" :class="['text-xs', c.replyOverdue ? 'font-semibold text-red-700' : 'text-slate-500']">請在 {{ c.replyDue }} 前回覆{{ c.replyOverdue ? '（已逾期：申報組要趕申復期限）' : '' }}</div>
          <div v-if="c.resultText" class="text-xs" :class="c.status === 'paid' ? 'text-emerald-700' : 'text-red-700'">申復結果：{{ c.resultText }}</div>
          <div v-if="c.disputeText" class="text-xs text-purple-800">爭議審議（申報組）：{{ c.disputeText }}</div>
          <div v-if="c.disputeResultText" class="text-xs" :class="c.status === 'disputePaid' ? 'text-emerald-700' : 'text-red-700'">爭議審議結果：{{ c.disputeResultText }}</div>
          <div v-if="c.status === 'reply'" class="mt-1 text-right"><UButton size="sm" @click="openRep(c)">回覆</UButton></div>
        </li>
      </ul>
    </UQueryState>
    <UDialog v-model="open" :title="`核減回覆：${rep?.patientName ?? ''} ${rep?.item ?? ''}`" size="md" @submit="submit">
      <div class="space-y-3 text-sm">
        <USelect v-model="f.action" label="決定" :options="[{ label: '申復', value: 'appeal' }, { label: '接受核減', value: 'accept' }]" :error="act.fieldErrors.value.action" />
        <UTextarea v-model="f.text" :label="f.action === 'appeal' ? '申復理由（病情需要、病歷佐證）' : '說明（選填）'" :error="act.fieldErrors.value.text" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="rep = undefined">取消</UButton>
        <UButton type="submit" :loading="act.pending.value">送出</UButton>
      </template>
    </UDialog>
  </div>
</template>
