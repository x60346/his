<script setup lang="ts">
// 住院中心：病床圖 + 待報到清單。
// 畫面有三種模式：
//   idle     一般瀏覽，點床看資訊（使用中→住院資訊、清潔中→清潔完成、空床→保留）
//   checkin  報到：先選病人，再點一張可用的空床
//   transfer 轉床：從住院資訊進入，再點一張可用的空床
import { computed, ref } from 'vue'
import { ArrowRightLeft, CalendarPlus, DoorOpen, LogOut, Sparkles, X } from 'lucide-vue-next'
import { UBadge, UButton, UCard, UDialog, UQueryState, UTabs } from '@/components/ui'
import BedCard from './components/BedCard.vue'
import ReserveDialog from './components/ReserveDialog.vue'
import DischargeDialog from './components/DischargeDialog.vue'
import { admissionApi, masterApi, type AdmissionView } from '@/services'
import type { BedView } from '@/services/admission'
import { useAction, useQuery } from '@/composables/useService'
import { useUi } from '@/stores/ui'
import { today } from '@/utils/date'
import { bedStatus } from '@/utils/labels'
import type { BedStatus } from '@/types'

const ui = useUi()

// ---------- 資料 ----------
const { data: beds, loading: bedsLoading } = useQuery(() => admissionApi.listBeds())
const { data: reservations } = useQuery(() => admissionApi.listAdmissions({ status: ['reserved'] }))
const { data: doctors } = useQuery(() => masterApi.listDoctors(undefined, true))
const doctorName = (id?: string) => doctors.value?.find((d) => d.id === id)?.name ?? ''

const wards = masterApi.staticCodes.wards
const ward = ref(wards[0])
const wardTabs = computed(() =>
  wards.map((w) => {
    const list = (beds.value ?? []).filter((b) => b.ward === w)
    return { key: w, label: w, count: list.filter((b) => b.status === 'empty').length }
  }),
)
/** 依房號分組，同一房的床放在一起 */
const rooms = computed(() => {
  const map = new Map<string, BedView[]>()
  for (const b of (beds.value ?? []).filter((x) => x.ward === ward.value)) map.set(b.roomNo, [...(map.get(b.roomNo) ?? []), b])
  return [...map.entries()].map(([roomNo, list]) => ({ roomNo, beds: list.sort((a, b) => a.bedNo.localeCompare(b.bedNo)) }))
})
const legend: BedStatus[] = ['empty', 'occupied', 'cleaning', 'reserved']
const sortedReservations = computed(() => [...(reservations.value ?? [])].sort((a, b) => a.expectedDate.localeCompare(b.expectedDate)))

// ---------- 模式 ----------
type Mode = 'idle' | 'checkin' | 'transfer'
const mode = ref<Mode>('idle')
const target = ref<AdmissionView>()
const selectedBedId = ref<string>()
const selectedBed = computed(() => beds.value?.find((b) => b.id === selectedBedId.value))

const picking = computed(() => mode.value !== 'idle')
const isPickable = (b: BedView) => picking.value && b.status === 'empty'
const isPreferred = (b: BedView) => mode.value === 'checkin' && b.bedClass === target.value?.preferBedClass

function startCheckIn(a: AdmissionView) {
  mode.value = 'checkin'
  target.value = a
  selectedBedId.value = undefined
  // 自動切到第一個有「符合床等空床」的病房，省去逐一翻找
  const w = wards.find((x) => beds.value?.some((b) => b.ward === x && b.status === 'empty' && b.bedClass === a.preferBedClass))
  if (w) ward.value = w
}
function startTransfer() {
  if (!occupied.value) return
  mode.value = 'transfer'
  target.value = occupied.value
}
function cancelMode() {
  mode.value = 'idle'
  target.value = undefined
}

// ---------- 點床 ----------
const confirmOpen = ref(false)
const pendingBed = ref<BedView>()
function onBedClick(b: BedView) {
  if (picking.value) {
    if (!isPickable(b)) return ui.toast.warning(`${b.bedNo} 目前${bedStatus[b.status].label}，請選擇空床`)
    pendingBed.value = b
    confirmOpen.value = true
    return
  }
  selectedBedId.value = b.id
}

const checkIn = useAction(admissionApi.checkIn, { success: (a) => `${a.patientName} 已報到，住院號 ${a.admitNo}，床位 ${a.bed?.bedNo}` })
const transfer = useAction(admissionApi.transferBed, { success: (a) => `${a.patientName} 已轉至 ${a.bed?.bedNo}，原床位改為清潔中` })
async function confirmBed() {
  if (!target.value || !pendingBed.value) return
  const fn = mode.value === 'checkin' ? checkIn : transfer
  const a = await fn.run(target.value.id, pendingBed.value.id)
  if (a) {
    confirmOpen.value = false
    selectedBedId.value = pendingBed.value.id
    cancelMode()
  }
}

