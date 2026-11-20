<script setup lang="ts">
// 手術視窗的「器械包」：流動護理師掃包號（已送到手術室或手術中），列出這台用了哪幾包、哪一鍋、生物指示劑；
// 召回那鍋的標紅。過期、召回、用過的、植入物要等生物指示劑陰性都由服務層擋（sterile.scanPack）；手術完成前至少要一包
import { computed, ref, watch } from 'vue'
import { UButton, UInput } from '@/components/ui'
import { sterileApi, type SurgeryView } from '@/services'
import { useAction } from '@/composables/useService'

const props = defineProps<{ surgery: SurgeryView; isNurse: boolean }>()
const s = computed(() => props.surgery)
const open = computed(() => props.isNurse && (s.value.status === 'sent' || s.value.status === 'in-progress'))
const packNo = ref('')
watch(() => props.surgery.id, () => (packNo.value = ''))
const scanAct = useAction(sterileApi.scanPack, { success: '已掃描' })
const unAct = useAction(sterileApi.unscanPack, { success: '已拿掉' })
async function scan() {
  if (await scanAct.run(s.value.id, packNo.value)) packNo.value = ''
}
</script>

<template>
  <div :class="['rounded-md border px-3 py-2 text-sm', s.packRecalled ? 'border-red-300 bg-red-50' : 'border-slate-200']">
    <div class="flex flex-wrap items-center gap-2">
      <b class="text-slate-700">器械包</b>
      <span v-if="s.implant" class="text-xs text-amber-800">會放植入物：要用生物指示劑陰性的包</span>
      <span v-if="!s.packRows.length" class="text-xs text-slate-500">還沒掃（手術完成前至少要一包）</span>
    </div>
    <p v-if="s.packRecalled" class="mt-1 text-xs font-semibold text-red-800">這台用到的器械包那一鍋生物指示劑陽性（已召回）：供應中心會通知主刀與感控。</p>
    <ul v-if="s.packRows.length" class="mt-1 space-y-0.5 text-xs">
      <li v-for="p in s.packRows" :key="p.id" class="flex flex-wrap items-center gap-2" :class="p.recalled ? 'font-medium text-red-800' : 'text-slate-700'">
        <span class="tabular">{{ p.no }}</span><span>{{ p.setLabel }}</span><span class="text-slate-500">{{ p.batchNo }}・{{ p.biText }}</span>
        <button v-if="open" type="button" class="ml-auto text-slate-500 underline" @click="unAct.run(s.id, p.id)">拿掉</button>
      </li>
    </ul>
    <form v-if="open" class="mt-2 flex items-start gap-2" @submit.prevent="scan">
      <UInput v-model="packNo" class="flex-1" placeholder="掃描或輸入包號（例：PK00012）" aria-label="器械包包號" :error="scanAct.fieldErrors.value.packNo" />
      <UButton type="submit" size="sm" :loading="scanAct.pending.value">掃描</UButton>
    </form>
  </div>
</template>
