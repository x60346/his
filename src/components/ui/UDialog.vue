<script setup lang="ts">
// 對話框：Teleport 到 body，避免被父層 overflow 截掉；Esc 或點背景關閉（persistent 時不關）。
//
// 防止誤關：使用者在對話框裡輸入或選擇過任何內容後，點背景、按 Esc 都不會關閉，
// 只能按「取消」或 ×。以前點到灰色背景就關掉，重開時內容已清空——醫囑、出院摘要寫到一半就沒了。
// 沒有輸入過的（例如單純的確認框）照舊可以點背景關閉。
import { onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'

const open = defineModel<boolean>({ default: false })
const props = withDefaults(defineProps<{ title?: string; size?: 'sm' | 'md' | 'lg' | 'xl'; persistent?: boolean }>(), { size: 'md' })

const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' }

/** 對話框打開後，使用者是否輸入／選擇過內容 */
const touched = ref(false)
/** 剛剛擋下一次關閉：短暫顯示提示，讓人知道不是當機 */
const blockedHint = ref(false)
let hintTimer: ReturnType<typeof setTimeout> | undefined

function close() {
  if (props.persistent) return
  if (touched.value) {
    blockedHint.value = true
    clearTimeout(hintTimer)
    hintTimer = setTimeout(() => (blockedHint.value = false), 2500)
    return
  }
  open.value = false
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
watch(
  open,
  (v) => {
    if (v) {
      touched.value = false
      blockedHint.value = false
      window.addEventListener('keydown', onKey)
    } else window.removeEventListener('keydown', onKey)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  clearTimeout(hintTimer)
})
</script>

<template>
  <Teleport to="body">
    <Transition enter-from-class="opacity-0" leave-to-class="opacity-0" enter-active-class="transition duration-150" leave-active-class="transition duration-100">
      <div v-if="open" class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[8vh]" @mousedown.self="close">
        <div :class="['w-full rounded-lg bg-white shadow-xl', widths[size]]" role="dialog" aria-modal="true" @input="touched = true" @change="touched = true">
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
          <p v-if="blockedHint" class="border-t border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800" role="status">有尚未送出的內容，請按「取消」或 × 關閉。</p>
          <footer v-if="$slots.footer" class="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
