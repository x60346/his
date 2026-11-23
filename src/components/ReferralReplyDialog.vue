<script setup lang="ts">
// 轉診回覆單（醫師）：預設帶本院診斷、這次的用藥與處置、計畫；存好後預覽、列印（記下列印）。
// 能不能回覆（看完診、持單那次、自己的病人）由服務層判斷
import { reactive, ref, watch } from 'vue'
import { Printer } from 'lucide-vue-next'
import { UButton, UDialog, UTextarea } from '@/components/ui'
import ReferralReplyPrint from './ReferralReplyPrint.vue'
import { referralApi, type ReferralInView, type ReferralReplyInput } from '@/services'
import { useAction } from '@/composables/useService'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ visitId?: string }>()
const form = reactive<ReferralReplyInput>({ diagnosis: '', treatment: '', advice: '' })
/** 存好之後切到預覽 */
const saved = ref<ReferralInView>()
const dlg = ref<InstanceType<typeof UDialog>>()
const draftAct = useAction(referralApi.referralReplyDraft)
watch(open, async (o) => {
  if (!o || !props.visitId) return
  saved.value = undefined
  // 走 useAction：不能開回覆單時顯示原因（以前對話框打開又自己關掉，沒有說明）
  const d = await draftAct.run(props.visitId)
  if (d) Object.assign(form, d)
  else open.value = false
})
const save = useAction(referralApi.saveReferralReply, { success: () => '已存轉診回覆單，可以列印' })
async function submit() {
  if (!props.visitId) return
  const r = await save.run(props.visitId, { ...form })
  if (!r) return
  saved.value = r
  dlg.value?.markSaved()
}
const doPrint = useAction(referralApi.printReferralReply)
async function print() {
  if (!props.visitId) return
  const r = await doPrint.run(props.visitId)
  if (r) {
    saved.value = r
    window.print()
  }
}
</script>

<template>
  <UDialog ref="dlg" v-model="open" title="轉診回覆單" size="lg" @submit="saved ? undefined : submit()">
    <template v-if="!saved">
      <div class="space-y-3">
        <UTextarea v-model="form.diagnosis" label="本院診斷" :rows="2" required :error="save.fieldErrors.value.diagnosis" />
        <UTextarea v-model="form.treatment" label="處置與治療" :rows="3" />
        <UTextarea v-model="form.advice" label="建議" :rows="3" placeholder="例：血壓已調整，請回原院所繼續追蹤" required :error="save.fieldErrors.value.advice" />
      </div>
    </template>
    <ReferralReplyPrint v-else :r="saved" />
    <template #footer>
      <template v-if="!saved">
        <UButton variant="secondary" @click="open = false">取消</UButton>
        <UButton type="submit" :loading="save.pending.value">存檔並預覽</UButton>
      </template>
      <template v-else>
        <UButton variant="secondary" @click="saved = undefined">修改</UButton>
        <UButton :icon="Printer" :loading="doPrint.pending.value" @click="print">列印</UButton>
      </template>
    </template>
  </UDialog>
</template>
