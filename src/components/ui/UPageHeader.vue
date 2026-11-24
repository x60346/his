<script setup lang="ts">
// 頁首：版面上方列已經有頁名（MainLayout 的 h1），這裡不再放一個一樣大的標題，只放這頁的說明與右側按鈕。
// title 仍保留給報讀器（h2，視覺隱藏）；description 與 subtitle 同義（以前 19 頁傳 description、元件只認 subtitle，說明全部沒顯示）
defineProps<{ title: string; subtitle?: string; description?: string }>()
</script>

<template>
  <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
    <div class="min-w-0">
      <h2 class="sr-only">{{ title }}</h2>
      <p v-if="description ?? subtitle" class="text-sm text-slate-600">{{ description ?? subtitle }}</p>
    </div>
    <div class="flex flex-wrap items-center gap-2"><slot /></div>
  </div>
</template>
