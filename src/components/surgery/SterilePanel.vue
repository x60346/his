<script setup lang="ts">
// 手術室「器械滅菌」分頁（供應中心）：庫存（可用、生物指示劑還沒出來、快到期）、登記滅菌鍋次、判讀生物指示劑、
// 召回（沒用的收回、用過的逐台通知主刀與感控）、過期待收回。能不能做、能不能用由服務層判斷（sterile.ts、sterile-rules）
import { reactive, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, UQueryState, USelect } from '@/components/ui'
import { PACK_SET_LABEL, PACK_SETS, STERILIZERS, sterileApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const { data: v, loading } = useQuery(() => sterileApi.sterileBoard(), [])

// 登記一鍋
const regOpen = ref(false)
const reg = reactive({ sterilizer: STERILIZERS[0] as string | number | undefined, ciPass: false, packs: Object.fromEntries(PACK_SETS.map((s) => [s, undefined])) as Record<string, number | undefined> })
function openReg() {
  Object.assign(reg, { sterilizer: STERILIZERS[0], ciPass: false, packs: Object.fromEntries(PACK_SETS.map((s) => [s, undefined])) })
  regAct.fieldErrors.value = {}
  regOpen.value = true
}
const regAct = useAction(sterileApi.registerBatch, { success: (r) => `已登記 ${r.batch.no}：${r.packNos.length} 包（${r.packNos[0]}–${r.packNos.at(-1)}）` })
async function submitReg() {
  if (await regAct.run({ sterilizer: String(reg.sterilizer), ciPass: reg.ciPass, packs: Object.fromEntries(Object.entries(reg.packs).filter(([, n]) => n !== undefined && n !== null && String(n) !== '').map(([k, n]) => [k, Number(n)])) })) regOpen.value = false
}

const biAct = useAction(sterileApi.recordBi, { success: (b) => (b.biState === 'positive' ? `${b.no} 生物指示劑陽性：整鍋召回` : `${b.no} 生物指示劑陰性，放行`) })
const BI_TONE = { pending: 'gray', due: 'yellow', negative: 'green', positive: 'red' } as const

// 召回：通知主刀與感控
const notifying = ref<{ batchId: string; surgeryId: string; label: string }>()
const notifyOpen = ref(false)
const note = ref('')
function openNotify(x: { batchId: string; surgeryId: string; label: string }) {
  notifying.value = x
  note.value = ''
  notifyAct.fieldErrors.value = {}
  notifyOpen.value = true
}
const notifyAct = useAction(sterileApi.notifyRecall, { success: '已記錄通知' })
async function submitNotify() {
  if (notifying.value && (await notifyAct.run(notifying.value.batchId, notifying.value.surgeryId, note.value))) notifyOpen.value = false
}
const wdAct = useAction(sterileApi.withdrawPack, { success: (r) => `${r.no} 已收回` })
</script>

<template>
  <UQueryState :loading="loading && !v" :ready="!!v">
    <div v-if="v" class="space-y-3 text-sm">
      <div class="flex flex-wrap items-center gap-2">
        <p class="text-slate-500">滅菌後 30 天有效；生物指示劑培養 24 小時判讀，會放植入物的手術要等陰性。手術中由流動護理師在那一台的「器械包」掃包號。</p>
        <UButton v-if="v.canManage" size="sm" class="ml-auto" :icon="Plus" @click="openReg">登記滅菌鍋次</UButton>
      </div>

      <section v-for="r in v.recalls" :key="r.batchId" class="rounded-md border border-red-300 bg-red-50 p-3">
        <h3 class="font-semibold text-red-800">召回：{{ r.batchNo }}<span class="ml-2 text-xs font-normal text-red-700">{{ r.recalledAt.slice(5) }} 生物指示劑陽性，整鍋召回</span></h3>
        <div v-if="r.affected.length" class="mt-1">
          <div class="text-xs font-medium text-red-800">用過的手術（逐台通知主刀與感控）</div>
          <ul class="divide-y divide-red-100">
            <li v-for="a in r.affected" :key="a.surgeryId + a.packNo" class="flex flex-wrap items-center gap-2 py-1">
              <b>{{ a.patientName }}</b><span class="text-xs text-slate-600">{{ a.chartNo }}・{{ a.no }} {{ a.procName }}・主刀 {{ a.doctorName }}・{{ a.usedAt.slice(5) }} 用 {{ a.packNo }}</span>
              <span v-if="a.notified" class="text-xs text-emerald-700">已通知：{{ a.notified }}</span>
              <UButton v-else-if="v.canManage" size="sm" variant="danger" class="ml-auto" @click="openNotify({ batchId: r.batchId, surgeryId: a.surgeryId, label: `${a.patientName} ${a.no}` })">記錄通知</UButton>
              <UBadge v-else tone="red">還沒通知</UBadge>
            </li>
          </ul>
        </div>
        <div v-if="r.toWithdraw.length" class="mt-2">
          <div class="text-xs font-medium text-red-800">還在架上、要收回的 {{ r.toWithdraw.length }} 包</div>
          <div class="mt-1 flex flex-wrap gap-1.5">
            <span v-for="p in r.toWithdraw" :key="p.id" class="inline-flex items-center gap-1 rounded border border-red-200 bg-white px-1.5 py-0.5 text-xs">
              {{ p.no }} {{ p.setLabel }}
              <button v-if="v.canManage" type="button" class="text-red-700 underline" @click="wdAct.run(p.id, '生物指示劑陽性召回')">收回</button>
            </span>
          </div>
        </div>
        <p v-if="!r.affected.length && !r.toWithdraw.length" class="mt-1 text-xs text-slate-600">已全部收回，沒有用在手術上。</p>
      </section>

      <section class="rounded-md border border-slate-200 bg-white p-3">
        <h3 class="mb-2 font-semibold text-slate-700">庫存</h3>
        <div class="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(10rem,1fr))]">
          <div v-for="s in v.stock" :key="s.set" class="rounded border border-slate-200 px-2 py-1.5">
            <div class="text-xs text-slate-500">{{ s.label }}</div>
            <div class="tabular text-xl font-semibold" :class="s.available ? 'text-slate-800' : 'text-red-700'">{{ s.available }} 包</div>
            <div class="text-xs text-slate-500">
              <span v-if="s.biPending">其中 {{ s.biPending }} 包生物指示劑培養中</span>
              <span v-if="s.expiring" class="ml-1 text-amber-700">{{ s.expiring }} 包 3 天內到期</span>
              <span v-if="s.expired" class="ml-1 text-red-700">過期 {{ s.expired }}</span>
            </div>
          </div>
        </div>
      </section>

      <section v-if="v.expired.length" class="rounded-md border border-amber-300 bg-amber-50 p-3">
        <h3 class="font-semibold text-amber-900">過期待收回 {{ v.expired.length }} 包<span class="ml-2 text-xs font-normal text-slate-600">收回重新滅菌（新的鍋次、新的包號）</span></h3>
        <ul class="mt-1 space-y-0.5">
          <li v-for="p in v.expired" :key="p.id" class="flex flex-wrap items-center gap-2">
            <span>{{ p.no }} {{ p.setLabel }}・{{ p.batchNo }}・效期到 {{ p.expiresOn }}</span>
            <UButton v-if="v.canManage" size="sm" variant="secondary" class="ml-auto" :loading="wdAct.pending.value" @click="wdAct.run(p.id, '過期，重新滅菌')">收回</UButton>
          </li>
        </ul>
      </section>

      <section class="rounded-md border border-slate-200 bg-white p-3">
        <h3 class="mb-1 font-semibold text-slate-700">滅菌鍋次<span class="ml-2 text-xs font-normal text-slate-500">最近 7 天與還沒判讀的</span></h3>
        <ul class="divide-y divide-slate-100">
          <li v-for="b in v.batches" :key="b.id" class="flex flex-wrap items-center gap-2 py-1.5">
            <b class="tabular">{{ b.no }}</b>
            <span class="tabular text-xs text-slate-600">{{ b.at.slice(5) }}・{{ b.byName }}・{{ b.contents }}</span>
            <UBadge :tone="BI_TONE[b.biState]">{{ b.biText }}</UBadge>
            <span v-if="b.biByName" class="text-xs text-slate-500">{{ b.biByName }}</span>
            <span v-if="v.canManage && b.biState === 'due'" class="ml-auto flex gap-2">
              <UButton size="sm" variant="secondary" :loading="biAct.pending.value" @click="biAct.run(b.id, 'negative')">陰性</UButton>
              <UButton size="sm" variant="danger" :loading="biAct.pending.value" @click="biAct.run(b.id, 'positive')">陽性（召回）</UButton>
            </span>
          </li>
        </ul>
      </section>
    </div>

    <UDialog v-model="regOpen" title="登記滅菌鍋次" size="sm" @submit="submitReg">
      <div class="space-y-3 text-sm">
        <USelect v-model="reg.sterilizer" label="滅菌鍋" :options="STERILIZERS" :error="regAct.fieldErrors.value.sterilizer" />
        <div class="grid grid-cols-2 gap-2">
          <UInput v-for="s in PACK_SETS" :key="s" v-model="reg.packs[s]" type="number" :label="`${PACK_SET_LABEL[s]}（包）`" :error="regAct.fieldErrors.value[s]" />
        </div>
        <p v-if="regAct.fieldErrors.value.packs" class="text-xs text-red-600">{{ regAct.fieldErrors.value.packs }}</p>
        <UCheckbox v-model="reg.ciPass" label="化學指示劑合格（每包外面的指示帶都變色）" />
        <p v-if="regAct.fieldErrors.value.ciPass" class="text-xs text-red-600">{{ regAct.fieldErrors.value.ciPass }}</p>
        <p class="text-xs text-slate-500">登記後產生包號、效期 30 天；生物指示劑 24 小時後判讀。</p>
      </div>
      <template #footer>
        <UButton variant="secondary" @click="regOpen = false">取消</UButton>
        <UButton type="submit" :loading="regAct.pending.value">登記</UButton>
      </template>
    </UDialog>
    <UDialog v-model="notifyOpen" :title="`召回通知：${notifying?.label ?? ''}`" size="sm" @submit="submitNotify">
      <UInput v-model="note" label="通知了誰、後續怎麼處理" placeholder="例：已電話通知主刀與感控，追蹤傷口感染 30 天" :error="notifyAct.fieldErrors.value.note" />
      <template #footer>
        <UButton variant="secondary" @click="notifyOpen = false">取消</UButton>
        <UButton type="submit" :loading="notifyAct.pending.value">記錄</UButton>
      </template>
    </UDialog>
  </UQueryState>
</template>
