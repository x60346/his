<script setup lang="ts">
// 表單欄位外框：標籤、必填星號、說明與錯誤訊息。輸入元件都包在這裡面，版面就會一致。
defineProps<{ label?: string; required?: boolean; error?: string; hint?: string; forId?: string }>()
</script>

<template>
  <div class="min-w-0">
    <label v-if="label" :for="forId" class="mb-1 block text-xs font-medium text-slate-600">
      {{ label }}<span v-if="required" class="ml-0.5 text-red-500">*</span>
    </label>
    <slot />
    <p v-if="error" class="mt-1 text-xs text-red-600">{{ error }}</p>
    <p v-else-if="hint" class="mt-1 text-xs text-slate-500">{{ hint }}</p>
  </div>
</template>
