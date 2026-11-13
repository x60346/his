<script setup lang="ts">
// 主檔維護：藥品、醫令、診斷碼、預防保健項目。每種主檔只描述「欄位」，表格與對話框共用 MasterTable。
// 停用規則在服務層：被引用的只能停用不能刪除；停用後不能開立，但舊病歷照常顯示。
import { computed, ref } from 'vue'
import { UTabs, type Column } from '@/components/ui'
import MasterTable, { type FieldDef } from './MasterTable.vue'
import { masterApi, preventApi, ServiceError, DRUG_TIMINGS, matchesDrug, TIMING_LABEL, type DrugView, type ProcedureView } from '@/services'
import { useUi } from '@/stores/ui'
import { Cancelled, useQuery } from '@/composables/useService'
import type { IcdCode, PreventItem } from '@/types'

const tab = ref('drugs')
const { data: drugs, loading: l1 } = useQuery(() => masterApi.listDrugs({ includeInactive: true }))
const { data: procs, loading: l2 } = useQuery(() => masterApi.listProcedures({ includeInactive: true }))
const { data: icds, loading: l3 } = useQuery(() => masterApi.listIcdAll())
const { data: items, loading: l4 } = useQuery(() => preventApi.listPreventItems())
const { data: freqs } = useQuery(() => masterApi.listFrequencies())

// ---------- 藥品 ----------
const ui = useUi()
/**
 * 儲存藥品：先照常送出；服務層若只因「已有同名藥品」擋下（其他欄位都已通過），才問使用者，確認後帶旗標重送。
 * 這樣確認框只在最後出現一次——若先問，使用者確認完才看到價格沒填，改好再送又被問一次。
 */
async function saveDrug(f: Record<string, any>) {
  try {
    return await masterApi.saveDrug(f as never)
  } catch (e) {
    if (!(e instanceof ServiceError && e.code === 'CONFLICT' && e.field === 'name')) throw e
    const ok = await ui.confirm({
      title: '已有同名藥品',
      message: `${e.message}

醫師開藥時只看得到藥名，同名的藥會分不出來。確定仍要儲存？`,
      okText: '確定儲存',
      danger: true,
    })
    if (!ok) throw new Cancelled()
    return masterApi.saveDrug({ ...f, allowSameName: true } as never)
  }
}

// 價格欄是「今天」的價格（服務層 listDrugs 依生效日算好）；已排定的調價在下一行小字提示（見 #cell-nhiPrice）
const drugColumns: Column<DrugView>[] = [
  { key: 'id', label: '代碼', width: '5rem' },
  { key: 'name', label: '藥名' },
  { key: 'category', label: '劑型', width: '4rem' },
  { key: 'nhiPrice', label: '健保價', align: 'right', width: '5rem' },
  { key: 'selfPrice', label: '自費價', align: 'right', width: '5rem' },
  // 全院總量（大型醫院是藥庫＋各藥局加總，含過期待報廢的）；各地點的可用量看「藥品庫存」
  { key: 'stock', label: '全院庫存', align: 'right', width: '5rem', format: (d) => `${d.stock} ${d.unit}` },
]
const drugFields = computed<FieldDef[]>(() => [
  { key: 'name', label: '藥名', required: true },
  { key: 'nameZh', label: '中文名', required: true, hint: '印在藥袋、顯示在開藥選單，例：乙醯胺酚' },
  { key: 'generic', label: '學名' },
  { key: 'aliases', label: '搜尋別名（選填）', type: 'list', hint: '只用來搜尋、不印出，例：普拿疼；' },
  { key: 'nhiCode', label: '健保代碼' },
  { key: 'spec', label: '規格', hint: '例：500 mg/tab' },
  { key: 'category', label: '劑型', type: 'select', required: true, options: ['口服', '外用', '注射', '吸入', '眼用'] },
  { key: 'unit', label: '調劑單位', required: true, hint: '藥局發多少：TAB、BTL、PEN…' },
  { key: 'doseUnit', label: '給藥單位（不同時才填）', hint: '例：Insulin 每次 10 U，但調劑 1 PEN' },
  { key: 'nhiPrice', label: '健保價（點）', type: 'number', required: true },
  { key: 'selfPrice', label: '自費價（元）', type: 'number', required: true },
  // 修改既有藥品才有：上面兩個價格「從哪天起」生效。批價依看診日，所以調價前看診、之後才批價的仍收舊價
  { key: 'priceFrom', label: '價格生效日（空白＝今天）', type: 'date', wide: true, showIf: (f) => !!f.id, hint: '健保調價通常事先公告：填生效日即可，當天起看診的才用新價。要取消已排定的調價，把那天的價格改回原價' },
  { key: 'safetyStock', label: '安全庫存', type: 'number', hint: '庫存請由「藥品庫存」進貨或盤點調整' },
  { key: 'defaultDose', label: '預設劑量', type: 'number' },
  { key: 'defaultFreq', label: '預設頻率', type: 'select', options: (freqs.value ?? []).map((f) => ({ label: `${f.code} ${f.label}`, value: f.code })) },
  { key: 'defaultRoute', label: '預設途徑', type: 'select', options: masterApi.staticCodes.routes.map((r) => ({ label: `${r.code} ${r.name}`, value: r.code })) },
  { key: 'timing', label: '服用時機（印在藥袋）', type: 'select', required: true, options: DRUG_TIMINGS.map((t) => ({ label: TIMING_LABEL[t], value: t })), showIf: (f) => f.category === '口服' },
  { key: 'indication', label: '作用或適應症（印在藥袋）', required: true, wide: true, hint: '給病人看的白話，例：降血壓' },
  { key: 'warning', label: '警語或副作用（印在藥袋）', required: true, wide: true, hint: '例：可能頭暈、腳踝水腫；起身請放慢' },
  { key: 'controlled', label: '管制藥品級別', type: 'select', options: [{ label: '非管制藥', value: '' }, ...[1, 2, 3, 4].map((n) => ({ label: `第${'一二三四'[n - 1]}級管制藥品`, value: n }))], hint: '病房點班含管制藥要另一位護理師見證' },
  { key: 'highAlert', label: '高警訊藥品', type: 'checkbox', hint: '開立與給藥時需再次確認' },
  { key: 'active', label: '使用中', type: 'checkbox', wide: true },
])
// 價格不預填 0：需要使用者決定的數字不替他先填（0 元的藥會讓批價少收錢）
const blankDrug = () => ({ name: '', nameZh: '', aliases: [], generic: '', nhiCode: '', spec: '', category: '口服', unit: 'TAB', doseUnit: '', nhiPrice: undefined, selfPrice: undefined, safetyStock: 50, defaultDose: 1, defaultFreq: 'TID', defaultRoute: 'PO', highAlert: false, controlled: '', timing: '', indication: '', warning: '', active: true })

