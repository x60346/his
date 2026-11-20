<script setup lang="ts">
// 手術視窗的「植入物」：流動護理師登記用了哪一批、幾個、植入部位（已送到手術室或手術中）；
// 選單只列這個術式會用到、可用的批（先到期的在前）。過期、召回、不夠、自費沒同意都由服務層擋（implant.useImplant）
import { computed, reactive, watch } from 'vue'
import { UButton, UInput, USelect } from '@/components/ui'
import { implantApi, type SurgeryView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ surgery: SurgeryView; isNurse: boolean }>()
const s = computed(() => props.surgery)
const open = computed(() => props.isNurse && (s.value.status === 'sent' || s.value.status === 'in-progress'))
const { data: opt } = useQuery(async () => (open.value ? implantApi.implantOptions(props.surgery.id) : undefined), [() => props.surgery.id, open, () => s.value.implantRows.length])
const f = reactive({ lotId: '' as string | number | undefined, qty: 1 as number | undefined, site: '' })
watch(() => props.surgery.id, () => Object.assign(f, { lotId: '', qty: 1, site: '' }))
const useAct = useAction(implantApi.useImplant, { success: '已登記植入物' })
const rmAct = useAction(implantApi.removeImplant, { success: '已拿掉' })
async function add() {
  if (await useAct.run(s.value.id, { lotId: String(f.lotId ?? ''), qty: Number(f.qty), site: f.site })) Object.assign(f, { lotId: '', qty: 1 })
}
</script>

<template>
  <div :class="['rounded-md border px-3 py-2 text-sm', s.implantRecalled ? 'border-red-300 bg-red-50' : s.implantMissing ? 'border-amber-300 bg-amber-50' : 'border-slate-200']">
    <div class="flex flex-wrap items-center gap-2">
      <b class="text-slate-700">植入物</b>
      <span v-if="s.implantMissing" class="text-xs text-amber-800">還沒登記（完成手術前至少一筆）</span>
      <span v-if="s.selfPayText" class="text-xs text-slate-600">{{ s.selfPayText }}</span>
      <span v-else-if="s.selfPayOption" class="text-xs text-slate-500">自費品項要病房先記錄病人同意</span>
    </div>
    <p v-if="s.implantRecalled" class="mt-1 text-xs font-semibold text-red-800">這台用的植入物有一批被廠商召回：供應中心會通知主刀。</p>
    <ul v-if="s.implantRows.length" class="mt-1 space-y-0.5 text-xs">
      <li v-for="r in s.implantRows" :key="r.id" class="flex flex-wrap items-center gap-2" :class="r.recalled ? 'font-medium text-red-800' : 'text-slate-700'">
        <span>{{ r.text }}</span><span v-if="r.selfPay" class="text-amber-700">自費</span>
        <button v-if="open" type="button" class="ml-auto text-slate-500 underline" @click="rmAct.run(s.id, r.id)">拿掉</button>
      </li>
    </ul>
    <form v-if="open && opt" class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_5rem_10rem_auto]" @submit.prevent="add">
      <USelect v-model="f.lotId" aria-label="植入物與批號" placeholder="選植入物與批號" :options="opt.options.map((o) => ({ label: `${o.label}${o.selfPay ? '（自費）' : ''}`, value: o.lotId }))" :error="useAct.fieldErrors.value.lotId" />
      <UInput v-model="f.qty" type="number" aria-label="數量" :error="useAct.fieldErrors.value.qty" />
      <UInput v-model="f.site" aria-label="植入部位" placeholder="植入部位" :error="useAct.fieldErrors.value.site" />
      <UButton type="submit" size="sm" :loading="useAct.pending.value">登記</UButton>
    </form>
  </div>
</template>
