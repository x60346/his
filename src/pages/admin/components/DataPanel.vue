<script setup lang="ts">
// 展示資料：重置、匯出、匯入。
// 匯入是「整個資料庫換掉」的危險操作：先讀檔、先驗證、再確認、最後才替換；任何一步失敗都不動現有資料。
import { computed, ref } from 'vue'
import { Download, RotateCcw, Upload } from 'lucide-vue-next'
import { UButton } from '@/components/ui'
import { adminApi, dbVersion, masterApi } from '@/services'
import { useAction } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'
import { useRouter } from 'vue-router'
import { toRoc } from '@/utils/date'

const ui = useUi()
const auth = useAuth()
const router = useRouter()
const seed = computed(() => (dbVersion.value, masterApi.seedInfo()))

async function reset() {
  const ok = await ui.confirm({ title: '重置展示資料', message: '所有資料將還原為「以今天為基準」的初始展示資料，目前的操作紀錄會被清除。', okText: '重置', danger: true })
  if (!ok) return
  await masterApi.resetDemoData()
  ui.toast.success('已重置為今天的展示資料')
}

const exporting = useAction(adminApi.exportData)
async function doExport() {
  const json = await exporting.run()
  if (!json) return
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `his-demo-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.json`
  a.click()
  URL.revokeObjectURL(url)
  ui.toast.success(`已匯出（${(json.length / 1024).toFixed(0)} KB）`)
}

const fileInput = ref<HTMLInputElement>()
const importing = useAction(adminApi.importData)
async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = '' // 同一個檔案可以再選一次
  if (!file) return
  const ok = await ui.confirm({
    title: '匯入展示資料',
    message: `將以「${file.name}」（${(file.size / 1024).toFixed(0)} KB）取代目前所有資料。\n建議先匯出目前資料備份。確定匯入？`,
    okText: '匯入',
    danger: true,
  })
  if (!ok) return
  const r = await importing.run(await file.text())
  if (!r) return
  ui.toast.success(`匯入完成，共 ${r.users} 個帳號`)
  // 匯入的資料裡沒有目前登入的帳號（或已停用）：登入狀態失效，回登入頁
  if (!r.sessionKept) {
    await auth.logout().catch(() => undefined)
    router.push({ name: 'login' })
  }
}
</script>

<template>
  <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
    <section class="rounded-md border border-slate-200 p-4">
      <h3 class="flex items-center gap-1.5 text-sm font-semibold text-slate-700"><RotateCcw class="h-4 w-4" />重置</h3>
      <p class="mt-1 text-sm text-slate-600">目前資料建立於 <b class="tabular">{{ toRoc(seed.seededAt) }}</b><span v-if="seed.stale" class="text-amber-700">（不是今天）</span>。</p>
      <p class="mt-1 text-xs text-slate-500">展示資料以「建立當天」為基準產生（今日掛號、住院天數…），隔天使用建議重置。</p>
      <UButton class="mt-3" variant="danger" @click="reset">重置為今天的展示資料</UButton>
    </section>

    <section class="rounded-md border border-slate-200 p-4">
      <h3 class="flex items-center gap-1.5 text-sm font-semibold text-slate-700"><Download class="h-4 w-4" />匯出</h3>
      <p class="mt-1 text-sm text-slate-600">下載目前所有資料（JSON），可在其他電腦匯入，重現同樣的展示情境。</p>
      <p class="mt-1 text-xs text-amber-700">展示系統的密碼為明文，匯出檔請勿外流。</p>
      <UButton class="mt-3" variant="secondary" :loading="exporting.pending.value" @click="doExport">下載匯出檔</UButton>
    </section>

    <section class="rounded-md border border-slate-200 p-4">
      <h3 class="flex items-center gap-1.5 text-sm font-semibold text-slate-700"><Upload class="h-4 w-4" />匯入</h3>
      <p class="mt-1 text-sm text-slate-600">以匯出檔取代目前所有資料。</p>
      <p class="mt-1 text-xs text-slate-500">會先檢查版本與資料表是否完整；只接受同一版本（第 {{ seed.schema }} 版）的匯出檔，驗證不過不會更動任何資料。</p>
      <input ref="fileInput" type="file" accept="application/json,.json" class="hidden" @change="onFile" />
      <UButton class="mt-3" variant="secondary" :loading="importing.pending.value" @click="fileInput?.click()">選擇檔案匯入</UButton>
    </section>
  </div>
</template>
