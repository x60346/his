<script setup lang="ts">
// 藥事照護紀錄（住院醫囑的病人分頁「藥事照護」）：藥師對這位病人的建議與回覆；主治（照護團隊）接受（可寫怎麼處理）或不接受（寫原因）。
// 藥師寫建議在「住院藥局 > 藥事照護」。規則在服務層 pharmcare.ts
import { computed, ref } from 'vue'
import { UBadge, UButton, UQueryState } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'
import { pharmCareApi, type PharmCareView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { useAuth } from '@/stores/auth'

const props = defineProps<{ admissionId: string }>()
const auth = useAuth()
const isDoctor = computed(() => auth.user?.role === 'doctor')
const { data, loading } = useQuery(() => pharmCareApi.patientPharmCare(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const replying = ref<{ note: PharmCareView; accept: boolean }>()
const replyOpen = computed({ get: () => !!replying.value, set: (x) => !x && (replying.value = undefined) })
const reply = useAction(pharmCareApi.replyPharmCare, { success: (x) => (x.status === 'accepted' ? '已接受藥師建議' : '已回覆不接受，藥師會看到原因') })
async function confirmReply(text: string) {
  const r = replying.value
  if (r && (await reply.run(r.note.id, { accept: r.accept, text }))) replying.value = undefined
}
const TONE = { sent: 'blue', accepted: 'green', declined: 'red' } as const
</script>

<template>
  <UQueryState :loading="loading && !v" :ready="!!v">
    <div v-if="v" class="space-y-2">
      <p v-if="!v.notes.length" class="text-sm text-slate-400">這次住院沒有藥事照護紀錄。</p>
      <ul v-else class="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
        <li v-for="n in v.notes" :key="n.id" class="space-y-1 px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge tone="purple">{{ n.kindLabel }}</UBadge>
            <span class="tabular text-xs text-slate-500">{{ n.byName }} {{ n.at.slice(5).replace('-', '/') }}</span>
            <UBadge :tone="TONE[n.status]" class="ml-auto">{{ n.statusLabel }}</UBadge>
          </div>
          <div class="text-slate-800">{{ n.text }}</div>
          <div v-if="n.reply" class="text-xs text-slate-600">{{ n.replyByName }} {{ n.reply.at.slice(5).replace('-', '/') }}：{{ n.reply.text }}</div>
          <div v-else-if="isDoctor" class="flex justify-end gap-2">
            <UButton size="sm" variant="ghost" @click="replying = { note: n, accept: false }">不接受</UButton>
            <UButton size="sm" @click="replying = { note: n, accept: true }">接受</UButton>
          </div>
        </li>
      </ul>
    </div>
  </UQueryState>
  <ReasonDialog
    v-model="replyOpen"
    :title="replying?.accept ? '接受藥師建議' : '不接受藥師建議'"
    :subject="replying ? `${replying.note.kindLabel}：${replying.note.text}` : ''"
    :label="replying?.accept ? '怎麼處理（選填，例：已改 Q12H）' : '不接受的原因（藥師會看到）'"
    :presets="replying?.accept ? ['已依建議修改醫囑', '已開立追蹤檢驗'] : ['病人臨床穩定，暫時維持', '已會診討論，維持原用藥']"
    :optional="replying?.accept"
    ok-text="送出"
    :pending="reply.pending.value"
    :error="reply.fieldErrors.value.text"
    @confirm="confirmReply"
  />
</template>
