<script setup lang="ts">
// 病人的檢驗報告（看診頁「檢驗報告」分頁、住院醫囑頁「檢驗」分頁、護理站共用）：
// 上面是各檢驗值最近幾次的趨勢（偏高偏低標色），下面是每一份報告。危急值、更正過而還沒確認的，
// 開立醫師（住院另含主治）可在這裡按「已知悉」。資料與規則在服務層 lab.patientLabs／ackLab。
import { computed, ref } from 'vue'
import { UBadge, UButton, UEmpty, UQueryState } from '@/components/ui'
import { LAB_FLAG_TEXT, labApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ patientId?: string }>()
const { data, loading } = useQuery(async () => (props.patientId ? labApi.patientLabs(props.patientId) : undefined), [() => props.patientId])
const ack = useAction(labApi.ackLab, { success: (r) => `已確認 ${r.procName}` })
const showAll = ref(false)
const reports = computed(() => (showAll.value ? data.value?.reports : data.value?.reports.slice(0, 5)) ?? [])

const tone = (flag: string, critical?: boolean) => (critical ? 'font-bold text-red-700' : flag ? 'font-semibold text-amber-800' : 'text-slate-800')
const when = (s: string) => s.slice(5, 16).replace('-', '/')
</script>

<template>
  <UQueryState :loading="loading && !data" :ready="!!data?.reports.length" empty-title="沒有檢驗報告" empty-description="開立的檢驗發出報告後會出現在這裡">
    <div v-if="data" class="space-y-4">
      <!-- 趨勢：各檢驗值最近 6 次（舊→新） -->
      <section>
        <h4 class="mb-1.5 text-xs font-semibold text-slate-500">趨勢（最近 6 次，舊 → 新）</h4>
        <div class="overflow-x-auto rounded-md border border-slate-200">
          <table class="tabular w-full text-sm">
            <tbody class="divide-y divide-slate-100">
              <tr v-for="t in data.trends" :key="t.code">
                <td class="whitespace-nowrap px-3 py-1.5"><span class="font-medium text-slate-800">{{ t.name }}</span> <span class="text-xs text-slate-500">{{ t.unit }}</span></td>
                <td class="whitespace-nowrap px-2 text-xs text-slate-500">{{ t.ref }}</td>
                <td class="px-3">
                  <span class="flex flex-wrap items-center gap-x-1.5">
                    <template v-for="(p, i) in t.points" :key="i">
                      <span v-if="i" class="text-slate-300">→</span>
                      <span :class="tone(p.flag, p.critical)" :title="when(p.at)">{{ p.value }}{{ LAB_FLAG_TEXT[p.flag] && p.flag !== 'A' ? LAB_FLAG_TEXT[p.flag] : '' }}</span>
                    </template>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="space-y-2">
        <h4 class="text-xs font-semibold text-slate-500">報告（新的在前）</h4>
        <article v-for="r in reports" :key="r.id" :class="['rounded-md border px-3 py-2', r.needsAck ? 'border-red-300 bg-red-50/40' : 'border-slate-200']">
          <header class="flex flex-wrap items-center gap-2 text-sm">
            <span class="font-medium text-slate-800">{{ r.procName }}</span>
            <span class="tabular text-xs text-slate-500">{{ r.no }}・{{ when(r.reportedAt) }}・{{ r.source === 'ipd' ? '住院' : '門診' }}・{{ r.doctorName }} 開立</span>
            <UBadge v-if="r.hasCritical" tone="red">危急值</UBadge>
            <UBadge v-if="r.corrections?.length" tone="yellow">已更正</UBadge>
            <span v-if="r.ackAt" class="text-xs text-slate-500">{{ r.ackByName }} {{ when(r.ackAt) }} 已確認</span>
            <UButton v-if="r.canAck" size="sm" variant="danger" class="ml-auto" :loading="ack.pending.value" @click="ack.run(r.id)">已知悉</UButton>
            <span v-else-if="r.needsAck" class="ml-auto text-xs font-medium text-red-700">待開立醫師確認</span>
          </header>
          <ul class="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
            <li v-for="v in r.values" :key="v.code" class="tabular">
              <span class="text-slate-500">{{ v.name }}</span>
              <span :class="['ml-1', tone(v.flag, v.critical)]">{{ v.value }}{{ v.unit ? ` ${v.unit}` : '' }} {{ LAB_FLAG_TEXT[v.flag] }}</span>
              <span class="ml-1 text-xs text-slate-400">（{{ v.ref }}）</span>
            </li>
          </ul>
          <p v-for="(c, i) in r.corrections ?? []" :key="i" class="mt-1 text-xs text-amber-800">更正 {{ when(c.at) }}：{{ c.reason }}（原：{{ c.before.filter((b) => r.values.find((v) => v.code === b.code)?.value !== b.value).map((b) => `${b.name} ${b.value}`).join('、') }}）</p>
        </article>
        <UButton v-if="!showAll && data.reports.length > 5" size="sm" variant="ghost" @click="showAll = true">顯示全部 {{ data.reports.length }} 份</UButton>
        <UEmpty v-if="!data.reports.length" title="沒有檢驗報告" />
      </section>
    </div>
  </UQueryState>
</template>
