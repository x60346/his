<script setup lang="ts">
// 加護病房床邊看板（病房層級分頁）：每一床一格——病人、最新一筆流程表的數值（異常紅字）、多久沒記（超過 75 分鐘標紅）、
// 今天到現在的輸入輸出平衡、這一班的責任護理師。點一格到那位病人的「重症流程表」
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { UBadge, UQueryState } from '@/components/ui'
import { HOURLY_LATE_MIN, icuApi, PUPIL_LIGHT_SHORT } from '@/services'
import { useQuery } from '@/composables/useService'

const emit = defineEmits<{ open: [admissionId: string, tab: string] }>()
const { data, loading, reload } = useQuery(() => icuApi.icuBoard(), [])
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => (timer = setInterval(reload, 60_000)))
onBeforeUnmount(() => clearInterval(timer))
const occupied = computed(() => (data.value ?? []).filter((b) => b.admissionId).length)
const late = computed(() => (data.value ?? []).filter((b) => b.late).length)
const bad = (r: { last?: { abnormal: string[] } }, k: string) => !!r.last?.abnormal.includes(k)
</script>

<template>
  <div class="space-y-3 p-4 text-sm">
    <UQueryState :loading="loading && !data" :ready="!!data">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-semibold text-slate-700">床邊看板</span>
        <span class="text-xs text-slate-500">{{ occupied }}／{{ data?.length }} 床使用中</span>
        <UBadge v-if="late" tone="red">流程表漏記 {{ late }} 床</UBadge>
      </div>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
        <template v-for="b in data" :key="b.bedId">
          <button v-if="b.admissionId" type="button" :class="['rounded-md border p-3 text-left hover:bg-slate-50', b.late ? 'border-red-300 bg-red-50/40' : 'border-slate-200 bg-white']" @click="emit('open', b.admissionId!, 'flowsheet')">
            <div class="flex items-center gap-2">
              <span class="tabular rounded bg-slate-100 px-1.5 text-xs font-medium text-slate-700">{{ b.bedNo }}</span>
              <span class="font-medium text-slate-800">{{ b.patientName }}</span>
              <span class="ml-auto text-xs text-slate-500">{{ b.nurseName ?? '未分床' }}</span>
            </div>
            <div class="mt-0.5 truncate text-xs text-slate-500">{{ b.diagnosis }}・{{ b.doctorName }}</div>
            <dl v-if="b.last" class="tabular mt-2 grid grid-cols-3 gap-x-2 gap-y-0.5 text-xs">
              <div><dt class="inline text-slate-500">HR </dt><dd :class="['inline', bad(b, '脈搏') && 'font-semibold text-red-600']">{{ b.last.pulse ?? '—' }}</dd></div>
              <div class="col-span-2"><dt class="inline text-slate-500">BP </dt><dd :class="['inline', (bad(b, '收縮壓') || bad(b, '舒張壓')) && 'font-semibold text-red-600']">{{ b.last.sbp ?? '—' }}/{{ b.last.dbp ?? '—' }}</dd><span :class="['ml-1', bad(b, 'MAP') ? 'font-semibold text-red-600' : 'text-slate-500']">（MAP {{ b.last.map ?? '—' }}）</span></div>
              <div><dt class="inline text-slate-500">RR </dt><dd :class="['inline', bad(b, '呼吸') && 'font-semibold text-red-600']">{{ b.last.resp ?? '—' }}</dd></div>
              <div><dt class="inline text-slate-500">SpO2 </dt><dd :class="['inline', bad(b, '血氧') && 'font-semibold text-red-600']">{{ b.last.spo2 ?? '—' }}</dd></div>
              <div><dt class="inline text-slate-500">T </dt><dd :class="['inline', bad(b, '體溫') && 'font-semibold text-red-600']">{{ b.last.temp ?? '—' }}</dd></div>
            </dl>
            <!-- 意識、瞳孔不一定每小時評：顯示最近一次（附時間） -->
            <div v-if="b.admissionId" class="tabular mt-0.5 flex flex-wrap gap-x-3 text-xs">
              <span><span class="text-slate-500">GCS </span><span :class="b.neuro?.gcs?.low && 'font-semibold text-red-600'">{{ b.neuro?.gcs ? `${b.neuro.gcs.sum}（E${b.neuro.gcs.e}V${b.neuro.gcs.v}M${b.neuro.gcs.m}）` : '—' }}</span><span v-if="b.neuro?.gcs" class="text-slate-400"> {{ b.neuro.gcs.at.slice(11) }}</span></span>
              <span><span class="text-slate-500">瞳孔 </span><span :class="b.neuro?.pupils?.unequal && 'font-semibold text-red-600'">{{ b.neuro?.pupils ? `${b.neuro.pupils.l}${PUPIL_LIGHT_SHORT[b.neuro.pupils.lightL]}/${b.neuro.pupils.r}${PUPIL_LIGHT_SHORT[b.neuro.pupils.lightR]}` : '—' }}</span><span v-if="b.neuro?.pupils" class="text-slate-400"> {{ b.neuro.pupils.at.slice(11) }}</span></span>
            </div>
            <div class="mt-2 flex items-center gap-2 text-xs">
              <span v-if="b.late" class="font-semibold text-red-700">{{ b.minutes }} 分鐘沒記（&gt;{{ HOURLY_LATE_MIN }}）</span>
              <span v-else-if="b.last" class="text-slate-500">{{ b.last.at.slice(11) }} 記（{{ b.minutes }} 分鐘前）</span>
              <span v-else class="text-amber-700">還沒記流程表</span>
              <span class="tabular ml-auto text-slate-500">今日平衡 <span :class="['font-semibold', (b.balance ?? 0) > 0 ? 'text-sky-700' : (b.balance ?? 0) < 0 ? 'text-amber-700' : '']">{{ (b.balance ?? 0) > 0 ? '+' : '' }}{{ b.balance }}</span></span>
            </div>
          </button>
          <div v-else class="rounded-md border border-dashed border-slate-200 p-3 text-slate-400">
            <span class="tabular rounded bg-slate-50 px-1.5 text-xs font-medium">{{ b.bedNo }}</span>
            <span class="ml-2 text-xs">{{ b.status === 'cleaning' ? '清潔中' : b.status === 'reserved' ? '保留' : '空床' }}</span>
          </div>
        </template>
      </div>
    </UQueryState>
  </div>
</template>
