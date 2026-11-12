<script setup lang="ts">
// 安全設定：閒置多久鎖定畫面（規則與服務層同一個 checkIdleMinutes）；密碼期限與歷史（checkPasswordPolicy）；調劑雙人核對（U24）。
import { computed, ref, watch } from 'vue'
import { UButton, UCard, UCheckbox, UInput } from '@/components/ui'
import { authApi, checkIdleMinutes, checkPasswordPolicy, IDLE_LOCK_RANGE, IDLE_WARN_SEC, PASSWORD_HISTORY_MAX, PASSWORD_MAX_DAYS_RANGE, PASSWORD_WARN_DAYS, pharmacyApi, UNLOCK_MAX_FAILS } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data: current } = useQuery(() => authApi.idleLockMinutes())
const minutes = ref<number>()
watch(current, (v) => {
  if (minutes.value === undefined && v !== undefined) minutes.value = v
})
const problem = computed(() => checkIdleMinutes(minutes.value))
const dirty = computed(() => minutes.value !== current.value)
const save = useAction(authApi.saveIdleLockMinutes, { success: (m) => `已設定：閒置 ${m} 分鐘鎖定畫面` })

// 密碼原則：期限（0＝不限）與不可重複最近幾次
const { data: pwPolicy } = useQuery(() => authApi.passwordPolicy())
const pw = ref<{ maxDays?: number; history?: number }>({})
watch(pwPolicy, (v) => {
  if (v && pw.value.maxDays === undefined) pw.value = { ...v }
})
const pwProblems = computed(() => checkPasswordPolicy(pw.value))
const pwDirty = computed(() => !!pwPolicy.value && (pw.value.maxDays !== pwPolicy.value.maxDays || pw.value.history !== pwPolicy.value.history))
const savePw = useAction(authApi.savePasswordPolicy, {
  success: (r) => `已設定：${r.maxDays ? `密碼 ${r.maxDays} 天到期` : '密碼不限期'}、不可重複最近 ${Math.max(1, r.history)} 次${r.expiredUsers ? `；${r.expiredUsers} 個帳號已過期，登入後須先變更` : ''}`,
})

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
  <UCard title="密碼期限" subtitle="定期更換、不可重複使用">
    <div class="max-w-xl space-y-3 text-sm">
      <p class="text-slate-600">
        密碼從本人設定那天起算，到期前 {{ PASSWORD_WARN_DAYS }} 天在右上角提醒；過期<b>不鎖帳號</b>，登入後先設定新密碼才能做其他事。
        改密碼時不可與最近幾次用過的相同（含目前這組；管理員重設前的舊密碼也算）。
      </p>
      <div class="flex flex-wrap items-end gap-2">
        <div class="w-40">
          <UInput v-model="pw.maxDays" type="number" min="0" :max="PASSWORD_MAX_DAYS_RANGE[1]" label="密碼幾天到期" :hint="`0＝不限；${PASSWORD_MAX_DAYS_RANGE[0]}–${PASSWORD_MAX_DAYS_RANGE[1]} 天`" :error="pwProblems.maxDays ?? savePw.fieldErrors.value.maxDays" />
        </div>
        <div class="w-40">
          <UInput v-model="pw.history" type="number" min="0" :max="PASSWORD_HISTORY_MAX" label="不可重複最近幾次" :hint="`0–${PASSWORD_HISTORY_MAX}（0、1＝只擋和目前相同）`" :error="pwProblems.history ?? savePw.fieldErrors.value.history" />
        </div>
        <UButton :disabled="!pwDirty || !!pwProblems.maxDays || !!pwProblems.history" :loading="savePw.pending.value" @click="savePw.run({ maxDays: pw.maxDays!, history: pw.history! })">儲存</UButton>
      </div>
      <p class="text-xs text-slate-500">展示：nurse02 的密碼是 80 天前設定的（還剩 10 天，右上角會提醒）；把期限改成 60 天，nurse02 登入就要先改密碼。</p>
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
