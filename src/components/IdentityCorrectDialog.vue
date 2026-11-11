<script setup lang="ts">
// 更正就醫身分：批價頁（待批價）與掛號清單（候診中）共用。
// 規則（只能更正還沒收費的、原因必填、寫入稽核）在服務層 bookingApi.correctIdentity。
import { reactive, watch } from 'vue'
import { UButton, UDialog, USelect, UTextarea } from '@/components/ui'
import { bookingApi, masterApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ visitId?: string; identityCode?: string; subject?: string }>()
const emit = defineEmits<{ saved: [] }>()

const { data: identities } = useQuery(() => masterApi.listIdentities())
const presets = ['出示榮民證', '出示低收入戶證明', '重大傷病卡', '掛號時選錯']
const form = reactive({ identityCode: undefined as string | number | undefined, reason: '' })
watch(open, (v) => v && Object.assign(form, { identityCode: props.identityCode, reason: '' }))

const save = useAction(bookingApi.correctIdentity, { success: '已更正就醫身分' })
async function submit() {
  if (!props.visitId) return
  if (await save.run(props.visitId, String(form.identityCode ?? ''), form.reason)) {
    open.value = false
    emit('saved')
  }
}
</script>

<template>
  <UDialog v-model="open" title="更正就醫身分" size="sm" @submit="submit">
    <div class="space-y-3">
      <div v-if="subject" class="rounded-md bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700">{{ subject }}</div>
      <USelect v-model="form.identityCode" label="就醫身分" required :options="(identities ?? []).map((i) => ({ label: `${i.name}（掛號費 ${i.regFee} 元）`, value: i.code }))" :error="save.fieldErrors.value.identityCode" />
      <div class="flex flex-wrap gap-1.5">
        <UButton v-for="p in presets" :key="p" size="sm" variant="secondary" @click="form.reason = p">{{ p }}</UButton>
      </div>
      <UTextarea v-model="form.reason" label="更正原因" required :rows="2" :error="save.fieldErrors.value.reason" />
      <p class="text-xs text-slate-500">更正後收費會依新身分重新計算，並寫入稽核紀錄。</p>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton type="submit" :loading="save.pending.value">更正</UButton>
    </template>
  </UDialog>
</template>
