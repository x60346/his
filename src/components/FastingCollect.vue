<script setup lang="ts">
// 採檢按鈕：有要空腹的檢驗（飯前血糖、膽固醇、三酸甘油酯）分兩顆——「採檢（空腹）」、「非空腹…」（寫原因，照樣採；標籤與報告註明非空腹）。
// 沒有要空腹的就是一顆「採檢」。病房、抽血櫃台、護理站執行臨時檢驗共用
import { ref } from 'vue'
import { UButton } from '@/components/ui'
import ReasonDialog from '@/components/ReasonDialog.vue'

const props = withDefaults(defineProps<{ needsFasting: boolean; pending?: boolean; label?: string }>(), { label: '採檢' })
const emit = defineEmits<{ collect: [opts: { fasting?: boolean; note?: string }] }>()
const ask = ref(false)
function notFasting(note: string) {
  ask.value = false
  emit('collect', { fasting: false, note })
}
</script>

<template>
  <span class="inline-flex flex-wrap gap-1">
    <UButton v-if="!props.needsFasting" size="sm" variant="secondary" :loading="pending" @click="emit('collect', {})">{{ label }}</UButton>
    <template v-else>
      <UButton size="sm" variant="secondary" :loading="pending" @click="emit('collect', { fasting: true })">{{ label }}（空腹）</UButton>
      <UButton size="sm" variant="ghost" @click="ask = true">非空腹…</UButton>
    </template>
    <ReasonDialog v-model="ask" title="非空腹採檢" subject="這支有要空腹的檢驗：照樣採檢，標籤與報告會註明非空腹" label="原因" :presets="['早上吃過早餐', '打含糖點滴中', '病人不確定']" ok-text="照樣採檢" @confirm="notFasting" />
  </span>
</template>
