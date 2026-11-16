<script setup lang="ts">
// 開藥前確認交互作用、重複用藥提醒（門診完成看診、住院開醫囑共用）：
// 「注意」確認即可（原因選填）；「嚴重」一定要寫原因——原因存進病歷／醫囑，藥師調劑時看得到。
// 用法：const r = await confirmRef.value.ask(alerts, 之前寫過的原因)；取消回傳 null，確認回傳 key → 原因
import { reactive, ref } from 'vue'
import { UBadge, UButton, UDialog, UInput } from '@/components/ui'
import { RX_ALERT_LEVEL_LABEL, type RxAlert } from '@/services'

const open = ref(false)
const list = ref<RxAlert[]>([])
const reasons = reactive<Record<string, string>>({})
const errors = reactive<Record<string, string>>({})
let resolve: ((r: Record<string, string> | null) => void) | undefined

function ask(alerts: RxAlert[], prev: Record<string, string> = {}): Promise<Record<string, string> | null> {
  list.value = alerts
  for (const k of Object.keys(reasons)) delete reasons[k]
  for (const k of Object.keys(errors)) delete errors[k]
  for (const a of alerts) reasons[a.key] = prev[a.key] ?? ''
  open.value = true
  return new Promise((r) => (resolve = r))
}
function finish(r: Record<string, string> | null) {
  resolve?.(r)
  resolve = undefined
  open.value = false
}
function submit() {
  for (const k of Object.keys(errors)) delete errors[k]
  for (const a of list.value) if (a.level === 'severe' && !reasons[a.key]?.trim()) errors[a.key] = '嚴重的交互作用要寫原因（例：已評估效益大於風險，追蹤 INR）'
  if (Object.keys(errors).length) return
  finish(Object.fromEntries(list.value.map((a) => [a.key, reasons[a.key].trim()])))
}
defineExpose({ ask })
</script>

<template>
  <UDialog :model-value="open" title="用藥提醒：交互作用、重複用藥" size="lg" @update:model-value="(v: boolean) => !v && finish(null)" @submit="submit">
    <div class="space-y-3">
      <p class="text-sm text-slate-600">請逐項確認。<b class="text-red-700">嚴重</b>的要寫原因才能開，原因會記在病歷，藥師調劑時看得到。</p>
      <div v-for="a in list" :key="a.key" :class="['rounded-lg border px-3 py-2', a.level === 'severe' ? 'border-red-300 bg-red-50' : 'border-amber-200 bg-amber-50']">
        <div class="flex flex-wrap items-center gap-1.5 text-sm">
          <UBadge :tone="a.level === 'severe' ? 'red' : 'yellow'">{{ RX_ALERT_LEVEL_LABEL[a.level] }}</UBadge>
          <span class="font-medium text-slate-800">{{ a.title }}</span>
        </div>
        <div class="mt-0.5 text-xs text-slate-700">{{ a.text }}</div>
        <div v-if="a.other" class="text-xs text-slate-500">{{ a.other }}</div>
        <UInput v-model="reasons[a.key]" class="mt-2" :label="a.level === 'severe' ? '仍要開立的原因' : '說明（選填）'" :required="a.level === 'severe'" :error="errors[a.key]" />
      </div>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="finish(null)">回去修改</UButton>
      <UButton type="submit" :variant="list.some((a) => a.level === 'severe') ? 'danger' : 'primary'">確認，仍要開立</UButton>
    </template>
  </UDialog>
</template>
