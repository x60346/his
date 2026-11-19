<script setup lang="ts">
// 門診發藥前逐項掃藥品條碼：每掃一次就問服務層（pharmacy.dispenseScanCheck），對了那一項打勾；掃到處方沒有的藥、拿錯規格大紅字擋下，
// 並記成「差點發錯」。全部打勾才能繼續（確認領藥人）。掃不了可以略過（選原因）——發藥紀錄標「未掃描」。真正發藥時服務層再核對一次
import { computed, nextTick, ref, watch } from 'vue'
import { CheckCircle2, Circle, ScanLine, XCircle } from 'lucide-vue-next'
import { UButton, UDialog, UInput, USelect } from '@/components/ui'
import { pharmacyApi, SCAN_SKIP_LABEL, type DispenseScanInput } from '@/services'
import type { ScanSkipReason } from '@/types'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ dispenseId?: string; pickupNo?: number; items: { drugName: string }[]; demoAssist?: boolean }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ done: [scan: DispenseScanInput] }>()
const code = ref('')
const codes = ref<string[]>([])
const hit = ref<Set<number>>(new Set())
const res = ref<{ ok: boolean; message: string }>()
const skipping = ref(false)
const skipReason = ref<ScanSkipReason | ''>('')
const skipNote = ref('')
const input = ref<InstanceType<typeof UInput>>()
const focus = async () => {
  await nextTick()
  ;((input.value?.$el as HTMLElement | undefined)?.querySelector('input') as HTMLInputElement | null)?.focus()
}
watch(open, (o) => {
  if (!o) return
  code.value = skipNote.value = skipReason.value = ''
  codes.value = []
  hit.value = new Set()
  res.value = undefined
  skipping.value = false
  focus()
})
const check = useAction(pharmacyApi.dispenseScanCheck)
async function scan() {
  const c = code.value.trim()
  if (!props.dispenseId || !c) return
  const r = await check.run(props.dispenseId, c)
  res.value = r ?? undefined
  if (r?.ok && r.idx !== undefined) {
    hit.value = new Set([...hit.value, r.idx])
    if (!codes.value.includes(c)) codes.value.push(c)
  }
  code.value = ''
  focus()
}
const allOk = computed(() => props.items.length > 0 && props.items.every((_, i) => hit.value.has(i)))
function proceed() {
  if (!allOk.value) return
  open.value = false
  emit('done', { codes: codes.value })
}
function proceedSkip() {
  if (!skipReason.value) return
  open.value = false
  emit('done', { skip: skipReason.value, note: skipNote.value })
}
const { data: demo } = useQuery(async () => (open.value && props.demoAssist && props.dispenseId ? pharmacyApi.dispenseScanDemo(props.dispenseId) : undefined), [open, () => props.dispenseId])
const demoPick = ref('')
watch(demoPick, async (k) => {
  if (!k) return
  const o = demo.value?.options[Number(k)]
  demoPick.value = ''
  if (!o) return
  code.value = o.code
  await scan()
})
const SKIPS: ScanSkipReason[] = ['barcode', 'scanner', 'emergency']
</script>

<template>
  <UDialog v-model="open" :title="`發藥前核對：逐項掃藥品條碼（領藥號 ${pickupNo ?? ''}）`" size="md">
    <div class="space-y-3 text-sm">
      <ul class="space-y-1">
        <li v-for="(it, i) in items" :key="i" class="flex items-center gap-2">
          <component :is="hit.has(i) ? CheckCircle2 : Circle" :class="['h-4 w-4', hit.has(i) ? 'text-emerald-600' : 'text-slate-300']" />{{ it.drugName }}
        </li>
      </ul>
      <template v-if="!skipping">
        <form @submit.prevent="scan">
          <UInput ref="input" v-model="code" label="掃描藥品條碼" placeholder="掃描或輸入條碼，按 Enter" autocomplete="off" />
          <p v-if="res" :class="['mt-1 flex items-start gap-1.5', res.ok ? 'text-emerald-700' : 'text-base font-bold text-red-700']" :role="res.ok ? 'status' : 'alert'">
            <component :is="res.ok ? CheckCircle2 : XCircle" class="mt-0.5 h-4 w-4 shrink-0" />{{ res.message }}
          </p>
        </form>
        <div v-if="demoAssist && demo?.options.length" class="rounded-md border border-dashed border-slate-300 px-3 py-2">
          <USelect v-model="demoPick" label="示範：模擬掃描（展示用）" placeholder="選擇要「掃」的條碼" :options="demo.options.map((o, i) => ({ value: String(i), label: o.label }))" />
        </div>
        <button type="button" class="text-xs text-slate-500 underline hover:text-slate-700" @click="skipping = true">掃描不了？略過掃描</button>
      </template>
      <template v-else>
        <p class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">略過掃描要靠人工核對：逐項再看一次藥名、規格、數量。發藥紀錄會標「未掃描」，藥局的掃描統計會列出來。</p>
        <USelect v-model="skipReason" label="略過原因" placeholder="請選擇" :options="SKIPS.map((r) => ({ value: r, label: SCAN_SKIP_LABEL[r] }))" />
        <UInput v-model="skipNote" label="說明（選填）" placeholder="例：條碼貼紙破損" />
        <button type="button" class="text-xs text-slate-500 underline hover:text-slate-700" @click="skipping = false">回到掃描</button>
      </template>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">取消</UButton>
      <UButton v-if="!skipping" variant="success" :icon="ScanLine" :disabled="!allOk" @click="proceed">確認，下一步（核對領藥人）</UButton>
      <UButton v-else variant="danger" :disabled="!skipReason" @click="proceedSkip">略過掃描，下一步</UButton>
    </template>
  </UDialog>
</template>