// ---------- 醫令 ----------
const procColumns: Column<ProcedureView>[] = [
  { key: 'code', label: '代碼', width: '7rem' },
  { key: 'name', label: '名稱' },
  { key: 'category', label: '類別', width: '5rem' },
  { key: 'points', label: '健保點數', align: 'right', width: '6rem' },
  { key: 'selfPrice', label: '自費價', align: 'right', width: '6rem' },
]
const procFields: FieldDef[] = [
  { key: 'code', label: '醫令代碼', required: true },
  { key: 'name', label: '名稱', required: true },
  { key: 'category', label: '類別', type: 'select', required: true, options: ['診察', '檢驗', '影像', '處置', '復健'] },
  { key: 'points', label: '健保點數', type: 'number', hint: '0 表示一律自費（例：診斷書）' },
  { key: 'selfPrice', label: '自費價（元）', type: 'number' },
  // 修改既有醫令才有：點數、自費價「從哪天起」生效（和藥價同一套，批價依看診日）
  { key: 'priceFrom', label: '價格生效日（空白＝今天）', type: 'date', wide: true, showIf: (f) => !!f.id, hint: '健保支付標準調整通常事先公告：填生效日即可，當天起看診的才用新點數。要取消已排定的調整，把那天的價格改回原價' },
  { key: 'active', label: '使用中', type: 'checkbox' },
]
const blankProc = () => ({ code: '', name: '', category: '處置', points: 0, selfPrice: 0, active: true })

// ---------- 診斷碼 ----------
const icdColumns: Column<IcdCode>[] = [
  { key: 'code', label: '代碼', width: '7rem' },
  { key: 'name', label: '中文名稱', width: '14rem' },
  { key: 'nameEn', label: '英文名稱' },
]
const icdFields: FieldDef[] = [
  { key: 'code', label: 'ICD-10 代碼', required: true, lockOnEdit: true, hint: '例：J06.9' },
  { key: 'name', label: '中文名稱', required: true },
  { key: 'nameEn', label: '英文名稱', wide: true },
  { key: 'active', label: '使用中', type: 'checkbox' },
]

