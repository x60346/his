<script setup lang="ts">
// 安全設定：閒置多久鎖定畫面（規則與服務層同一個 checkIdleMinutes）；密碼期限與歷史（checkPasswordPolicy）；調劑雙人核對（U24）。
import { computed, reactive, ref, watch } from 'vue'
import { UButton, UCard, UCheckbox, UInput } from '@/components/ui'
import { authApi, checkIdleMinutes, checkPasswordPolicy, IDLE_LOCK_RANGE, IDLE_WARN_SEC, PASSWORD_GRACE_MAX, PASSWORD_HISTORY_MAX, PASSWORD_MAX_DAYS_RANGE, PASSWORD_WARN_DAYS, pharmacyApi, riskApi, scanApi, UNLOCK_MAX_FAILS } from '@/services'
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
const pw = ref<{ maxDays?: number; history?: number; graceDays?: number }>({})
// 只帶入一次（用旗標，不看欄位是否空白：清空密碼期限再改其他欄位時，別的存檔不能把整張表單蓋回去）
let pwLoaded = false
watch(pwPolicy, (v) => {
  if (v && !pwLoaded) { pw.value = { ...v }; pwLoaded = true }
})
const pwProblems = computed(() => checkPasswordPolicy(pw.value))
const pwDirty = computed(() => !!pwPolicy.value && (pw.value.maxDays !== pwPolicy.value.maxDays || pw.value.history !== pwPolicy.value.history || pw.value.graceDays !== pwPolicy.value.graceDays))
const savePw = useAction(authApi.savePasswordPolicy, {
  success: (r) => `已設定：${r.maxDays ? `密碼 ${r.maxDays} 天到期` : '密碼不限期'}、不可重複最近 ${Math.max(1, r.history)} 次、${r.graceDays ? `過期 ${r.graceDays} 天後鎖帳號` : '過期不鎖帳號'}${r.expiredUsers ? `；${r.expiredUsers} 個帳號已過期，登入後須先變更` : ''}${r.lockedUsers ? `；${r.lockedUsers} 個帳號已鎖定，要重設密碼` : ''}`,
})

// 調劑雙人核對：勾了立即儲存（只有一個開關，不需要另外按儲存）
const { data: policy } = useQuery(() => pharmacyApi.dispensePolicy())
const savePolicy = useAction(pharmacyApi.saveDispensePolicy, { success: (p) => (p.twoPersonDispense ? '已開啟：核對與發藥須由不同藥師' : '已關閉：同一位藥師可以核對並發藥') })

// 風險評估切點（Morse 越高越危險、Braden 越低越危險）
const { data: riskSet } = useQuery(() => riskApi.getRiskSettings())
const rk = reactive({ fallHigh: 45, fallModerate: 25, pressureHigh: 16, pressureModerate: 18 })
// 只在第一次讀到時帶入：之後每次存檔（含別的開關、解鎖）都會重新查詢，不能蓋掉正在改的數字
let rkLoaded = false
watch(riskSet, (s) => {
  if (s && !rkLoaded) { Object.assign(rk, s); rkLoaded = true }
}, { immediate: true })
const saveRisk = useAction(riskApi.saveRiskSettings, { success: (s) => `已儲存：Morse ≥${s.fallHigh} 高風險、≥${s.fallModerate} 中度；Braden ≤${s.pressureHigh} 高風險、≤${s.pressureModerate} 中度` })

