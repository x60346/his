<script setup lang="ts">
// 醫師：我被抽審的門診病歷——分數、不符合的項目與意見；有不符合的要寫改善說明。誰能回覆由服務層判斷（opd-review.ackOpdReview）
import { computed, ref } from 'vue'
import { UBadge, UButton, UDialog, UQueryState, UTextarea } from '@/components/ui'
import { opdReviewApi, type OpdReviewView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => opdReviewApi.myOpdReviews(), [])
const cur = ref<OpdReviewView>()
const open = computed({ get: () => !!cur.value, set: (x) => !x && (cur.value = undefined) })
const note = ref('')
const act = useAction(opdReviewApi.ackOpdReview, { success: '已回覆' })
async function submit() {
  if (cur.value && (await act.run(cur.value.id, note.value))) cur.value = undefined
}
</script>

<template>
  <section class="space-y-2">
    <h2 class="font-semibold text-slate-700">門診病歷抽審</h2>
    <UQueryState :loading="loading && !data" :ready="!!data?.length" empty-title="沒有抽審結果">
      <ul v-if="data" class="space-y-2 text-sm">
        <li v-for="r in data" :key="r.id" class="rounded-md border border-slate-200 bg-white px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge :tone="r.fails.length ? 'red' : 'green'">{{ r.score }} 分</UBadge>
            <span class="text-xs text-slate-500">{{ r.month }} 抽審・{{ r.date }}・{{ r.patientName }}（{{ r.chartNo }}）</span>
            <UButton v-if="r.needAck" size="sm" class="ml-auto" @click="cur = r; note = ''; act.fieldErrors.value = {}">回覆</UButton>
          </div>
          <div v-if="r.fails.length" class="text-xs text-red-700">不符合：{{ r.fails.join('、') }}<template v-if="r.result?.note">（{{ r.result.note }}）</template></div>
          <div v-if="r.ack" class="text-xs text-slate-600">我的回覆：{{ r.ack.note }}</div>
        </li>
      </ul>
    </UQueryState>
    <UDialog v-model="open" :title="`抽審回覆：${cur?.date ?? ''} ${cur?.patientName ?? ''}`" size="md" @submit="submit">
      <div v-if="cur" class="space-y-2 text-sm">
        <p class="text-xs text-red-700">不符合：{{ cur.fails.join('、') }}</p>
        <p v-if="cur.result?.note" class="text-xs text-slate-600">審查意見：{{ cur.result.note }}</p>
        <UTextarea v-model="note" label="改善說明" :error="act.fieldErrors.value.note" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="cur = undefined">取消</UButton>
        <UButton type="submit" :loading="act.pending.value">送出</UButton>
      </template>
    </UDialog>
  </section>
</template>
