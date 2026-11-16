<script setup lang="ts">
// 病人辨識腕帶（列印）：條碼＝住院號（每次住院換新，舊腕帶掃了會被擋）。印姓名、性別、出生日期、病歷號、住院號、科別、入院日，
// 有過敏印紅色「過敏」。不印床號（轉床就錯了）。
// 第一條在住院中心報到時印；之後是重印（遺失、弄濕、讀不到），要寫原因、留稽核（scan.printWristband）
import { computed, ref, watch } from 'vue'
import { Printer } from 'lucide-vue-next'
import { UButton, UDialog, UInput } from '@/components/ui'
import Barcode39 from './Barcode39.vue'
import { scanApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { toRoc } from '@/utils/date'
import { genderLabel } from '@/utils/labels'
import { HOSPITAL } from '@/utils/hospital'

const props = defineProps<{ admissionId?: string }>()
const open = defineModel<boolean>({ default: false })
const { data: wb } = useQuery(async () => (open.value && props.admissionId ? scanApi.getWristband(props.admissionId) : undefined), [open, () => props.admissionId])
const view = computed(() => (wb.value?.admissionId === props.admissionId ? wb.value : undefined))
const reason = ref('')
watch(open, (o) => {
  if (o) {
    reason.value = ''
    printIt.fieldErrors.value = {}
  }
})
const reprint = computed(() => !!view.value?.printed)
const printIt = useAction(scanApi.printWristband, { success: (w) => (w.printed > 1 ? `已重印腕帶（第 ${w.printed} 條）` : '已列印腕帶') })
async function onPrint() {
  if (!props.admissionId) return
  if (await printIt.run(props.admissionId, reprint.value ? reason.value : undefined)) window.print()
}
</script>

<template>
  <UDialog v-model="open" :title="reprint ? '重印腕帶' : '列印腕帶'" size="md" @submit="onPrint">
    <div v-if="view" class="space-y-3">
      <!-- 腕帶本體：長條形，貼在手腕上 -->
      <div class="print-area mx-auto w-[250mm] max-w-full overflow-hidden rounded-xl border-2 border-slate-800 bg-white px-6 py-2 text-black">
        <div class="flex items-center gap-4">
          <Barcode39 :value="view.admitNo" :height="44" :module="1.2" />
          <div class="min-w-0 flex-1 leading-tight">
            <div class="flex flex-wrap items-baseline gap-x-3">
              <b class="text-lg">{{ view.patientName }}</b>
              <span class="text-sm">{{ genderLabel[view.gender as keyof typeof genderLabel] ?? view.gender }}・{{ toRoc(view.birthDate) }} 生</span>
            </div>
            <div class="tabular text-xs">病歷號 {{ view.chartNo }}・住院號 {{ view.admitNo }}・{{ view.deptName }}・{{ view.admittedAt.slice(0, 10) }} 入院</div>
            <div class="text-[10px] text-slate-600">{{ HOSPITAL.name }}</div>
          </div>
          <div v-if="view.allergies.length" class="shrink-0 rounded border-2 border-red-700 px-2 py-0.5 text-center text-sm font-bold text-red-700">過敏<div class="text-xs">{{ view.allergies.join('、') }}</div></div>
        </div>
      </div>
      <p class="text-xs text-slate-500">給藥前護理師掃這個條碼核對病人。條碼是這次住院的住院號：上次住院的舊腕帶掃了會被擋，請剪掉。</p>
      <template v-if="reprint">
        <p class="text-sm text-slate-600">已印過 {{ view.printed }} 條<template v-if="view.reprints.length">（上次重印 {{ view.reprints.at(-1)!.at.slice(5) }} {{ view.reprints.at(-1)!.byName }}：{{ view.reprints.at(-1)!.reason }}）</template>。重印要寫原因，並剪掉舊的。</p>
        <UInput v-model="reason" label="重印原因" required placeholder="例：腕帶弄濕無法掃描" :error="printIt.fieldErrors.value.reason" />
      </template>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="open = false">關閉</UButton>
      <UButton type="submit" :icon="Printer" :loading="printIt.pending.value">{{ reprint ? '重印' : '列印腕帶' }}</UButton>
    </template>
  </UDialog>
</template>