// ---------- 使用中病床的住院資訊 ----------
const { data: occData } = useQuery(
  async () => (selectedBed.value?.status === 'occupied' && selectedBed.value.admissionId ? admissionApi.getAdmission(selectedBed.value.admissionId) : undefined),
  [() => selectedBed.value?.admissionId, () => selectedBed.value?.status],
)
// 切換到另一張床時，新資料回來前不可顯示上一位病人的資料（顯示錯病人是醫療系統最危險的錯誤之一）
const occupied = computed(() => (occData.value && occData.value.id === selectedBed.value?.admissionId ? occData.value : undefined))
const dischargeOpen = ref(false)

// ---------- 病床狀態、預約 ----------
const setStatus = useAction(admissionApi.setBedStatus, { success: (b) => `${b.bedNo} 已改為${bedStatus[b.status].label}` })
const cancelReserve = useAction(admissionApi.cancelReservation, { success: '已取消住院預約' })
async function onCancelReserve(a: AdmissionView) {
  if (await ui.confirm({ title: '取消住院預約', message: `確定取消 ${a.patientName} 的住院預約？`, okText: '取消預約', cancelText: '保留預約', danger: true })) cancelReserve.run(a.id)
}
const reserveOpen = ref(false)
</script>

<template>
  <div class="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_22rem]">
    <!-- 病床圖 -->
    <UCard :padded="false">
      <template #title>
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-sm font-semibold text-slate-800">病床配置</span>
          <span v-for="s in legend" :key="s" class="flex items-center gap-1 text-xs text-slate-500">
            <span :class="['h-3 w-3 rounded-sm border-2', { empty: 'border-emerald-300 bg-emerald-50', occupied: 'border-blue-300 bg-blue-50', cleaning: 'border-slate-300 bg-slate-100', reserved: 'border-amber-300 bg-amber-50' }[s]]" />
            {{ bedStatus[s].label }}
          </span>
        </div>
      </template>
      <div class="px-4"><UTabs v-model="ward" :tabs="wardTabs.map((t) => ({ ...t, label: `${t.label}・空床` }))" /></div>

      <!-- 選床模式提示 -->
      <div v-if="picking && target" class="mx-4 mt-3 flex items-center gap-3 rounded-md border border-brand-300 bg-brand-50 px-3 py-2 text-sm text-brand-900">
        <span>
          {{ mode === 'checkin' ? '報到' : '轉床' }}：<b>{{ target.patientName }}</b>
          <template v-if="mode === 'checkin'">・希望 {{ target.preferBedClass }}（亮綠框為符合床等的空床）</template>
          <template v-else>・目前 {{ target.bed?.bedNo }}</template>
          ，請點選一張空床
        </span>
        <UButton class="ml-auto" size="sm" variant="ghost" :icon="X" @click="cancelMode">結束選床</UButton>
      </div>

      <UQueryState :loading="bedsLoading" :ready="rooms.length > 0" empty-title="此病房沒有病床">
        <div class="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 2xl:grid-cols-3">
          <section v-for="r in rooms" :key="r.roomNo" class="rounded-lg border border-slate-200 p-2">
            <div class="mb-1.5 flex justify-between px-1 text-xs text-slate-500">
              <span class="font-medium">{{ r.roomNo }} 房</span><span>{{ r.beds[0].bedClass }}<template v-if="r.beds[0].extraFee">・差額 ${{ r.beds[0].extraFee }}/日</template></span>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <BedCard
                v-for="b in r.beds"
                :key="b.id"
                :bed="b"
                :doctor-name="doctorName(b.admission?.doctorId)"
                :selected="!picking && b.id === selectedBedId"
                :pickable="isPickable(b)"
                :preferred="isPreferred(b)"
                :dimmed="picking && !isPickable(b)"
                @click="onBedClick(b)"
              />
            </div>
          </section>
        </div>
      </UQueryState>
    </UCard>

    <!-- 右側：選取的床 + 待報到 -->
    <div class="space-y-4">
      <UCard v-if="selectedBed && !picking" :title="`${selectedBed.bedNo}・${bedStatus[selectedBed.status].label}`" :subtitle="`${selectedBed.ward}・${selectedBed.bedClass}`">
        <template v-if="selectedBed.status === 'occupied'">
          <UQueryState :loading="!occupied" :ready="!!occupied">
            <dl v-if="occupied" class="space-y-1.5 text-sm">
              <div class="flex gap-2"><dt class="w-16 text-slate-500">病人</dt><dd class="font-medium">{{ occupied.patientName }}（{{ occupied.chartNo }}）</dd></div>
              <div class="flex gap-2"><dt class="w-16 text-slate-500">住院號</dt><dd class="tabular">{{ occupied.admitNo }}</dd></div>
              <div class="flex gap-2"><dt class="w-16 text-slate-500">診斷</dt><dd>{{ occupied.diagnosis }}</dd></div>
              <div class="flex gap-2"><dt class="w-16 text-slate-500">主治</dt><dd>{{ occupied.deptName }}・{{ occupied.doctorName }}</dd></div>
              <div class="flex gap-2"><dt class="w-16 text-slate-500">入院</dt><dd class="tabular">{{ occupied.admittedAt }}（第 {{ occupied.days }} 天）</dd></div>
              <div v-if="occupied.allergies.length" class="flex gap-2"><dt class="w-16 text-slate-500">過敏</dt><dd class="font-medium text-red-600">{{ occupied.allergies.join('、') }}</dd></div>
            </dl>
            <div class="mt-4 flex gap-2">
              <UButton size="sm" variant="secondary" :icon="ArrowRightLeft" @click="startTransfer">轉床</UButton>
              <UButton size="sm" variant="danger" :icon="LogOut" @click="dischargeOpen = true">辦理出院</UButton>
            </div>
          </UQueryState>
        </template>
        <template v-else-if="selectedBed.status === 'cleaning'">
          <p class="mb-3 text-sm text-slate-600">病人出院或轉床後，病床需清潔消毒才能再使用。</p>
          <UButton size="sm" variant="success" :icon="Sparkles" :loading="setStatus.pending.value" @click="setStatus.run(selectedBed.id, 'empty')">清潔完成</UButton>
        </template>
        <template v-else-if="selectedBed.status === 'empty'">
          <p class="mb-3 text-sm text-slate-600">空床可直接用於報到；若預留給特定病人，可先設為保留。</p>
          <UButton size="sm" variant="secondary" :loading="setStatus.pending.value" @click="setStatus.run(selectedBed.id, 'reserved')">設為保留</UButton>
        </template>
        <template v-else>
          <UButton size="sm" variant="secondary" :loading="setStatus.pending.value" @click="setStatus.run(selectedBed.id, 'empty')">取消保留</UButton>
        </template>
      </UCard>

      <UCard title="待報到" :subtitle="`共 ${reservations?.length ?? 0} 位`" :padded="false">
        <template #actions><UButton size="sm" variant="secondary" :icon="CalendarPlus" @click="reserveOpen = true">新增預約</UButton></template>
        <UQueryState :loading="!reservations" :ready="sortedReservations.length > 0" empty-title="目前沒有待報到的住院預約">
          <ul class="divide-y divide-slate-100">
            <li v-for="a in sortedReservations" :key="a.id" :class="['px-4 py-3 text-sm', target?.id === a.id && 'bg-brand-50']">
              <div class="flex items-center gap-2">
                <span class="font-semibold text-slate-800">{{ a.patientName }}</span>
                <span class="tabular text-xs text-slate-500">{{ a.chartNo }}</span>
                <UBadge v-if="a.fromVisitId" tone="purple">門診轉入</UBadge>
                <UBadge :tone="a.expectedDate <= today() ? 'red' : 'gray'" class="ml-auto">{{ a.expectedDate <= today() ? '今日' : a.expectedDate.slice(5) }}</UBadge>
              </div>
              <div class="mt-0.5 text-xs text-slate-600">{{ a.diagnosis }}</div>
              <div class="text-xs text-slate-500">{{ a.deptName }}・{{ a.doctorName }}・希望 {{ a.preferBedClass }}</div>
              <div class="mt-2 flex gap-2">
                <UButton size="sm" :icon="DoorOpen" :disabled="mode === 'checkin' && target?.id === a.id" @click="startCheckIn(a)">報到配床</UButton>
                <UButton size="sm" variant="ghost" @click="onCancelReserve(a)">取消預約</UButton>
              </div>
            </li>
          </ul>
        </UQueryState>
      </UCard>
    </div>

    <UDialog v-model="confirmOpen" :title="mode === 'checkin' ? '確認報到' : '確認轉床'" size="sm">
      <p class="text-sm text-slate-700">
        <template v-if="mode === 'checkin'">{{ target?.patientName }} 報到入住 <b>{{ pendingBed?.bedNo }}</b>（{{ pendingBed?.bedClass }}）？</template>
        <template v-else>{{ target?.patientName }} 由 {{ target?.bed?.bedNo }} 轉至 <b>{{ pendingBed?.bedNo }}</b>？原床位將改為清潔中。</template>
      </p>
      <p v-if="mode === 'checkin' && pendingBed && pendingBed.bedClass !== target?.preferBedClass" class="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
        注意：與病人希望的 {{ target?.preferBedClass }} 不同。
      </p>
      <template #footer>
        <UButton variant="secondary" @click="confirmOpen = false">取消</UButton>
        <UButton :loading="checkIn.pending.value || transfer.pending.value" @click="confirmBed">確認</UButton>
      </template>
    </UDialog>

    <ReserveDialog v-model="reserveOpen" />
    <DischargeDialog v-model="dischargeOpen" :admission="occupied" />
  </div>
</template>
