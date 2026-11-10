<script setup lang="ts">
// 對話框：Teleport 到 body，避免被父層 overflow 截掉；Esc 或點背景關閉（persistent 時不關）。
import { onBeforeUnmount, watch } from 'vue'
import { X } from 'lucide-vue-next'

const open = defineModel<boolean>({ default: false })
const props = withDefaults(defineProps<{ title?: string; size?: 'sm' | 'md' | 'lg' | 'xl'; persistent?: boolean }>(), { size: 'md' })

const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' }

function close() {
  if (!props.persistent) open.value = false
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
watch(open, (v) => (v ? window.addEventListener('keydown', onKey) : window.removeEventListener('keydown', onKey)), { immediate: true })
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <Transition enter-from-class="opacity-0" leave-to-class="opacity-0" enter-active-class="transition duration-150" leave-active-class="transition duration-100">
      <div v-if="open" class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[8vh]" @mousedown.self="close">
        <div :class="['w-full rounded-lg bg-white shadow-xl', widths[size]]" role="dialog" aria-modal="true">
          <header v-if="title || $slots.header" class="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <slot name="header">
              <h2 class="text-base font-semibold text-slate-800">{{ title }}</h2>
            </slot>
            <button class="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="關閉" @click="open = false">
              <X class="h-4 w-4" />
            </button>
          </header>
          <div class="px-5 py-4">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
