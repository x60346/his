<script setup lang="ts">
// 病人的影像檢查（看診頁「影像報告」、住院醫囑頁「影像」分頁共用）：
// 上面是還沒判讀的（開單醫師知道在等什麼；自己能判讀的——心電圖——直接「判讀」到影像判讀頁），
// 下面是報告（新的在前）。重要發現或補充過、還沒確認的，開立醫師（住院含主治）按「已知悉」。資料與規則在服務層 imaging.ts。
import { useRouter } from 'vue-router'
import { UBadge, UButton, UQueryState } from '@/components/ui'
import { imagingApi } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ patientId?: string }>()
const router = useRouter()
const { data, loading } = useQuery(async () => (props.patientId ? imagingApi.patientImaging(props.patientId) : undefined), [() => props.patientId])
const ack = useAction(imagingApi.ackImaging, { success: (r) => `已確認 ${r.procName}` })
const when = (s: string) => s.slice(5, 16).replace('-', '/')
</script>

<template>
  <UQueryState :loading="loading && !data" :ready="!!data && (data.reports.length > 0 || data.pending.length > 0)" empty-title="沒有影像檢查" empty-description="開立的 X 光、超音波、心電圖、電腦斷層判讀後會出現在這裡">
    <div v-if="data" class="space-y-4">
      <section v-if="data.pending.length">
        <h4 class="mb-1.5 text-xs font-semibold text-slate-500">還沒判讀</h4>
        <ul class="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
          <li v-for="w in data.pending" :key="w.key" class="flex flex-wrap items-center gap-2 px-3 py-2">
            <span class="font-medium text-slate-800">{{ w.procName }}</span>
            <span class="text-xs text-slate-500">{{ when(w.orderedAt) }} 開立・{{ w.awaitingExam ? '還沒做檢查' : w.reader === 'radiology' ? '等放射科判讀' : '等開立醫師判讀' }}</span>
            <UButton v-if="w.canRead" size="sm" class="ml-auto" @click="router.push({ name: 'imaging', query: { key: w.key } })">判讀</UButton>
          </li>
        </ul>
      </section>
      <section class="space-y-2">
        <h4 v-if="data.reports.length" class="text-xs font-semibold text-slate-500">報告（新的在前）</h4>
        <article v-for="r in data.reports" :key="r.id" :class="['rounded-md border px-3 py-2 text-sm', r.needsAck ? 'border-red-300 bg-red-50/40' : 'border-slate-200']">
          <header class="flex flex-wrap items-center gap-2">
            <span class="font-medium text-slate-800">{{ r.procName }}</span>
            <span class="tabular text-xs text-slate-500">{{ r.no }}・{{ when(r.reportedAt) }}・{{ r.er ? '急診' : r.source === 'ipd' ? '住院' : '門診' }}・判讀 {{ r.readerName }}</span>
            <UBadge v-if="r.significant" tone="red">重要發現</UBadge>
            <UBadge v-if="r.addenda?.length" tone="yellow">已補充</UBadge>
            <span v-if="r.ackAt" class="text-xs text-slate-500">{{ r.ackByName }} {{ when(r.ackAt) }} 已確認</span>
            <UButton v-if="r.canAck" size="sm" variant="danger" class="ml-auto" :loading="ack.pending.value" @click="ack.run(r.id)">已知悉</UButton>
            <span v-else-if="r.needsAck" class="ml-auto text-xs font-medium text-red-700">待開立醫師確認</span>
          </header>
          <p :class="['mt-1 font-semibold', r.significant ? 'text-red-700' : 'text-slate-800']">{{ r.impression }}</p>
          <p class="whitespace-pre-wrap text-slate-600">{{ r.findings }}</p>
          <p v-for="(a, i) in r.addenda ?? []" :key="i" class="mt-1 rounded bg-amber-50 px-2 py-1 text-amber-900"><span class="text-xs">補充 {{ when(a.at) }}：</span>{{ a.text }}</p>
        </article>
      </section>
    </div>
  </UQueryState>
</template>
