<script setup lang="ts">
import { useId } from 'vue'
import UField from './UField.vue'

defineOptions({ inheritAttrs: false })

const model = defineModel<string>({ default: '' })
defineProps<{ label?: string; required?: boolean; error?: string; hint?: string; rows?: number }>()
const id = useId()
</script>

<template>
  <UField :label="label" :required="required" :error="error" :hint="hint" :for-id="id">
    <textarea :id="id" v-model="model" v-bind="$attrs" :rows="rows ?? 3" :class="['form-control resize-y', error && 'form-control-error']" />
  </UField>
</template>
