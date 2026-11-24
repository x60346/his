<script setup lang="ts">
// 交班：以「病房」為單位，接班的人要看的是整個病房，不是一個病人。
// 顯示最近三班（一整天），依「班」分組、最新的班在前——以前依「今天」查，小夜 23:45 寫的交班，大夜 00:15 就看不到。
// 新增時預設「正要結束的班別」（handoverShiftOf），病人預設為清單上選取的那一位。
import { computed, reactive, watch } from 'vue'
import { UButton, UQueryState, USelect, UTextarea } from '@/components/ui'
import { handoverShiftOf, nursingApi, shiftOf, SHIFT_ORDER, udApi, wardStockApi, type Shift, type WardPatient } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { usePhrases } from '@/composables/usePhrases'
import PhraseHint from '@/components/PhraseHint.vue'

const props = defineProps<{ ward: string; patients: WardPatient[]; selectedId?: string; clock: string }>()
// 換班時（例：00:00 小夜 → 大夜）重新查詢，清單跟著往前推一班
const currentShift = computed(() => `${props.clock.slice(0, 10)} ${shiftOf(props.clock)}`)

const { data, loading } = useQuery(
  async () => {
    const ward = props.ward
    return { ward, groups: await nursingApi.listHandovers(ward) }
  },
  [() => props.ward, currentShift],
)
const grouped = computed(() => (data.value?.ward === props.ward ? data.value.groups : undefined))
const shifts: Shift[] = SHIFT_ORDER

const form = reactive({ shift: handoverShiftOf(props.clock) as string | number | undefined, admissionId: props.selectedId as string | number | undefined, content: '' })
// 預設是清單上選的病人；已經在寫某一位的交班內容時不跟著換（不然 A 的內容會存到 B）
watch(() => props.selectedId, (id) => id && !form.content.trim() && (form.admissionId = id))
// 分頁開著跨過換班：預設班別跟著換（不然很快寫的交班會存成上一班）
watch(currentShift, () => (form.shift = handoverShiftOf(props.clock)))
const patientOptions = computed(() => props.patients.map((p) => ({ label: `${p.bed?.bedNo ?? '日間'} ${p.patientName}`, value: p.id })))

const phrase = usePhrases(() => props.ward)
// 交班時提醒：還沒點收的藥車、回報不符藥局還沒處理的藥盒（和「本班待辦」同一個查詢）
const { data: ud } = useQuery(async () => ({ ward: props.ward, r: await udApi.listWardUdCarts(props.ward) }), [() => props.ward])
const { data: ws } = useQuery(async () => ({ ward: props.ward, v: await wardStockApi.wardStockIfAny(props.ward) }), [() => props.ward])
const udNote = computed(() => {
  const stock = ws.value?.ward === props.ward && ws.value.v && !ws.value.v.shift.counted ? `本班病房常備還沒點班` : ''
  if (ud.value?.ward !== props.ward) return stock
  const boxes = ud.value.r.carts.reduce((n, c) => n + c.boxes.length, 0)
  return [boxes && `${ud.value.r.carts.length} 車藥（${boxes} 盒）還沒點收`, ud.value.r.issues.length && `${ud.value.r.issues.length} 盒回報不符、藥局處理中`, stock].filter(Boolean).join('；')
})
// 值班紀錄：最近 24 小時夜間值班醫師處理過的事（交班時一起看；主治看過沒有）
const { data: dn } = useQuery(async () => ({ ward: props.ward, v: await nursingApi.wardDutyNotes(props.ward) }), [() => props.ward, () => props.clock])
const dutyRows = computed(() => (dn.value?.ward === props.ward ? dn.value.v : []))
// 呼叫醫師：本班幾次、平均等候、還沒回覆的（交班要交代）
const { data: cs } = useQuery(async () => ({ ward: props.ward, v: await nursingApi.wardCallStats(props.ward) }), [() => props.ward, () => props.clock])
const callStats = computed(() => (cs.value?.ward === props.ward ? cs.value.v : undefined))
// 胸管：本班引流、漏氣、提醒（可一鍵帶入交班重點）
const { data: chest } = useQuery(async () => ({ ward: props.ward, v: await nursingApi.wardChestTubes(props.ward) }), [() => props.ward, () => props.clock])
const chestRows = computed(() => (chest.value?.ward === props.ward ? chest.value.v : []))
function useChest(c: { admissionId: string; text: string }) {
  form.admissionId = c.admissionId
  form.content = form.content.trim() ? `${form.content.trim()}；${c.text}` : c.text
}
const save = useAction(nursingApi.addHandover, { success: '已新增交班' })
async function submit() {
  if (!form.admissionId) return
  const ok = await save.run({ ward: props.ward, shift: form.shift as Shift, admissionId: String(form.admissionId), content: form.content })
  if (ok) form.content = ''
}
</script>

