<script setup lang="ts">
import { computed, useId } from 'vue'
import UField from './UField.vue'

defineOptions({ inheritAttrs: false })

export type SelectOption = { label: string; value: string | number } | string

const model = defineModel<string | number | undefined>()
const props = defineProps<{ options: readonly SelectOption[]; label?: string; required?: boolean; error?: string; hint?: string; placeholder?: string }>()
const id = useId()

const normalized = computed(() => props.options.map((o) => (typeof o === 'string' ? { label: o, value: o } : o)))

function onChange(e: Event) {
  const raw = (e.target as HTMLSelectElement).value
  // 還原成原本的型別（數字選項回傳數字）
  const found = normalized.value.find((o) => String(o.value) === raw)
  model.value = found ? found.value : undefined
}
</script>

<template>
  <UField :label="label" :required="required" :error="error" :hint="hint" :for-id="id">
    <select :id="id" v-bind="$attrs" :value="model ?? ''" :class="['form-control pr-8', error && 'form-control-error']" @change="onChange">
      <option v-if="placeholder !== undefined" value="">{{ placeholder }}</option>
      <option v-for="o in normalized" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
  </UField>
</template>
