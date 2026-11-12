<script setup lang="ts">
// 文字欄位下方的一行提示：怎麼用片語、我有哪些簡碼，和「管理片語」入口。
import { ref } from 'vue'
import PhraseManager from './PhraseManager.vue'

defineProps<{ phrases?: { code: string }[] }>()
const open = ref(false)
</script>

<template>
  <p class="text-xs text-slate-500">
    片語：輸入「.簡碼」再按空白鍵展開<template v-if="phrases?.length">（{{ phrases.slice(0, 3).map((p) => '.' + p.code).join('、') }}{{ phrases.length > 3 ? '…' : '' }}）</template>
    <button type="button" class="ml-1 text-brand-600 hover:underline" @click="open = true">管理片語</button>
    <PhraseManager v-model="open" />
  </p>
</template>
