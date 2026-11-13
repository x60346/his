<script setup lang="ts">
// 文字欄位下方的一行提示：怎麼用片語、我有哪些簡碼，和「管理片語」入口。
// 傳 usePhrases() 的結果：清單（個人在前、共用在後）與目前的病房（護理師的病房共用片語）
import { computed, ref } from 'vue'
import PhraseManager from './PhraseManager.vue'
import type { usePhrases } from '@/composables/usePhrases'

const props = defineProps<{ phrase: ReturnType<typeof usePhrases> }>()
const open = ref(false)
// 被個人片語蓋住的共用簡碼不列（展開時用不到）
const usable = computed(() => props.phrase.phrases.value.filter((p) => !p.shadowed))
</script>

<template>
  <p class="text-xs text-slate-500">
    片語：輸入「.簡碼」再按空白鍵展開<template v-if="usable.length">（{{ usable.slice(0, 3).map((p) => '.' + p.code).join('、') }}{{ usable.length > 3 ? '…' : '' }}）</template>
    <button type="button" class="ml-1 text-brand-600 hover:underline" @click="open = true">管理片語</button>
    <PhraseManager v-model="open" :ward="phrase.ward()" />
  </p>
</template>
