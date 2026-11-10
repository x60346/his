<script setup lang="ts">
import { ShieldAlert } from 'lucide-vue-next'
import { UButton, UCard, UEmpty } from '@/components/ui'
</script>

<template>
  <UCard>
    <UEmpty :icon="ShieldAlert" title="您的角色沒有此頁面的權限" :description="`欲前往：${$route.query.from ?? ''}`">
      <UButton variant="secondary" @click="$router.push('/')">回首頁</UButton>
    </UEmpty>
  </UCard>
</template>
