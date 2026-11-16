<script setup lang="ts">
// 管制藥品專用處方箋預覽與列印（門診完成看診後、藥局核對時共用）
import { Printer } from 'lucide-vue-next'
import { UButton, UDialog, UQueryState } from '@/components/ui'
import { controlledApi } from '@/services'
import { useQuery } from '@/composables/useService'
import ControlledRxSheet from './ControlledRxSheet.vue'

const props = defineProps<{ encounterId?: string }>()
const open = defineModel<boolean>({ default: false })
const { data, loading } = useQuery(async () => (open.value && props.encounterId ? controlledApi.specialRxSheet(props.encounterId) : undefined), [open, () => props.encounterId])
const print = () => window.print()
</script>

<template>
  <UDialog v-model="open" title="管制藥品專用處方箋" size="lg">
    <UQueryState :loading="loading && !data" :ready="!!data" empty-title="找不到處方">
      <ControlledRxSheet v-if="data" :s="data" />
    </UQueryState>
    <template #footer>
      <UButton variant="secondary" @click="open = false">關閉</UButton>
      <UButton :icon="Printer" :disabled="!data" @click="print">列印</UButton>
    </template>
  </UDialog>
</template>
