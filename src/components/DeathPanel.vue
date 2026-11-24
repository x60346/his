<script setup lang="ts">
// 死亡（住院醫囑與護理站的「死亡」分頁）：
//   醫師：宣告死亡（死因甲乙丙丁、死亡方式、住院經過；急救以宣告死亡結束的，時間帶急救結束時間）→ 開死亡證明書
//   護理師：遺體護理檢核 → 送太平間（＝出院、床位釋放；帳單之後由家屬結）
import { computed, reactive, ref } from 'vue'
import { Printer } from 'lucide-vue-next'
import { UBadge, UButton, UCheckbox, UDialog, UInput, USelect, UTextarea } from '@/components/ui'
import { BODY_CARE_ITEMS, CAUSE_LABELS, DEATH_MANNERS, deathApi, needsProsecutor } from '@/services'
import type { BodyCareKey, DeathManner } from '@/types'
import { useAction, useQuery } from '@/composables/useService'
import DeathCertificatePrint from './DeathCertificatePrint.vue'

const props = defineProps<{ admissionId: string }>()
const emit = defineEmits<{ changed: [] }>()
const { data, reload } = useQuery(() => deathApi.patientDeath(props.admissionId), [() => props.admissionId])
const v = computed(() => (data.value?.admissionId === props.admissionId ? data.value : undefined))
const d = computed(() => v.value?.death)
const hm = (s?: string) => s?.slice(5, 16).replace('-', '/') ?? ''

// 宣告
const decOpen = ref(false)
const f = reactive({ causes: ['', '', '', ''], other: '', manner: 'natural' as DeathManner | '', course: '' })
function openDeclare() {
  Object.assign(f, { causes: ['', '', '', ''], other: '', manner: 'natural', course: '' })
  decAct.fieldErrors.value = {}
  decOpen.value = true
}
const decAct = useAction(deathApi.declareDeath, { success: '已宣告死亡：醫囑已停止、出院病摘已帶入' })
async function declare() {
  if (await decAct.run(props.admissionId, { causes: [...f.causes], other: f.other, manner: f.manner as DeathManner, course: f.course, ...(v.value?.fromCode ? { codeBlueId: v.value.fromCode.id } : {}) })) {
    decOpen.value = false
    reload()
    emit('changed')
  }
}
// 遺體護理
const careOpen = ref(false)
const care = reactive({ items: [] as BodyCareKey[], valuables: '' })
const toggle = (k: BodyCareKey, on: boolean) => (care.items = on ? [...care.items, k] : care.items.filter((x) => x !== k))
const careAct = useAction(deathApi.recordBodyCare, { success: '已記錄遺體護理' })
async function saveCare() {
  if (await careAct.run(props.admissionId, { items: care.items, valuables: care.valuables })) {
    careOpen.value = false
    reload()
  }
}
// 證明書
const copies = ref(3)
const certAct = useAction(deathApi.issueDeathCertificate, { success: (x) => `已開立 ${x.cert?.no}` })
async function issue() {
  if (await certAct.run(props.admissionId, { copies: Number(copies.value) })) reload()
}
const printing = ref(false)
const printAct = useAction(deathApi.printDeathCertificate)
async function openPrint() {
  if (await printAct.run(props.admissionId)) {
    reload()
    printing.value = true
  }
}
const print = () => window.print()
// 送太平間
const morgueOpen = ref(false)
const morgueAct = useAction(deathApi.sendToMorgue, { success: '已送太平間（死亡出院）：帳單待家屬到櫃台結帳' })
async function morgue() {
  if (await morgueAct.run(props.admissionId)) {
    morgueOpen.value = false
    reload()
    emit('changed')
  }
}
</script>

