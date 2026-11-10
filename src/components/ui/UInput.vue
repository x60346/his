<script setup lang="ts">
import { useId } from 'vue'
import UField from './UField.vue'

defineOptions({ inheritAttrs: false })

const model = defineModel<string | number | undefined>()
const props = defineProps<{ label?: string; required?: boolean; error?: string; hint?: string; type?: string }>()
const id = useId()

function onInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
  // type=number 時回傳數字；清空時回傳 undefined，避免出現 0 或 NaN
  model.value = props.type === 'number' ? (v === '' ? undefined : Number(v)) : v
}
</script>

<template>
  <UField :label="label" :required="required" :error="error" :hint="hint" :for-id="id">
    <input
      :id="id"
      v-bind="$attrs"
      :type="type ?? 'text'"
      :value="model ?? ''"
      :class="['form-control', error && 'form-control-error']"
      @input="onInput"
    />
  </UField>
</template>