<template>
  <div class="space-y-4 p-4">
    <p v-if="udNote" class="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">交班前注意：{{ udNote }}（藥車在「本班待辦」點收、點班在「常備點班」）</p>
    <div class="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div class="mb-2 text-sm font-semibold text-slate-700">新增交班</div>
      <!-- 班別、病人並排，交班重點獨佔一列。以前三欄並排用 md:（看整個視窗寬），
           但這裡在病人清單旁邊，寬度只有三百多 px，交班重點被擠到剩 26px -->
      <div class="grid grid-cols-[minmax(6rem,8rem)_1fr] gap-2">
        <USelect v-model="form.shift" label="班別" :options="shifts.map((s) => ({ label: s, value: s }))" />
        <USelect v-model="form.admissionId" label="病人" required :options="patientOptions" placeholder="請選擇" />
        <!-- 外包一層 div：UTextarea 把 class 傳給裡面的 textarea（inheritAttrs: false），col-span 要放在格子本身 -->
        <div class="col-span-2"><UTextarea v-model="form.content" label="交班重點" :rows="2" :error="save.fieldErrors.value.content" placeholder="例：夜間體溫最高 38.1°C，已給退燒藥；明早空腹抽血" @keydown="phrase.onKey($event, (v) => (form.content = v))" /><PhraseHint class="mt-1" :phrase="phrase" /></div>
      </div>
      <div class="mt-2 text-right"><UButton size="sm" :loading="save.pending.value" :disabled="!form.admissionId" @click="submit">儲存交班</UButton></div>
    </div>

    <!-- 值班紀錄（最近 24 小時） -->
    <section v-if="dutyRows.length" class="rounded-md border border-indigo-200 bg-indigo-50/60 p-3 text-sm">
      <div class="mb-1 font-semibold text-indigo-900">值班紀錄（最近 24 小時）</div>
      <ul class="space-y-1.5">
        <li v-for="d in dutyRows" :key="d.id" class="flex flex-wrap items-start gap-2">
          <span class="tabular w-14 shrink-0 font-medium text-slate-700">{{ d.bedNo }}</span>
          <div class="min-w-0 flex-[1_1_14rem]">
            <div><b>{{ d.patientName }}</b> <span class="text-xs text-slate-500">{{ d.at.slice(5).replace('-', '/') }} {{ d.doctorName }}・{{ d.acked ? '主治已看' : '主治還沒看' }}</span></div>
            <div class="text-xs text-slate-700">{{ d.items.map((i) => `${i.label} ${i.text}`).join('；') }}</div>
          </div>
        </li>
      </ul>
    </section>

    <!-- 呼叫醫師（本班） -->
    <section v-if="callStats?.calls" class="rounded-md border border-slate-200 p-3 text-sm">
      <div class="mb-1 font-semibold text-slate-700">呼叫醫師（本班 {{ callStats.from.slice(11) }} 起）</div>
      <p class="text-xs text-slate-600">{{ callStats.calls }} 次（緊急 {{ callStats.urgent }}）・平均等 {{ callStats.avgWait !== undefined ? `${callStats.avgWait} 分` : '—' }}{{ callStats.escalated ? `・升級 ${callStats.escalated} 次` : '' }}</p>
      <ul v-if="callStats.open.length" class="mt-1 space-y-1">
        <li v-for="o in callStats.open" :key="o.id" class="flex flex-wrap items-center gap-2 text-xs">
          <span class="tabular w-14 shrink-0 font-medium text-slate-700">{{ o.bedNo }}</span>
          <b>{{ o.patientName }}</b>
          <span :class="o.urgent ? 'font-semibold text-red-700' : 'text-amber-800'">{{ o.at.slice(11) }} {{ o.urgent ? '緊急' : '一般' }}找 {{ o.toName }}，等 {{ o.waitMin }} 分還沒回覆：交給下一班追</span>
        </li>
      </ul>
    </section>

    <!-- 胸管：本班引流量、漏氣、提醒，帶入交班重點 -->
    <section v-if="chestRows.length" class="rounded-md border border-slate-200 p-3 text-sm">
      <div class="mb-1 font-semibold text-slate-700">胸管（本班）</div>
      <ul class="space-y-1.5">
        <li v-for="c in chestRows" :key="c.lineId" class="flex flex-wrap items-start gap-2">
          <span class="tabular w-14 shrink-0 font-medium text-slate-700">{{ c.bedNo }}</span>
          <div class="min-w-0 flex-[1_1_14rem]">
            <div><b>{{ c.patientName }}</b> <span class="text-xs text-slate-500">{{ c.site }} {{ c.size }}・第 {{ c.day }} 天</span></div>
            <div class="text-xs text-slate-600">本班 {{ c.shiftRecords ? `${c.shiftMl} mL（${c.shiftRecords} 筆・${c.lastAppearance}）` : '還沒記' }}・24 小時 {{ c.ml24 }} mL・{{ c.airLeak ? '有漏氣' : '無漏氣' }}</div>
            <div v-for="a in c.alerts" :key="a" class="text-xs text-red-700">{{ a }}</div>
          </div>
          <UButton size="sm" variant="secondary" @click="useChest(c)">帶入交班</UButton>
        </li>
      </ul>
    </section>

    <!-- 48 小時內從加護病房轉來：帶出加護病房的轉出摘要（接班的人先看） -->
    <section v-if="patients.some((p) => p.icuOut)" class="rounded-md border border-sky-200 bg-sky-50/60 p-3 text-sm">
      <div class="mb-1 font-semibold text-sky-900">從加護病房轉來（48 小時內）</div>
      <div v-for="p in patients.filter((x) => x.icuOut)" :key="p.id" class="mt-2 first:mt-0">
        <div class="font-medium text-slate-800"><span class="tabular mr-2 text-slate-600">{{ p.bed?.bedNo ?? '日間' }}</span>{{ p.patientName }}<span class="tabular ml-2 text-xs font-normal text-slate-500">{{ p.icuOut!.at.slice(5).replace('-', '/') }} 轉出</span></div>
        <dl class="mt-0.5 grid grid-cols-[auto_1fr] gap-x-3 text-slate-700">
          <template v-for="it in p.icuOut!.items" :key="it.label"><dt class="text-xs text-slate-500">{{ it.label }}</dt><dd class="whitespace-pre-line">{{ it.text || '—' }}</dd></template>
        </dl>
      </div>
    </section>

    <UQueryState :loading="loading && !grouped" :ready="!!grouped?.length" :empty-title="`${ward} 最近一天沒有交班紀錄`">
      <section v-for="g in grouped" :key="g.date + g.shift" class="mb-4 last:mb-0">
        <h3 class="mb-2 text-sm font-semibold text-slate-700"><span class="tabular">{{ g.date.slice(5).replace('-', '/') }}</span> {{ g.shift }}</h3>
        <ul class="divide-y divide-slate-100 rounded-md border border-slate-200">
          <li v-for="h in g.items" :key="h.id" :class="['flex gap-3 px-3 py-2 text-sm', h.admissionId === selectedId && 'bg-brand-50/50']">
            <span class="tabular w-14 shrink-0 font-medium text-slate-700">{{ h.bedNo }}</span>
            <div class="min-w-0 flex-1">
              <div class="font-medium text-slate-800">{{ h.patientName }}</div>
              <div class="text-slate-600">{{ h.content }}</div>
            </div>
            <div class="tabular shrink-0 text-right text-xs text-slate-500">{{ h.createdAt.slice(5).replace('-', '/') }}<br />{{ h.nurseName }}<template v-if="h.receiverName"><br />接班：{{ h.receiverName }}</template></div>
          </li>
        </ul>
      </section>
    </UQueryState>
  </div>
</template>
