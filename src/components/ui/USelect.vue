<script setup lang="ts">
import { computed, useId } from 'vue'
import UField from './UField.vue'

defineOptions({ inheritAttrs: false })

/**
 * disabled：列出來但不能選（例：已被占用的診間，標出被誰占用比直接藏起來清楚）
 * group：分組標題（例：「我的組套」「內科組套」）；有任何選項帶 group 就依序分組顯示
 */
export type SelectOption = { label: string; value: string | number; disabled?: boolean; group?: string } | string

const model = defineModel<string | number | undefined>()
const props = defineProps<{ options: readonly SelectOption[]; label?: string; required?: boolean; error?: string; hint?: string; placeholder?: string }>()
const id = useId()

const normalized = computed(() => props.options.map((o) => (typeof o === 'string' ? { label: o, value: o, disabled: false, group: undefined } : o)))
/** 依出現順序分組；沒有分組時只有一組（label 為空，不畫 optgroup） */
const groups = computed(() => {
  const out: { label: string; items: typeof normalized.value }[] = []
  for (const o of normalized.value) {
    const g = o.group ?? ''
    const last = out[out.length - 1]
    if (last && last.label === g) last.items.push(o)
    else out.push({ label: g, items: [o] })
  }
  return out
})

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
      <template v-for="g in groups" :key="g.label">
        <optgroup v-if="g.label" :label="g.label">
          <option v-for="o in g.items" :key="o.value" :value="o.value" :disabled="o.disabled">{{ o.label }}</option>
        </optgroup>
        <template v-else>
          <option v-for="o in g.items" :key="o.value" :value="o.value" :disabled="o.disabled">{{ o.label }}</option>
        </template>
      </template>
    </select>
  </UField>
</template>
