<script setup lang="ts">
// 病人身上的植入物：本院手術登記的（品名、廠商、批號、UDI、植入日、部位、MRI 相容性、是否被召回）＋外院的；
// 登記外院植入物（醫師、護理師）；列印病人植入物卡（每次列印記錄）。MRI 等級、要不要印卡都由服務層算（implant.ts）
import { computed, reactive, ref } from 'vue'
import { Plus, Printer } from 'lucide-vue-next'
import { UBadge, UButton, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import { implantApi, type ImplantCard } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ patientId: string }>()
const { data: v, loading } = useQuery(() => implantApi.patientImplants(props.patientId), [() => props.patientId])
const MRI_TONE = { safe: 'green', conditional: 'yellow', unsafe: 'red' } as const

const addOpen = ref(false)
const f = reactive({ name: '', mri: '' as string | number | undefined, implantedOn: '', hospital: '', note: '' })
function openAdd() {
  Object.assign(f, { name: '', mri: '', implantedOn: '', hospital: '', note: '' })
  addAct.fieldErrors.value = {}
  addOpen.value = true
}
const addAct = useAction(implantApi.addExternalImplant, { success: '已登記外院植入物' })
async function submitAdd() {
  if (await addAct.run(props.patientId, { name: f.name, mri: String(f.mri ?? '') as 'safe' | 'conditional' | 'unsafe', ...(f.implantedOn ? { implantedOn: f.implantedOn } : {}), hospital: f.hospital, note: f.note })) addOpen.value = false
}

const card = ref<ImplantCard>()
const cardOpen = computed({ get: () => !!card.value, set: (x) => !x && (card.value = undefined) })
const printAct = useAction(implantApi.printImplantCard)
async function openCard() {
  const c = await printAct.run(props.patientId)
  if (c) card.value = c
}
const doPrint = () => window.print()
const MRI_TEXT = { safe: 'MRI 安全', conditional: 'MRI 有條件', unsafe: 'MRI 不安全' } as const
</script>

<template>
  <UQueryState :loading="loading && !v" :ready="!!v">
    <div v-if="v" class="space-y-3 p-4 text-sm">
      <div class="flex flex-wrap items-center gap-2">
        <UBadge v-if="v.mri" :tone="MRI_TONE[v.mri]">{{ v.mriLabel }}</UBadge>
        <span v-if="v.cardDue" class="text-xs font-medium text-amber-800">植入物卡還沒印（最近一次植入之後）</span>
        <span v-else-if="v.prints.length" class="text-xs text-slate-500">植入物卡：{{ v.prints[0].at.slice(0, 16) }} {{ v.prints[0].byName }} 印過（共 {{ v.prints.length }} 次）</span>
        <span class="ml-auto flex gap-2">
          <UButton v-if="v.canEdit" size="sm" variant="secondary" :icon="Plus" @click="openAdd">登記外院植入物</UButton>
          <UButton v-if="v.rows.length" size="sm" :icon="Printer" :loading="printAct.pending.value" @click="openCard">列印植入物卡</UButton>
        </span>
      </div>
      <p v-if="!v.rows.length" class="text-slate-400">沒有植入物紀錄</p>
      <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
        <li v-for="(r, i) in v.rows" :key="i" class="space-y-0.5 px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <b>{{ r.name }}</b>
            <UBadge v-if="r.mri" :tone="MRI_TONE[r.mri]">{{ r.mriLabel }}</UBadge>
            <UBadge v-if="r.recalled" tone="red">廠商召回</UBadge>
            <UBadge v-if="r.source === 'external'" tone="gray">外院</UBadge>
            <span class="tabular ml-auto text-xs text-slate-500">{{ r.date ?? '日期不詳' }}</span>
          </div>
          <div class="text-xs text-slate-600">
            <template v-if="r.source === 'here'">{{ r.vendor }}・批號 {{ r.lot }}<template v-if="r.qty && r.qty > 1"> × {{ r.qty }}</template>・{{ r.site }}・{{ r.surgeryNo }}<div v-if="r.udi" class="tabular text-slate-400">UDI {{ r.udi }}</div></template>
            <template v-else>{{ r.hospital ?? '外院' }}</template>
          </div>
        </li>
      </ul>
    </div>
    <UDialog v-model="addOpen" title="登記外院植入物" size="sm" @submit="submitAdd">
      <div class="space-y-3 text-sm">
        <UInput v-model="f.name" label="植入物" placeholder="例：心律調節器、人工髖關節" :error="addAct.fieldErrors.value.name" />
        <USelect v-model="f.mri" label="MRI 相容性" placeholder="選擇" :options="[{ label: 'MRI 安全', value: 'safe' }, { label: 'MRI 有條件', value: 'conditional' }, { label: 'MRI 不安全（不確定也選這個）', value: 'unsafe' }]" :error="addAct.fieldErrors.value.mri" />
        <div class="grid grid-cols-2 gap-2">
          <UInput v-model="f.implantedOn" type="date" label="植入日期（選填）" :error="addAct.fieldErrors.value.implantedOn" />
          <UInput v-model="f.hospital" label="醫院（選填）" />
        </div>
        <UInput v-model="f.note" label="備註（選填）" placeholder="例：病人持外院植入物卡" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="addOpen = false">取消</UButton>
        <UButton type="submit" :loading="addAct.pending.value">登記</UButton>
      </template>
    </UDialog>
    <UDialog v-model="cardOpen" title="病人植入物卡" size="md">
      <div v-if="card" class="print-area mx-auto max-w-md rounded-lg border-2 border-slate-700 p-4 text-sm text-slate-900">
        <div class="flex items-baseline justify-between border-b border-slate-400 pb-1">
          <b class="text-base">植入物卡</b><span class="text-xs">{{ card.hospital }}</span>
        </div>
        <div class="mt-1 text-xs">姓名 <b>{{ card.patientName }}</b>　病歷號 {{ card.chartNo }}　生日 {{ card.birthDate }}</div>
        <table class="mt-2 w-full text-xs">
          <thead><tr class="border-b border-slate-400 text-left"><th class="py-0.5">植入物</th><th>植入日</th><th>MRI</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in card.rows" :key="i" class="border-b border-slate-200 align-top">
              <td class="py-0.5">{{ r.name }}<div class="text-[10px] text-slate-600">{{ r.source === 'here' ? `${r.vendor}・批號 ${r.lot}・${r.site}` : (r.hospital ?? '外院') }}<template v-if="r.udi"><br />UDI {{ r.udi }}</template></div></td>
              <td class="tabular">{{ r.date ?? '—' }}</td>
              <td>{{ r.mri ? MRI_TEXT[r.mri] : '—' }}</td>
            </tr>
          </tbody>
        </table>
        <p class="mt-2 text-[10px] text-slate-600">做 MRI、手術或到其他醫院就醫時請出示這張卡。列印 {{ card.printedAt.slice(0, 16) }}</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="card = undefined">關閉</UButton>
        <UButton :icon="Printer" @click="doPrint">列印</UButton>
      </template>
    </UDialog>
  </UQueryState>
</template>
