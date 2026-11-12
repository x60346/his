<script setup lang="ts">
// 安全設定：閒置多久鎖定畫面（規則與服務層同一個 checkIdleMinutes）；調劑雙人核對（U24）。
import { computed, ref, watch } from 'vue'
import { UButton, UCard, UCheckbox, UInput } from '@/components/ui'
import { authApi, checkIdleMinutes, IDLE_LOCK_RANGE, IDLE_WARN_SEC, pharmacyApi, UNLOCK_MAX_FAILS } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data: current } = useQuery(() => authApi.idleLockMinutes())
const minutes = ref<number>()
watch(current, (v) => {
  if (minutes.value === undefined && v !== undefined) minutes.value = v
})
const problem = computed(() => checkIdleMinutes(minutes.value))
const dirty = computed(() => minutes.value !== current.value)
const save = useAction(authApi.saveIdleLockMinutes, { success: (m) => `已設定：閒置 ${m} 分鐘鎖定畫面` })

// 調劑雙人核對：勾了立即儲存（只有一個開關，不需要另外按儲存）
const { data: policy } = useQuery(() => pharmacyApi.dispensePolicy())
const savePolicy = useAction(pharmacyApi.saveDispensePolicy, { success: (p) => (p.twoPersonDispense ? '已開啟：核對與發藥須由不同藥師' : '已關閉：同一位藥師可以核對並發藥') })
</script>

<template>
  <div class="space-y-4">
  <UCard title="閒置鎖定" subtitle="離開座位時保護病人資料">
    <div class="max-w-md space-y-3 text-sm">
      <p class="text-slate-600">
        一段時間沒有操作（點擊、按鍵、捲動）就鎖定畫面，鎖定前 {{ IDLE_WARN_SEC }} 秒提醒。
        鎖定不是登出：同一人輸入密碼即可回到原畫面，未儲存的內容還在；連續輸錯 {{ UNLOCK_MAX_FAILS }} 次則自動登出。
      </p>
      <div class="flex items-end gap-2">
        <div class="w-40">
          <UInput v-model="minutes" type="number" :min="IDLE_LOCK_RANGE[0]" :max="IDLE_LOCK_RANGE[1]" label="閒置幾分鐘鎖定" :error="problem ?? save.fieldErrors.value.idleLockMin" :hint="`${IDLE_LOCK_RANGE[0]}–${IDLE_LOCK_RANGE[1]} 分鐘`" />
        </div>
        <UButton :disabled="!dirty || !!problem" :loading="save.pending.value" @click="save.run(minutes!)">儲存</UButton>
      </div>
      <p class="text-xs text-slate-500">展示時可設為 1 分鐘：30 秒後出現倒數，再 30 秒鎖定。</p>
    </div>
  </UCard>
  <UCard title="調劑雙人核對" subtitle="門診藥局的核對與發藥是否須由兩位藥師">
    <div class="max-w-xl space-y-2 text-sm">
      <UCheckbox :model-value="!!policy?.twoPersonDispense" :disabled="!policy || savePolicy.pending.value" label="核對與發藥須由不同藥師" @update:model-value="(v) => savePolicy.run(v)" />
      <p class="text-slate-600">開啟後，核對處方的藥師不能自己發藥，要由第二位藥師在發藥時再看一次（雙重核對）。</p>
      <p class="text-xs text-slate-500">預設關閉：只有一位藥師的診所開啟後會無法發藥。目前有 2 位藥師帳號（ph01、ph02）可以示範。</p>
    </div>
  </UCard>
  </div>
</template>
