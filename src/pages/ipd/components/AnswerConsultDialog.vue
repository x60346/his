<script setup lang="ts">
// 回覆會診（會診科醫師）：看會診單附上的病人摘要（不是整份病歷），寫評估與建議；可以「建議轉入本科」。
// 會診範圍內（待回覆，或我回覆後 72 小時內）可以「開醫囑」（同一個開醫囑對話框、同樣的劑量與重複檢查），
// 只能停止自己開的；已回覆的打開是「會診追蹤」：看回覆、開醫囑，不能再回覆。誰能寫由服務層 care-team 把關。
import { computed, reactive, ref, watch } from 'vue'
import { Plus } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UTextarea } from '@/components/ui'
import OrderDialog from './OrderDialog.vue'
import { consultApi, ipdApi, type IncomingConsult } from '@/services'
import { useAction } from '@/composables/useService'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'

const props = defineProps<{ item: IncomingConsult | null }>()
const emit = defineEmits<{ close: [] }>()
const auth = useAuth()
const ui = useUi()
const form = reactive({ findings: '', recommendation: '', suggestTransfer: false })
const answered = computed(() => props.item?.consult.status === 'answered')
const orderOpen = ref(false)
const stop = useAction(ipdApi.stopOrder, { success: (o) => `已停止 ${o.content}` })
async function onStop(o: IncomingConsult['summary']['orders'][number]) {
  if (await ui.confirm({ title: '停止醫囑', message: `停止「${o.content}」？之後尚未執行的給藥一併取消。`, okText: '停止', danger: true })) await stop.run(o.id)
}
const save = useAction(consultApi.answerConsult, { success: (c) => `已回覆 ${c.fromDeptName} 的會診${c.suggestTransfer ? '（建議轉本科）' : ''}` })
// 換了一張會診單才清表單（開醫囑後清單重新查詢，同一張單不能把寫到一半的回覆洗掉）
watch(
  () => props.item?.consult.id,
  (v) => {
    if (!v) return
    Object.assign(form, { findings: '', recommendation: '', suggestTransfer: false })
    save.fieldErrors.value = {}
  },
  { immediate: true },
)
async function submit() {
  if (props.item && (await save.run(props.item.consult.id, { ...form }))) emit('close')
}
</script>

<template>
  <UDialog :model-value="!!item" :title="`${answered ? '會診追蹤' : '回覆會診'}：${item?.summary.admission.patientName ?? ''}`" size="lg" @update:model-value="(v: boolean) => !v && emit('close')">
    <div v-if="item" class="space-y-3 text-sm">
      <div class="rounded-md bg-amber-50 px-3 py-2">
        <div class="flex flex-wrap items-center gap-2 font-medium text-slate-800">
          {{ item.consult.fromDeptName }} {{ item.consult.fromDoctorName }} → {{ item.consult.toDeptName }}<template v-if="item.consult.toDoctorName">（指定 {{ item.consult.toDoctorName }}）</template>
          <UBadge v-if="item.consult.urgent" tone="red">急會診</UBadge>
          <span class="text-xs font-normal text-slate-500">{{ item.consult.requestedAt.slice(5) }} 申請<template v-if="!answered">・已等 {{ item.consult.waitingHours }} 小時</template></span>
        </div>
        <div class="mt-1 text-slate-800">{{ item.consult.question }}</div>
      </div>
      <!-- 病人摘要：會診醫師不是主治，看這份就夠 -->
      <section class="space-y-1 rounded-md border border-slate-200 px-3 py-2">
        <div class="font-medium text-slate-800">
          {{ item.summary.admission.bed?.bedNo }} {{ item.summary.admission.patientName }}（{{ item.summary.admission.gender === 'M' ? '男' : '女' }}・{{ item.summary.admission.age }} 歲）・{{ item.summary.admission.diagnosis }}・第 {{ item.summary.admission.days }} 天
        </div>
        <div v-if="item.summary.allergies.length" class="text-xs text-red-700">過敏：{{ item.summary.allergies.join('、') }}</div>
        <div v-if="item.summary.latestVital" class="tabular text-xs text-slate-600">生命徵象（{{ item.summary.latestVital.at.slice(5) }}）：{{ item.summary.latestVital.text }}</div>
        <div v-if="item.summary.latestNote" class="text-xs text-slate-600">最近病程（{{ item.summary.latestNote.at.slice(5) }} {{ item.summary.latestNote.doctorName }}）：A {{ item.summary.latestNote.assessment }}／P {{ item.summary.latestNote.plan }}</div>
        <div class="text-xs text-slate-600">
          執行中醫囑：<template v-if="!item.summary.orders.length">無</template>
          <span v-for="(o, i) in item.summary.orders" :key="o.id"><template v-if="i">、</template>{{ o.content }}<template v-if="o.category === 'medication'">（{{ o.dose }} {{ o.unit }} {{ o.freq }}）</template><UBadge v-if="o.consultLabel" tone="purple" class="ml-0.5">會診</UBadge><button v-if="item.canOrder && o.doctorId === auth.user?.doctorId" type="button" class="ml-1 text-red-600 hover:underline" @click="onStop(o)">停止</button></span>
        </div>
        <div v-if="item.canOrder" class="flex items-center gap-2 pt-1">
          <UButton size="sm" variant="secondary" :icon="Plus" @click="orderOpen = true">開醫囑</UButton>
          <span class="text-xs text-slate-500">會診醫師開的醫囑標「會診」，主治要按已閱；只能停止自己開的。回覆後 72 小時內都能開</span>
        </div>
      </section>
      <section v-if="answered" class="space-y-1 rounded-md border border-emerald-200 bg-emerald-50/50 px-3 py-2 text-sm">
        <div class="text-xs text-slate-500">{{ item.consult.answeredAt?.slice(5) }} {{ item.consult.answeredByName }} 回覆</div>
        <div><b>評估：</b>{{ item.consult.findings }}</div>
        <div><b>建議：</b>{{ item.consult.recommendation }}</div>
      </section>
      <template v-else>
      <UTextarea v-model="form.findings" label="評估（看診所見）" required :rows="3" :error="save.fieldErrors.value.findings" />
      <UTextarea v-model="form.recommendation" label="建議" required :rows="2" placeholder="例：續用目前抗生素；三天後未改善請再會診" :error="save.fieldErrors.value.recommendation" />
      <UCheckbox v-model="form.suggestTransfer" :label="`建議轉入${item.consult.toDeptName}（原科可一鍵申請轉科）`" />
      </template>
    </div>
    <template #footer>
      <UButton variant="secondary" @click="emit('close')">{{ answered ? '關閉' : '取消' }}</UButton>
      <UButton v-if="!answered" :loading="save.pending.value" @click="submit">送出回覆</UButton>
    </template>
  </UDialog>
  <OrderDialog v-if="item" v-model="orderOpen" :admission="item.summary.admission" />
</template>
