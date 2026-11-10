<script setup lang="ts">
// 護理紀錄：Focus DAR（焦點 Focus、資料 Data、措施 Action、反應 Response）。
// 焦點常用語做成按鈕；反應（R）常常是一段時間後才知道（給退燒藥一小時後複測），所以允許先空著。
import { computed, reactive, watch } from 'vue'
import { UButton, UInput, UQueryState, UTextarea } from '@/components/ui'
import { nursingApi, type AdmissionView } from '@/services'
import { useAction, useQuery } from '@/composables/useService'

const props = defineProps<{ admission: AdmissionView }>()

const { data, loading } = useQuery(
  async () => {
    const id = props.admission.id
    return { id, list: await nursingApi.listNursingNotes(id) }
  },
  [() => props.admission.id],
)
const notes = computed(() => (data.value?.id === props.admission.id ? data.value.list : undefined))

const focusPresets = ['體溫過高', '急性疼痛', '跌倒高危險群', '皮膚完整性受損', '焦慮', '睡眠型態紊亂', '營養攝取不足']
const blank = () => ({ focus: '', data: '', action: '', response: '' })
const form = reactive(blank())
watch(() => props.admission.id, () => Object.assign(form, blank()))

const save = useAction(nursingApi.addNursingNote, { success: '已新增護理紀錄' })
async function submit() {
  if (await save.run({ admissionId: props.admission.id, ...form })) Object.assign(form, blank())
}

// 補記反應：每筆紀錄各自一個草稿
const drafts = reactive<Record<string, string>>({})
const respondAction = useAction(nursingApi.addNoteResponse, { success: '已補記反應' })
async function respond(noteId: string) {
  if (await respondAction.run(noteId, drafts[noteId] ?? '')) delete drafts[noteId]
}
</script>

<template>
  <div class="space-y-4 p-4">
    <div class="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div class="mb-2 text-sm font-semibold text-slate-700">新增護理紀錄（Focus DAR）</div>
      <div class="mb-2 flex flex-wrap gap-1.5">
        <UButton v-for="p in focusPresets" :key="p" size="sm" variant="secondary" @click="form.focus = p">{{ p }}</UButton>
      </div>
      <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
        <UInput v-model="form.focus" label="F 焦點" required :error="save.fieldErrors.value.focus" class="md:col-span-2" />
        <UTextarea v-model="form.data" label="D 資料（主客觀資料）" :rows="2" :error="save.fieldErrors.value.data" />
        <UTextarea v-model="form.action" label="A 措施" :rows="2" />
        <UTextarea v-model="form.response" label="R 反應（可稍後補記）" :rows="2" class="md:col-span-2" />
      </div>
      <div class="mt-2 text-right"><UButton size="sm" :loading="save.pending.value" @click="submit">儲存護理紀錄</UButton></div>
    </div>

    <UQueryState :loading="loading && !notes" :ready="!!notes?.length" empty-title="尚無護理紀錄">
      <article v-for="n in notes" :key="n.id" class="mb-3 rounded-md border border-slate-200 p-3 text-sm last:mb-0">
        <header class="mb-1.5 flex items-center gap-2 text-xs text-slate-500">
          <span class="tabular font-medium text-slate-700">{{ n.at }}</span>
          <span class="rounded bg-brand-50 px-1.5 py-0.5 font-semibold text-brand-700">{{ n.focus }}</span>
          <span class="ml-auto">{{ n.nurseName }}</span>
        </header>
        <dl class="grid gap-1">
          <div v-for="[k, v] in [['D', n.data], ['A', n.action]]" :key="k" class="flex gap-2">
            <dt class="w-4 font-bold text-brand-700">{{ k }}</dt><dd class="text-slate-700">{{ v || '—' }}</dd>
          </div>
          <div class="flex items-start gap-2">
            <dt class="w-4 font-bold text-brand-700">R</dt>
            <dd v-if="n.response" class="text-slate-700">
              {{ n.response }}<span v-if="n.respondedAt" class="tabular ml-2 text-xs text-slate-400">{{ n.respondedAt.slice(5) }} 補記</span>
            </dd>
            <!-- 尚未有反應：就地補記 -->
            <dd v-else class="flex flex-1 gap-2">
              <input v-model="drafts[n.id]" class="form-control h-7 flex-1 text-sm" placeholder="尚未記錄反應，例：一小時後複測體溫 37.4°C" @keydown.enter="respond(n.id)" />
              <UButton size="sm" variant="secondary" :loading="respondAction.pending.value" @click="respond(n.id)">補記</UButton>
            </dd>
          </div>
        </dl>
      </article>
    </UQueryState>
  </div>
</template>