// ---------- 預防保健項目 ----------
const itemColumns: Column<PreventItem>[] = [
  { key: 'code', label: '代碼', width: '6rem' },
  { key: 'name', label: '名稱' },
  { key: 'intervalYears', label: '間隔', width: '7.5rem', format: (i) => (i.intervalYears ? `每 ${i.intervalYears} 年` : '終身／依次數') },
  { key: 'fields', label: '登錄欄位', format: (i) => i.fields.join('、') },
]
const itemFields: FieldDef[] = [
  { key: 'name', label: '名稱', required: true },
  { key: 'intervalYears', label: '間隔年數', type: 'number', hint: '0 表示終身一次' },
  { key: 'ruleText', label: '資格說明（顯示用）', wide: true },
  { key: 'fields', label: '登錄欄位', type: 'list', wide: true },
  { key: 'needsReport', label: '需等報告（登錄時預設「待報告」）', type: 'checkbox' },
  { key: 'active', label: '提供中', type: 'checkbox' },
]

const tabs = computed(() => [
  { key: 'drugs', label: '藥品', count: drugs.value?.length },
  { key: 'procs', label: '醫令', count: procs.value?.length },
  { key: 'icd', label: '診斷碼', count: icds.value?.length },
  { key: 'prevent', label: '預防保健項目', count: items.value?.length },
])
</script>

<template>
  <div class="space-y-4">
    <UTabs v-model="tab" :tabs="tabs" />
    <MasterTable
      v-if="tab === 'drugs'"
      title="藥品"
      :rows="drugs"
      :loading="l1"
      :columns="drugColumns"
      :fields="drugFields"
      :row-key="(d) => d.id"
      :search-keys="['id', 'name', 'generic', 'nhiCode']"
      :match="matchesDrug"
      :blank="blankDrug"
      :save="saveDrug"
      note="庫存不在這裡修改：請到「藥品庫存」以進貨、盤點的方式調整，每一筆增減才會留下紀錄。"
    >
      <template v-for="k in (['nhiPrice', 'selfPrice'] as const)" :key="k" #[`cell-${k}`]="{ row }">
        {{ row[k] }}
        <div v-if="row.nextPrice && row.nextPrice[k] !== row[k]" class="whitespace-nowrap text-xs text-amber-700" :title="`已排定 ${row.nextPrice.from} 起調價`">
          {{ row.nextPrice.from.slice(5).replace('-', '/') }} 起 {{ row.nextPrice[k] }}
        </div>
      </template>
      <template #cell-name="{ row }">
        <span class="font-medium">{{ row.name }}</span><span v-if="row.highAlert" class="ml-1 text-xs text-violet-700">高警訊</span><span v-if="row.controlled" class="ml-1 text-xs text-rose-700">管制 {{ row.controlled }} 級</span>
        <div class="text-xs text-slate-500">{{ row.nameZh }}・{{ row.generic }}・{{ row.spec }}</div>
      </template>
    </MasterTable>
    <MasterTable
      v-else-if="tab === 'procs'"
      title="醫令"
      :rows="procs"
      :loading="l2"
      :columns="procColumns"
      :fields="procFields"
      :row-key="(p) => p.id"
      :search-keys="['code', 'name']"
      :blank="blankProc"
      :save="(f) => masterApi.saveProcedure(f as never)"
    >
      <template v-for="k in (['points', 'selfPrice'] as const)" :key="k" #[`cell-${k}`]="{ row }">
        {{ row[k] }}
        <div v-if="row.nextPrice && row.nextPrice[k] !== row[k]" class="whitespace-nowrap text-xs text-amber-700" :title="`已排定 ${row.nextPrice.from} 起調整`">
          {{ row.nextPrice.from.slice(5).replace('-', '/') }} 起 {{ row.nextPrice[k] }}
        </div>
      </template>
    </MasterTable>
    <MasterTable
      v-else-if="tab === 'icd'"
      title="診斷碼"
      :rows="icds"
      :loading="l3"
      :columns="icdColumns"
      :fields="icdFields"
      :row-key="(c) => c.code"
      :search-keys="['code', 'name', 'nameEn']"
      :blank="() => ({ code: '', name: '', nameEn: '', active: true })"
      :save="(f, isNew) => masterApi.saveIcd({ ...(f as IcdCode), isNew })"
    />
    <MasterTable
      v-else
      title="預防保健項目"
      :rows="items"
      :loading="l4"
      :columns="itemColumns"
      :fields="itemFields"
      :row-key="(i) => i.code"
      :search-keys="['code', 'name']"
      :save="(f) => masterApi.savePreventItem(f as PreventItem)"
      note="只能調整既有項目的參數。資格條件（年齡、性別、家族史）是程式規則，新增項目需要修改程式（prevent-rules.ts），不是在這裡新增一筆資料。"
    />
  </div>
</template>