// 給藥條碼核對：勾了立即儲存
const { data: scanPol } = useQuery(() => scanApi.scanPolicy())
const saveScan = useAction(scanApi.saveScanPolicy, { success: (p) => (p.requireScan ? '已開啟：給藥要掃描腕帶與藥品條碼' : '已關閉：給藥不必掃描') })
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
        密碼從本人設定那天起算，到期前 {{ PASSWORD_WARN_DAYS }} 天在右上角提醒；過期後登入要先設定新密碼才能做其他事；過期超過「寬限天數」就<b>鎖帳號</b>，要管理員重設密碼。
        改密碼時不可與最近幾次用過的相同（含目前這組；管理員重設前的舊密碼也算）。
      </p>
      <div class="flex flex-wrap items-end gap-2">
        <div class="w-40">
          <UInput v-model="pw.maxDays" type="number" min="0" :max="PASSWORD_MAX_DAYS_RANGE[1]" label="密碼幾天到期" :hint="`0＝不限；${PASSWORD_MAX_DAYS_RANGE[0]}–${PASSWORD_MAX_DAYS_RANGE[1]} 天`" :error="pwProblems.maxDays ?? savePw.fieldErrors.value.maxDays" />
        </div>
        <div class="w-40">
          <UInput v-model="pw.history" type="number" min="0" :max="PASSWORD_HISTORY_MAX" label="不可重複最近幾次" :hint="`0–${PASSWORD_HISTORY_MAX}（0、1＝只擋和目前相同）`" :error="pwProblems.history ?? savePw.fieldErrors.value.history" />
        </div>
        <div class="w-40">
          <UInput v-model="pw.graceDays" type="number" min="0" :max="PASSWORD_GRACE_MAX" label="過期幾天後鎖帳號" :hint="`0＝不鎖；最多 ${PASSWORD_GRACE_MAX} 天`" :error="pwProblems.graceDays ?? savePw.fieldErrors.value.graceDays" />
        </div>
        <UButton :disabled="!pwDirty || !!pwProblems.maxDays || !!pwProblems.history || !!pwProblems.graceDays" :loading="savePw.pending.value" @click="savePw.run({ maxDays: pw.maxDays!, history: pw.history!, graceDays: pw.graceDays! })">儲存</UButton>
      </div>
      <p class="text-xs text-slate-500">鎖定的帳號在「帳號」分頁標「已鎖定」，按「重設密碼」就解鎖（本人登入後要先改）。沒有其他可用的管理員時，管理員自己不鎖、只要求改密碼。</p>
      <p class="text-xs text-slate-500">展示：nurse02 的密碼是 80 天前設定的（還剩 10 天，右上角會提醒）；把期限改成 60 天，nurse02 登入就要先改密碼。clerk03 的密碼 130 天前設定（過期 40 天），已鎖定。</p>
    </div>
  </UCard>
  <UCard title="調劑雙人核對" subtitle="門診藥局的核對與發藥是否須由兩位藥師">
    <div class="max-w-xl space-y-2 text-sm">
      <UCheckbox :model-value="!!policy?.twoPersonDispense" :disabled="!policy || savePolicy.pending.value" label="核對與發藥須由不同藥師" @update:model-value="(v) => savePolicy.run(v)" />
      <p class="text-slate-600">開啟後，核對處方的藥師不能自己發藥，要由第二位藥師在發藥時再看一次（雙重核對）。</p>
      <p class="text-xs text-slate-500">預設關閉：只有一位藥師的診所開啟後會無法發藥。目前有 2 位藥師帳號（ph01、ph02）可以示範。</p>
    </div>
  </UCard>
  <UCard title="跌倒、壓傷風險評估切點" subtitle="護理站風險評估的等級判斷（之後的評估用新切點，舊紀錄不變）">
    <div class="max-w-2xl space-y-2 text-sm">
      <div class="flex flex-wrap items-end gap-3">
        <div class="w-40"><UInput v-model="rk.fallHigh" type="number" label="Morse 高風險 ≥" :error="saveRisk.fieldErrors.value.fallHigh" /></div>
        <div class="w-40"><UInput v-model="rk.fallModerate" type="number" label="Morse 中度 ≥" :error="saveRisk.fieldErrors.value.fallModerate" /></div>
        <div class="w-40"><UInput v-model="rk.pressureHigh" type="number" label="Braden 高風險 ≤" :error="saveRisk.fieldErrors.value.pressureHigh" /></div>
        <div class="w-40"><UInput v-model="rk.pressureModerate" type="number" label="Braden 中度 ≤" :error="saveRisk.fieldErrors.value.pressureModerate" /></div>
        <UButton :loading="saveRisk.pending.value" @click="saveRisk.run({ fallHigh: Number(rk.fallHigh), fallModerate: Number(rk.fallModerate), pressureHigh: Number(rk.pressureHigh), pressureModerate: Number(rk.pressureModerate) })">儲存</UButton>
      </div>
      <p class="text-xs text-slate-500">預設 Morse ≥45 高風險、≥25 中度（0–125 分，越高越危險）；Braden ≤16 高風險、≤18 中度（6–23 分，越低越危險）。各醫院切點不同，依院內規範調整。高風險每 24 小時重評，其他每 7 天。</p>
    </div>
  </UCard>
  <UCard title="給藥條碼核對" subtitle="住院給藥前掃病人腕帶與藥品條碼">
    <div class="max-w-xl space-y-2 text-sm">
      <UCheckbox :model-value="!!scanPol?.requireScan" :disabled="!scanPol || saveScan.pending.value" label="給藥需掃描條碼（腕帶＋藥品）" @update:model-value="(v) => saveScan.run({ requireScan: v, demoAssist: !!scanPol?.demoAssist })" />
      <p class="text-slate-600">排程、PRN、臨時給藥都要先掃腕帶（住院號）再掃藥品（健保碼），病人或藥不對當場擋下並記錄。掃不了可以選原因略過，護理站「給藥掃描」看得到略過的比例。</p>
      <p class="text-xs text-slate-500">預設開啟。沒有掃描器的醫院可以關閉（給藥就和以前一樣，不必掃）。</p>
      <UCheckbox :model-value="!!scanPol?.demoAssist" :disabled="!scanPol || saveScan.pending.value" label="顯示「示範：模擬掃描」選單" @update:model-value="(v) => saveScan.run({ requireScan: !!scanPol?.requireScan, demoAssist: v })" />
      <p class="text-xs text-slate-500">展示時沒有掃描槍，掃描框下方可以選「本人腕帶、別床病人的腕帶、正確的藥、拿錯的藥」當作掃了它。正式使用請關閉。</p>
    </div>
  </UCard>
  </div>
</template>
