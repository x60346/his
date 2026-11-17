<script setup lang="ts">
// 加護病房（權限「加護病房主治」，示範 dr03）：轉入申請待同意（同意並選床＝直接轉床；不選床＝先候床；不同意寫原因）、
// 候床中的有床再排、最近處理過的；下面是床邊看板（點一床到那位病人的住院醫囑）
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { UBadge, UButton, UCard, UDialog, UPageHeader, UQueryState, USelect, UTextarea } from '@/components/ui'
import IcuBoardPanel from '@/pages/nursing/components/IcuBoardPanel.vue'
import { icuMoveApi, type IcuRequestView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const router = useRouter()
const { data, loading, reload } = useQuery(() => icuMoveApi.listIcuWork())
const bedOpts = computed(() => (data.value?.emptyBeds ?? []).map((b) => ({ label: b.bedNo, value: b.id })))
const statusText: Record<IcuRequestView['status'], string> = { pending: '待同意', accepted: '候床中', declined: '不同意', cancelled: '已取消', placed: '已轉入' }

const deciding = ref<IcuRequestView>()
const decideOpen = computed({ get: () => !!deciding.value, set: (x) => !x && (deciding.value = undefined) })
const d = reactive({ accept: true, bedId: '' as string | number, note: '' })
function openDecide(r: IcuRequestView, accept: boolean) {
  Object.assign(d, { accept, bedId: accept ? (bedOpts.value[0]?.value ?? '') : '', note: '' })
  decideAct.fieldErrors.value = {}
  deciding.value = r
}
const decideAct = useAction(icuMoveApi.decideIcuRequest, { success: (r) => (r.status === 'placed' ? `已轉入 ${r.bedNo}` : r.status === 'accepted' ? '已同意，候床中' : '已回覆不同意') })
async function submitDecide() {
  if (deciding.value && (await decideAct.run(deciding.value.id, { accept: d.accept, note: d.note, ...(d.accept && d.bedId ? { bedId: String(d.bedId) } : {}) }))) {
    deciding.value = undefined
    reload()
    board.value++ // 看板也重新查
  }
}
const board = ref(0)
const placing = ref<IcuRequestView>()
const placeOpen = computed({ get: () => !!placing.value, set: (x) => !x && (placing.value = undefined) })
const placeBed = ref<string | number>('')
const placeAct = useAction(icuMoveApi.placeIcuRequest, { success: (r) => `已轉入 ${r.bedNo}` })
async function submitPlace() {
  if (placing.value && (await placeAct.run(placing.value.id, String(placeBed.value)))) {
    placing.value = undefined
    reload()
    board.value++
  }
}
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="加護病房" description="轉入申請：同意並選床（直接轉入）、同意候床、或不同意；下面是床邊看板" />
    <UQueryState :loading="loading && !data" :ready="!!data">
      <div v-if="data" class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <UCard :padded="false" class="self-start">
          <div class="border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">待同意 {{ data.pending.length }}<span class="ml-2 text-xs font-normal text-slate-500">空床 {{ data.emptyBeds.length }}</span></div>
          <p v-if="!data.pending.length" class="px-4 py-4 text-center text-sm text-slate-400">沒有待同意的申請</p>
          <div v-for="r in data.pending" :key="r.id" class="border-b border-slate-100 px-4 py-3 text-sm last:border-b-0">
            <div class="flex flex-wrap items-center gap-2"><UBadge tone="red">{{ r.categoryLabel }}</UBadge><b>{{ r.patientName }}</b><span class="text-xs text-slate-500">{{ r.ward }} {{ r.bedNo }}・{{ r.deptName }}</span></div>
            <div class="mt-0.5 text-slate-700">{{ r.reason }}</div>
            <div class="text-xs text-slate-500">{{ r.diagnosis }}・{{ r.requestedAt.slice(5).replace('-', '/') }} {{ r.requestedByName }}申請</div>
            <div v-if="data.canDecide" class="mt-2 flex gap-2">
              <UButton size="sm" @click="openDecide(r, true)">同意</UButton>
              <UButton size="sm" variant="secondary" @click="openDecide(r, false)">不同意</UButton>
            </div>
          </div>
          <template v-if="data.waiting.length">
            <div class="border-y border-slate-100 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700">候床中 {{ data.waiting.length }}</div>
            <div v-for="r in data.waiting" :key="r.id" class="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2 text-sm last:border-b-0">
              <UBadge tone="yellow">{{ r.categoryLabel }}</UBadge><b>{{ r.patientName }}</b><span class="text-xs text-slate-500">{{ r.ward }} {{ r.bedNo }}・{{ r.decidedAt?.slice(5).replace('-', '/') }} 同意</span>
              <UButton v-if="data.canDecide && data.emptyBeds.length" class="ml-auto" size="sm" variant="secondary" @click="placing = r; placeBed = bedOpts[0]?.value ?? ''; placeAct.fieldErrors.value = {}">排床</UButton>
            </div>
          </template>
          <details v-if="data.recent.length" class="px-4 py-2 text-xs text-slate-600">
            <summary class="cursor-pointer">最近 7 天處理過 {{ data.recent.length }} 筆</summary>
            <div v-for="r in data.recent" :key="r.id" class="py-0.5">{{ (r.placedAt ?? r.decidedAt ?? '').slice(5, 16).replace('-', '/') }} {{ r.patientName }}・{{ r.categoryLabel }}・{{ statusText[r.status] }}<template v-if="r.decideNote">（{{ r.decideNote }}）</template></div>
          </details>
        </UCard>
        <UCard :padded="false" class="self-start">
          <IcuBoardPanel :key="board" @open="(id) => router.push({ name: 'ipd', query: { admission: id } })" />
        </UCard>
      </div>
    </UQueryState>

    <UDialog v-model="decideOpen" :title="`${d.accept ? '同意' : '不同意'}轉入：${deciding?.patientName ?? ''}`" size="sm" @submit="submitDecide">
      <div class="space-y-2 text-sm">
        <p class="text-slate-600">{{ deciding?.categoryLabel }}：{{ deciding?.reason }}</p>
        <div v-if="d.accept"><USelect v-model="d.bedId" label="排到哪一床" :options="[{ label: '先候床（還沒有床）', value: '' }, ...bedOpts]" :error="decideAct.fieldErrors.value.bedId" /></div>
        <UTextarea v-model="d.note" :label="d.accept ? '說明（選填）' : '不同意的原因'" :rows="2" :required="!d.accept" :error="decideAct.fieldErrors.value.note" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="decideOpen = false">取消</UButton>
        <UButton type="submit" :variant="d.accept ? 'primary' : 'danger'" :loading="decideAct.pending.value">{{ d.accept ? (d.bedId ? '同意並轉入' : '同意，候床') : '不同意' }}</UButton>
      </template>
    </UDialog>
    <UDialog v-model="placeOpen" :title="`排床：${placing?.patientName ?? ''}`" size="sm" @submit="submitPlace">
      <USelect v-model="placeBed" label="加護病房的床" :options="bedOpts" :error="placeAct.fieldErrors.value.bedId" />
      <template #footer>
        <UButton variant="secondary" @click="placeOpen = false">取消</UButton>
        <UButton type="submit" :loading="placeAct.pending.value">轉入</UButton>
      </template>
    </UDialog>
  </div>
</template>