<template>
  <div v-if="v" class="space-y-4 p-4 text-sm">
    <template v-if="!d">
      <p v-if="v.codeActive" class="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-800">急救進行中：請在「急救」分頁結束（宣告死亡）。</p>
      <p v-else-if="v.fromCode" class="rounded-md border border-slate-300 bg-slate-50 px-3 py-2">急救在 {{ hm(v.fromCode.endedAt) }} 以「宣告死亡」結束：請寫死亡紀錄（死亡時間帶急救結束時間）。</p>
      <div class="flex flex-wrap items-center gap-2">
        <UBadge :tone="v.expected ? 'gray' : 'yellow'">{{ v.expected ? '預期死亡（有 DNR 或安寧收案）' : '非預期（沒有 DNR）：宣告後列入死亡病例審查' }}</UBadge>
        <UButton v-if="v.canDeclare" class="ml-auto" variant="danger" @click="openDeclare">宣告死亡</UButton>
      </div>
      <p class="text-xs text-slate-500">宣告後：醫囑全部停止、出院病摘帶入（出院類別「死亡」）；護理師做遺體護理、醫師開死亡證明書後，送太平間（出院、床位釋放），帳單之後由家屬結。</p>
    </template>

    <template v-else>
      <section class="rounded-md border border-slate-300 p-3">
        <div class="flex flex-wrap items-center gap-2">
          <b class="text-slate-800">{{ hm(d.declaredAt) }} 宣告死亡</b>
          <span class="text-xs text-slate-500">{{ d.declaredByName }}</span>
          <UBadge :tone="d.expected ? 'gray' : 'yellow'">{{ d.expected ? '預期死亡' : '非預期死亡' }}</UBadge>
          <UBadge v-if="d.morgueAt" tone="gray">{{ hm(d.morgueAt) }} 已送太平間（{{ d.morgueByName }}）</UBadge>
        </div>
        <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <template v-for="c in d.causesText" :key="c.label"><dt class="text-xs text-slate-500">{{ c.label }}</dt><dd>{{ c.text }}</dd></template>
          <template v-if="d.other"><dt class="text-xs text-slate-500">其他影響疾病</dt><dd>{{ d.other }}</dd></template>
          <dt class="text-xs text-slate-500">死亡方式</dt><dd>{{ d.mannerLabel }}</dd>
          <dt class="text-xs text-slate-500">住院經過</dt><dd class="whitespace-pre-line">{{ d.course }}</dd>
        </dl>
      </section>
      <!-- 遺體護理 -->
      <section class="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 p-3">
        <span class="font-semibold text-slate-700">遺體護理</span>
        <template v-if="d.care"><UBadge tone="green">{{ hm(d.care.at) }} {{ d.careByName }}</UBadge><span class="text-xs text-slate-600">點交：{{ d.care.valuables }}</span></template>
        <UBadge v-else tone="yellow">還沒做</UBadge>
        <UButton v-if="v.canCare" class="ml-auto" size="sm" @click="care.items = []; care.valuables = ''; careAct.fieldErrors.value = {}; careOpen = true">記錄遺體護理</UButton>
      </section>
      <!-- 死亡證明書 -->
      <section class="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 p-3">
        <span class="font-semibold text-slate-700">死亡證明書</span>
        <template v-if="d.cert">
          <UBadge tone="green">{{ d.cert.no }}・{{ d.cert.copies }} 份</UBadge>
          <UBadge v-if="d.cert.printed?.length" tone="gray">已印 {{ d.cert.printed.length }} 次</UBadge>
          <UButton class="ml-auto" size="sm" variant="secondary" :icon="Printer" :loading="printAct.pending.value" @click="openPrint">列印</UButton>
        </template>
        <UBadge v-else-if="needsProsecutor(d.manner)" tone="red">非自然死：報請檢察官相驗（醫院不開）</UBadge>
        <template v-else>
          <UBadge tone="yellow">還沒開</UBadge>
          <template v-if="v.canCert">
            <div class="ml-auto w-24"><UInput v-model="copies" type="number" label="份數" :error="certAct.fieldErrors.value.copies" /></div>
            <UButton size="sm" :loading="certAct.pending.value" @click="issue">開立</UButton>
          </template>
        </template>
      </section>
      <!-- 送太平間 -->
      <section v-if="!d.morgueAt" class="flex flex-wrap items-center gap-2">
        <UButton v-if="v.canMorgue" @click="morgueOpen = true">送太平間</UButton>
        <span v-else-if="v.morgueBlocked" class="text-xs text-amber-800">送太平間前：{{ v.morgueBlocked }}</span>
      </section>
    </template>

    <UDialog v-model="decOpen" title="宣告死亡" @submit="declare">
      <div class="space-y-2">
        <p v-if="v.fromCode" class="text-xs text-slate-600">死亡時間：{{ v.fromCode.endedAt?.slice(5).replace('-', '/') }}（急救結束）</p>
        <p v-else class="text-xs text-slate-600">死亡時間記為現在。</p>
        <UInput v-for="(lbl, i) in CAUSE_LABELS" :key="lbl" v-model="f.causes[i]" :label="lbl" :required="i === 0" :error="decAct.fieldErrors.value[`cause${i}`]" :placeholder="i === 0 ? '例：敗血性休克' : ''" />
        <UInput v-model="f.other" label="其他對死亡有影響之疾病（選填）" />
        <USelect v-model="f.manner" label="死亡方式" :options="DEATH_MANNERS.map((m) => ({ label: m.label, value: m.key }))" :error="decAct.fieldErrors.value.manner" />
        <p v-if="needsProsecutor(f.manner as DeathManner)" class="text-xs text-red-700">非自然死要報請檢察官相驗：醫院不開死亡證明書。</p>
        <UTextarea v-model="f.course" label="住院經過（帶入出院病摘）" :rows="3" required :error="decAct.fieldErrors.value.course" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="decOpen = false">取消</UButton>
        <UButton type="submit" variant="danger" :loading="decAct.pending.value">宣告死亡</UButton>
      </template>
    </UDialog>
    <UDialog v-model="careOpen" title="遺體護理" size="sm" @submit="saveCare">
      <div class="space-y-2">
        <UCheckbox v-for="it in BODY_CARE_ITEMS" :key="it.key" :model-value="care.items.includes(it.key)" :label="it.label" @update:model-value="(x: boolean) => toggle(it.key, x)" />
        <p v-if="careAct.fieldErrors.value.items" class="text-xs text-red-600">{{ careAct.fieldErrors.value.items }}</p>
        <UInput v-model="care.valuables" label="點交家屬的貴重物品" placeholder="例：手機、戒指一枚、現金 1,200 元（沒有寫「無」）" :error="careAct.fieldErrors.value.valuables" />
      </div>
      <template #footer>
        <UButton variant="secondary" @click="careOpen = false">取消</UButton>
        <UButton type="submit" :loading="careAct.pending.value">完成</UButton>
      </template>
    </UDialog>
    <UDialog v-model="morgueOpen" title="送太平間" size="sm" @submit="morgue">
      <p class="text-sm text-slate-700">送出後辦理死亡出院：床位釋放、管路記移除。帳單之後由家屬在櫃台結（住院結帳清單標「死亡出院」）。</p>
      <template #footer>
        <UButton variant="secondary" @click="morgueOpen = false">取消</UButton>
        <UButton type="submit" :loading="morgueAct.pending.value">送太平間</UButton>
      </template>
    </UDialog>
    <UDialog v-model="printing" title="死亡證明書" size="lg">
      <DeathCertificatePrint v-if="d?.cert" :d="d" />
      <template #footer>
        <UButton variant="secondary" @click="printing = false">關閉</UButton>
        <UButton :icon="Printer" @click="print">列印</UButton>
      </template>
    </UDialog>
  </div>
</template>
