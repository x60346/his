<script setup lang="ts">
// 主治：我的病人被病歷室修改編碼的——看修改前後與理由，已讀時可寫意見（病歷管理師看得到）。服務層 coding.ackCoding
import { computed, ref } from 'vue'
import { UBadge, UButton, UDialog, UInput, UQueryState } from '@/components/ui'
import { codingApi, type CodingItem } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data, loading } = useQuery(() => codingApi.myCodingChanges(), [])
const cur = ref<CodingItem>()
const open = computed({ get: () => !!cur.value, set: (x) => !x && (cur.value = undefined) })
const note = ref('')
const act = useAction(codingApi.ackCoding, { success: '已讀' })
async function submit() {
  if (cur.value && (await act.run(cur.value.admissionId, note.value))) cur.value = undefined
}
</script>

<template>
  <section class="space-y-2">
    <h2 class="font-semibold text-slate-700">編碼修改</h2>
    <UQueryState :loading="loading && !data" :ready="!!data?.length" empty-title="沒有被修改的編碼">
      <ul v-if="data" class="space-y-2 text-sm">
        <li v-for="x in data" :key="x.admissionId" class="rounded-md border border-slate-200 bg-white px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge :tone="x.coded?.ack ? 'gray' : 'yellow'">{{ x.coded?.ack ? '已讀' : '未讀' }}</UBadge>
            <b>{{ x.patientName }}</b><span class="text-xs text-slate-500">{{ x.admitNo }}・{{ x.dischargedAt.slice(0, 10) }} 出院</span>
            <UButton v-if="!x.coded?.ack" size="sm" class="ml-auto" @click="cur = x; note = ''">已讀</UButton>
          </div>
          <div class="text-xs text-slate-700">改為：{{ x.mainDiagnosis }}<template v-if="x.secondary.length">；次：{{ x.secondary.map((s) => s.icd).join('、') }}</template></div>
          <div class="text-xs text-slate-500">原本：{{ x.coded?.beforeText }}・理由：{{ x.coded?.reason }}（{{ x.coded?.byName }}）</div>
          <div class="text-xs text-slate-500">{{ x.drgExempt ? `不適用 DRG：${x.drgExempt}` : `DRG ${x.drg.code} ${x.drg.name}` }}</div>
          <div v-if="x.coded?.ack" class="text-xs text-slate-600">{{ x.coded.ack }}</div>
        </li>
      </ul>
    </UQueryState>
    <UDialog v-model="open" :title="`編碼修改已讀：${cur?.patientName ?? ''}`" size="sm" @submit="submit">
      <UInput v-model="note" label="意見（選填；有異議請寫，病歷管理師看得到）" />
      <template #footer>
        <UButton variant="secondary" @click="cur = undefined">取消</UButton>
        <UButton type="submit" :loading="act.pending.value">已讀</UButton>
      </template>
    </UDialog>
  </section>
</template>
