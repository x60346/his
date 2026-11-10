<script setup lang="ts">
// 元件展示頁：開發時檢查元件外觀與互動，也是元件用法的活範例。
import { computed, ref } from 'vue'
import { Activity, BedDouble, Pill, Plus, Save, Users } from 'lucide-vue-next'
import {
  UBadge, UBarChart, UButton, UCard, UCheckbox, UDialog, UEmpty, UInput, ULineChart, UPageHeader,
  USearchSelect, USelect, UStatCard, UStatusBadge, UTable, UTabs, UTextarea, type Column,
} from '@/components/ui'
import PatientBanner from '@/components/PatientBanner.vue'
import { masterApi, ServiceError, type PatientBrief } from '@/services'
import { useAction } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import { visitStatus } from '@/utils/labels'
import type { IcdCode, VisitStatus } from '@/types'

const ui = useUi()

const name = ref('王小明')
const age = ref<number | undefined>(35)
const dept = ref<string | number | undefined>('D01')
const note = ref('')
const agree = ref(true)
const tab = ref('a')
const dialog = ref(false)
const picked = ref<IcdCode[]>([])

const patient: PatientBrief = { patientId: 'X', chartNo: '100002', patientName: '李美玲', gender: 'F', birthDate: '1979-04-12', age: 47, allergies: ['Penicillin'] }

interface Row { id: string; seq: number; name: string; status: VisitStatus }
const rows: Row[] = [
  { id: '1', seq: 1, name: '王志明', status: 'dispensed' },
  { id: '2', seq: 2, name: '李美玲', status: 'consulted' },
  { id: '3', seq: 3, name: '張家豪', status: 'in-consult' },
  { id: '4', seq: 4, name: '陳淑芬', status: 'registered' },
  { id: '5', seq: 5, name: '林俊傑', status: 'cancelled' },
]
const columns: Column<Row>[] = [
  { key: 'seq', label: '號', width: '60px', align: 'center' },
  { key: 'name', label: '姓名' },
  { key: 'status', label: '狀態' },
]
const selected = ref<string>()

const temps = computed(() =>
  [38.6, 38.9, 38.2, 37.9, 37.6, 37.8, 37.2, 37.0, 36.8].map((y, i) => ({ x: `11/0${6 + Math.floor(i / 3)} ${['08', '14', '20'][i % 3]}:00`, y })),
)
const bars = [12, 18, 9, 21, 17, 4, 16].map((value, i) => ({ label: `11/0${3 + i}`, value }))

// 模擬一個會失敗的寫入，示範 ServiceError → toast 的標準流程
const save = useAction(async () => {
  await new Promise((r) => setTimeout(r, 600))
  if (!name.value.trim()) throw new ServiceError('姓名為必填')
  return name.value
}, { success: (n) => `已儲存 ${n}` })

async function askDelete() {
  const ok = await ui.confirm({ title: '作廢收據', message: '確定作廢 R202611090001？\n作廢後需重新批價。', okText: '作廢', danger: true })
  ui.toast.info(ok ? '已確認作廢' : '已取消')
}
</script>

<template>
  <div class="mx-auto max-w-6xl space-y-6 p-6">
    <UPageHeader title="UI 元件展示" subtitle="開發用頁面：每個元件的外觀與用法">
      <UButton variant="secondary" :icon="Plus">次要</UButton>
      <UButton :icon="Save" :loading="save.pending.value" @click="save.run()">儲存（清空姓名試試錯誤）</UButton>
    </UPageHeader>

    <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <UStatCard label="今日掛號" value="17" hint="候診 10 人" :icon="Users" />
      <UStatCard label="待領藥" value="2" :icon="Pill" tone="amber" />
      <UStatCard label="住院中" value="8" hint="空床 16" :icon="BedDouble" tone="emerald" />
      <UStatCard label="逾時未給藥" value="3" :icon="Activity" tone="red" />
    </div>

    <PatientBanner :patient="patient"><UBadge tone="blue">健保一般</UBadge></PatientBanner>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <UCard title="表單元件">
        <div class="grid grid-cols-2 gap-3">
          <UInput v-model="name" label="姓名" required :error="name ? '' : '姓名為必填'" />
          <UInput v-model="age" label="年齡" type="number" hint="type=number 會回傳數字" />
          <USelect v-model="dept" label="科別" :options="[{ label: '家醫科', value: 'D01' }, { label: '內科', value: 'D02' }]" placeholder="請選擇" />
          <div class="flex items-end pb-2"><UCheckbox v-model="agree" label="初診" /></div>
          <div class="col-span-2"><UTextarea v-model="note" label="主訴" placeholder="S：病人主觀描述" /></div>
          <div class="col-span-2">
            <USearchSelect
              label="ICD-10 診斷（實際呼叫服務層 masterApi.searchIcd）"
              placeholder="輸入代碼或中文，例：J06、高血壓"
              :search="(kw) => masterApi.searchIcd(kw)"
              :item-key="(c) => c.code"
              :item-label="(c) => `${c.code}　${c.name}`"
              :item-sub="(c) => c.nameEn"
              @select="(c) => picked.push(c)"
            />
            <div class="mt-2 flex flex-wrap gap-1">
              <UBadge v-for="c in picked" :key="c.code" tone="blue">{{ c.code }} {{ c.name }}</UBadge>
            </div>
          </div>
        </div>
        <p class="mt-3 text-xs text-slate-500">目前值：{{ { name, age, dept, agree } }}</p>
      </UCard>

      <UCard title="資料表 + 狀態徽章" :padded="false">
        <template #actions><UTabs v-model="tab" :tabs="[{ key: 'a', label: '全部', count: 5 }, { key: 'b', label: '候診', count: 1 }]" /></template>
        <UTable :columns="columns" :rows="rows" :row-key="(r) => r.id" clickable :selected-key="selected" @row-click="(r) => (selected = r.id)">
          <template #cell-status="{ row }"><UStatusBadge :map="visitStatus" :value="row.status" /></template>
        </UTable>
      </UCard>

      <UCard title="圖表">
        <ULineChart :points="temps" title="體溫" unit="°C" :normal="[36, 37.5]" :format-x="(x) => x.slice(6, 8) === '08' ? x.slice(0, 5) : ''" />
        <div class="mt-4"><UBarChart :data="bars" title="近 7 日門診人次" unit="人" /></div>
      </UCard>

      <UCard title="對話框、確認框、提示">
        <div class="flex flex-wrap gap-2">
          <UButton variant="secondary" @click="dialog = true">開啟對話框</UButton>
          <UButton variant="danger" @click="askDelete">確認框（await）</UButton>
          <UButton variant="success" @click="ui.toast.success('已完成')">成功</UButton>
          <UButton variant="ghost" @click="ui.toast.warning('庫存低於安全量')">警告</UButton>
          <UButton size="sm" @click="ui.toast.error('此診已額滿')">小按鈕</UButton>
        </div>
        <UEmpty title="今天沒有候診病人" description="可以到掛號作業新增掛號" />
      </UCard>
    </div>

    <UDialog v-model="dialog" title="範例對話框" size="md">
      <p class="text-sm text-slate-600">按 Esc、點背景或右上角 X 都可以關閉。</p>
      <template #footer>
        <UButton variant="secondary" @click="dialog = false">取消</UButton>
        <UButton @click="dialog = false">確定</UButton>
      </template>
    </UDialog>
  </div>
</template>
