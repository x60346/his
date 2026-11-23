<script setup lang="ts">
// 醫師值班：各科每天一位值班醫師（平日 17:00 到隔天 08:00、週六日全天）。有權限（醫師值班排班）的人可以改，其他人看。
// 下班時間主治不在：床邊處置判讀異常超過 2 小時改通知值班醫師、危急值通報提示值班醫師。服務層 duty.ts、規則 duty-rules
import { computed, ref } from 'vue'
import { UButton, UCard, UPageHeader, UQueryState } from '@/components/ui'
import { dutyApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'
import { addDays, today } from '@/utils/date'

const from = ref(today())
const { data, loading } = useQuery(async () => ({ from: from.value, v: await dutyApi.dutyRoster(from.value, 7) }), [from])
const r = computed(() => (data.value?.from === from.value ? data.value.v : undefined))
const set = useAction(dutyApi.setDuty, { success: '已更新值班' })
const wd = (d: string) => '日一二三四五六'[new Date(`${d}T00:00:00`).getDay()]
</script>

<template>
  <div class="space-y-4">
    <UPageHeader title="醫師值班" description="各科每天一位值班醫師（平日 17:00 到隔天 08:00、週六日全天）：下班時間主治不在，判讀異常升級與危急值通報找值班醫師" />
    <UQueryState :loading="loading && !r" :ready="!!r">
      <template v-if="r">
        <div class="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm">
          <template v-if="r.now.offHours">現在值班：<span v-for="x in r.now.onCall" :key="x.deptName" class="mr-3"><b>{{ x.deptName }}</b> {{ x.name }}</span><span v-if="!r.now.onCall.length" class="text-amber-700">沒有排值班</span></template>
          <span v-else class="text-slate-500">現在是上班時間（主治負責）</span>
        </div>
        <UCard :padded="false">
          <div class="px-4 py-2 text-sm font-semibold text-slate-700">護理站呼叫值班醫師（{{ r.shiftCalls.hoursText }}）</div>
          <p v-if="!r.shiftCalls.rows.length" class="px-4 pb-3 text-sm text-slate-400">那一班沒有排值班</p>
          <div v-else class="overflow-x-auto">
            <table class="min-w-[36rem] text-sm">
              <thead><tr class="border-t border-slate-200 text-left text-xs text-slate-500"><th class="px-3 py-1">科</th><th class="px-2 py-1">值班醫師</th><th class="px-2 py-1 text-right">被呼叫</th><th class="px-2 py-1 text-right">緊急</th><th class="px-2 py-1 text-right">還沒回覆</th><th class="px-2 py-1 text-right">平均等候</th><th class="px-2 py-1 text-right">沒寫值班紀錄</th></tr></thead>
              <tbody>
                <tr v-for="x in r.shiftCalls.rows" :key="x.deptName" class="border-t border-slate-100">
                  <td class="whitespace-nowrap px-3 py-1.5 font-medium text-slate-700">{{ x.deptName }}</td>
                  <td class="whitespace-nowrap px-2 py-1.5">{{ x.name }}</td>
                  <td class="tabular px-2 py-1.5 text-right">{{ x.calls }}</td>
                  <td class="tabular px-2 py-1.5 text-right" :class="x.urgent ? 'font-semibold text-red-700' : ''">{{ x.urgent }}</td>
                  <td class="tabular px-2 py-1.5 text-right" :class="x.open ? 'font-semibold text-amber-700' : ''">{{ x.open }}</td>
                  <td class="tabular px-2 py-1.5 text-right">{{ x.avgWait !== undefined ? `${x.avgWait} 分` : '—' }}</td>
                  <td class="tabular px-2 py-1.5 text-right" :class="x.withoutNote ? 'font-semibold text-amber-700' : ''">{{ x.withoutNote }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </UCard>
        <UCard :padded="false">
          <div class="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
            <UButton size="sm" variant="secondary" @click="from = addDays(from, -7)">上一週</UButton>
            <span class="tabular">{{ from.slice(5) }} 起 7 天</span>
            <UButton size="sm" variant="secondary" @click="from = addDays(from, 7)">下一週</UButton>
            <span v-if="!r.canEdit" class="text-xs text-slate-500">排班由有「醫師值班排班」權限的人安排</span>
          </div>
          <div class="overflow-x-auto">
            <table class="min-w-[58rem] text-sm">
              <thead><tr class="border-t border-slate-200 text-left text-xs text-slate-500"><th class="px-3 py-1">日期</th><th v-for="d in r.depts" :key="d.id" class="px-2 py-1">{{ d.name }}</th></tr></thead>
              <tbody>
                <tr v-for="day in r.days" :key="day.date" class="border-t border-slate-100">
                  <td class="tabular whitespace-nowrap px-3 py-1.5 font-medium text-slate-700" :title="day.hoursText">{{ day.date.slice(5) }}（{{ wd(day.date) }}）</td>
                  <td v-for="c in day.cells" :key="c.deptId" class="px-2 py-1">
                    <select v-if="r.canEdit && day.date >= today()" class="form-control min-w-[5.5rem] py-0.5 text-xs" :value="c.userId ?? ''" :aria-label="`${day.date} ${r.depts.find((d) => d.id === c.deptId)?.name}`" @change="set.run({ date: day.date, deptId: c.deptId, userId: ($event.target as HTMLSelectElement).value })">
                      <option value="">（沒排）</option>
                      <option v-for="doc in r.depts.find((d) => d.id === c.deptId)?.doctors ?? []" :key="doc.id" :value="doc.id">{{ doc.name }}</option>
                    </select>
                    <span v-else :class="c.name ? 'text-slate-700' : 'text-slate-400'">{{ c.name ?? '沒排' }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </UCard>
      </template>
    </UQueryState>
  </div>
</template>
