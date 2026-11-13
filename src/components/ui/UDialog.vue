<script setup lang="ts">
// 對話框：Teleport 到 body，避免被父層 overflow 截掉；Esc 或點背景關閉（persistent 時不關）。
//
// 防止誤關：使用者在對話框裡輸入或選擇過任何內容後，點背景、按 Esc 都不會關閉，
// 只能按「取消」或 ×。以前點到灰色背景就關掉，重開時內容已清空——醫囑、出院摘要寫到一半就沒了。
// 沒有輸入過的（例如單純的確認框）照舊可以點背景關閉。
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'

const open = defineModel<boolean>({ default: false })
const props = withDefaults(
  defineProps<{
    title?: string
    size?: 'sm' | 'md' | 'lg' | 'xl'
    persistent?: boolean
    /**
     * 疊在其他對話框上面（確認框）：對話框都 Teleport 到 body，誰在上面取決於「掛上的先後」——
     * 確認框的宿主最早掛上，不加這個就會被之後打開的對話框蓋住，滑鼠點到的是底下那層
     */
    top?: boolean
    /**
     * 有綁 @submit 時，對話框以 <form> 呈現：單行欄位按 Enter 就送出（主要按鈕要設 type="submit"），
     * 多行文字框按 Enter 是換行（瀏覽器原生行為）。
     * 只給「送出後還能修改」的資料維護表單用；開立醫囑、出院、停診這類不可逆或臨床動作刻意不綁，
     * 避免手還在輸入時誤按 Enter 就送出。
     */
    onSubmit?: () => void
  }>(),
  { size: 'md' },
)

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
// 鍵盤使用者：打開時游標移進對話框（第一個輸入欄位；沒有就停在對話框本身），
// 關閉時回到打開前的位置（例如按下的「修改」按鈕），不必按一堆 Tab 才找得到
const panel = ref<HTMLElement>()
let returnFocus: HTMLElement | null = null
async function focusInside() {
  await nextTick()
  const first = panel.value?.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])')
  ;(first ?? panel.value)?.focus()
}

watch(
  open,
  (v) => {
    if (v) {
      touched.value = false
      blockedHint.value = false
      window.addEventListener('keydown', onKey)
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      focusInside()
    } else {
      window.removeEventListener('keydown', onKey)
      returnFocus?.focus()
      returnFocus = null
    }
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
      <div v-if="open" :class="['fixed inset-0 flex', top ? 'z-[55]' : 'z-50']" class="items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[8vh]" @mousedown.self="close">
        <!-- novalidate：必填等檢查交給服務層一次標出所有欄位，不用瀏覽器一次只跳一個的原生提示 -->
        <component
          :is="onSubmit ? 'form' : 'div'"
          ref="panel"
          :class="['w-full rounded-lg bg-white shadow-xl outline-none', widths[size]]"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          :novalidate="onSubmit ? true : undefined"
          @input="touched = true"
          @change="touched = true"
          @submit.prevent="onSubmit?.()"
        >
          <header v-if="title || $slots.header" class="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <slot name="header">
              <h2 class="text-base font-semibold text-slate-800">{{ title }}</h2>
            </slot>
            <!-- type="button"：在 <form> 裡沒寫 type 的按鈕預設是送出，按 × 會變成送出表單 -->
            <button type="button" class="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="關閉" @click="open = false">
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
        </component>
      </div>
    </Transition>
  </Teleport>
</template>
