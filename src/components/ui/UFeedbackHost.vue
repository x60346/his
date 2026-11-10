<script setup lang="ts">
// 全域提示與確認框的畫面。在 App.vue 放一次即可，內容由 stores/ui 控制。
import { computed } from 'vue'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-vue-next'
import { useUi } from '@/stores/ui'
import UButton from './UButton.vue'
import UDialog from './UDialog.vue'

const ui = useUi()

const icons = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle }
const colors = {
  success: 'border-emerald-200 text-emerald-800 [&_svg]:text-emerald-500',
  error: 'border-red-200 text-red-800 [&_svg]:text-red-500',
  info: 'border-blue-200 text-blue-800 [&_svg]:text-blue-500',
  warning: 'border-amber-200 text-amber-900 [&_svg]:text-amber-500',
}

const confirmOpen = computed({
  get: () => !!ui.confirmState,
  set: (v) => !v && ui.answer(false),
})
</script>

<template>
  <Teleport to="body">
    <!-- 上方置中：右上角是頁面主要按鈕、底部是看診操作列，提示框都不該擋住 -->
    <div class="pointer-events-none fixed left-1/2 top-3 z-[60] flex w-80 -translate-x-1/2 flex-col gap-2" aria-live="polite">
      <TransitionGroup enter-from-class="-translate-y-2 opacity-0" leave-to-class="opacity-0" enter-active-class="transition duration-200" leave-active-class="transition duration-150">
        <div v-for="t in ui.toasts" :key="t.id" :class="['pointer-events-auto flex items-start gap-2 rounded-md border bg-white px-3 py-2.5 text-sm shadow-lg', colors[t.kind]]">
          <component :is="icons[t.kind]" class="mt-0.5 h-4 w-4 shrink-0" />
          <span class="flex-1">{{ t.message }}</span>
          <button class="text-slate-400 hover:text-slate-600" aria-label="關閉" @click="ui.dismiss(t.id)"><X class="!text-slate-400 h-3.5 w-3.5" /></button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>

  <UDialog v-model="confirmOpen" :title="ui.confirmState?.title ?? '請確認'" size="sm">
    <p class="whitespace-pre-line text-sm text-slate-700">{{ ui.confirmState?.message }}</p>
    <template #footer>
      <UButton variant="secondary" @click="ui.answer(false)">{{ ui.confirmState?.cancelText ?? '取消' }}</UButton>
      <UButton :variant="ui.confirmState?.danger ? 'danger' : 'primary'" @click="ui.answer(true)">{{ ui.confirmState?.okText ?? '確定' }}</UButton>
    </template>
  </UDialog>
</template>
