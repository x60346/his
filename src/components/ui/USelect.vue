<script setup lang="ts">
import { computed, useId } from 'vue'
import UField from './UField.vue'

defineOptions({ inheritAttrs: false })

/** disabled：列出來但不能選（例：已被占用的診間，標出被誰占用比直接藏起來清楚） */
export type SelectOption = { label: string; value: string | number; disabled?: boolean } | string

const model = defineModel<string | number | undefined>()
const props = defineProps<{ options: readonly SelectOption[]; label?: string; required?: boolean; error?: string; hint?: string; placeholder?: string }>()
const id = useId()

const normalized = computed(() => props.options.map((o) => (typeof o === 'string' ? { label: o, value: o, disabled: false } : o)))

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
      <option v-for="o in normalized" :key="o.value" :value="o.value" :disabled="o.disabled">{{ o.label }}</option>
    </select>
  </UField>
</template>
