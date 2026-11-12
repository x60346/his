// 組套（常用處方）：存下常用的「診斷＋藥品＋處置」，看診時一鍵帶入。
// 兩種：醫師個人的（只有自己看得到）、科室共用的（同科在職醫師都能套用、修改、刪除，記下最後修改的人）。
// 套用時才逐項檢查是否已停用——組套可能是半年前存的，停用的藥不能就這樣帶進處方；
// 以前「複製處方」要到完成看診時才被擋下，醫師已經整張開好了才發現。
import type { Diagnosis, MedicationOrder, OrderSet, ProcedureOrder } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, fieldErrors, must, mutate, query, requireUser } from './http'
import { cleanRxTimings, find, nameOf, pickUsable } from './views'

function me(): { doctorId: string; deptId: string } {
  const u = requireUser('doctor')
  if (!u.doctorId) fail('此帳號沒有對應的醫師資料', 'FORBIDDEN')
  const d = must(find.doctor(u.doctorId), '醫師')
  return { doctorId: d.id, deptId: d.deptId }
}

/** 看得到（也就能改）：自己的個人組套，或目前所屬科別的科室組套。轉科後就看不到原科室的 */
const canUse = (s: OrderSet, m: { doctorId: string; deptId: string }) => (s.scope === 'dept' ? s.deptId === m.deptId : s.doctorId === m.doctorId)

function usableSet(id: string): OrderSet {
  const m = me()
  const s = must(db.orderSets.find((x) => x.id === id), '組套')
  if (!canUse(s, m)) fail(s.scope === 'dept' ? '這是別科的科室組套' : '這不是您的組套', 'FORBIDDEN')
  return s
}

const scopeText = (s: Pick<OrderSet, 'scope' | 'deptId'>) => (s.scope === 'dept' ? `${nameOf.dept(s.deptId)}科室組套` : '組套')

export interface OrderSetView extends OrderSet {
  /** 清單上的摘要：「J06.9・3 種藥・1 項處置」 */
  summary: string
  deptName?: string
  /** 最後修改的醫師（科室組套） */
  updatedByName?: string
}
const view = (s: OrderSet): OrderSetView => ({
  ...s,
  ...(s.scope === 'dept' ? { deptName: nameOf.dept(s.deptId), updatedByName: nameOf.doctor(s.updatedBy ?? s.doctorId) } : {}),
  summary: [s.diagnoses.map((d) => d.icd).join('、'), s.medications.length && `${s.medications.length} 種藥`, s.procedures.length && `${s.procedures.length} 項處置`].filter(Boolean).join('・'),
})

/** 我能用的組套：個人的在前、科室的在後，各自依名稱排序 */
export function listOrderSets(): Promise<OrderSetView[]> {
  return query(() => {
    const m = me()
    return db.orderSets
      .filter((s) => canUse(s, m))
      .sort((a, b) => (a.scope === 'dept') === (b.scope === 'dept') ? a.name.localeCompare(b.name) : a.scope === 'dept' ? 1 : -1)
      .map(view)
  })
}

/** 存成科室組套時顯示「存到內科」：目前所屬的科別 */
export function myOrderSetDept(): Promise<{ deptId: string; deptName: string }> {
  return query(() => {
    const m = me()
    return { deptId: m.deptId, deptName: nameOf.dept(m.deptId) }
  })
}

export interface OrderSetInput {
  name: string
  diagnoses: Diagnosis[]
  medications: MedicationOrder[]
  procedures: ProcedureOrder[]
  subjective?: string
  plan?: string
  /** 個人（預設）或科室共用 */
  scope?: OrderSet['scope']
  /** 已有同名組套時，醫師確認要覆蓋 */
  overwrite?: boolean
}

/**
 * 存成組套：同一範圍（我的個人組套／我這科的科室組套）同名時回 CONFLICT（頁面確認後帶 overwrite 重送）；
 * 個人與科室可以同名（選單分開列）。停用的藥、醫令、診斷不能存進去。
 */
export function saveOrderSet(input: OrderSetInput): Promise<OrderSetView> {
  return mutate(() => {
    const m = me()
    const doctorId = m.doctorId
    const scope = input.scope === 'dept' ? 'dept' : 'personal'
    const name = input.name?.trim() ?? ''
    const v = fieldErrors()
    if (!name) v.add('name', '請輸入組套名稱')
    else if (name.length > 20) v.add('name', '組套名稱最多 20 字')
    if (!input.diagnoses.length && !input.medications.length && !input.procedures.length) v.add('name', '目前沒有診斷、藥品或處置可以存')
    v.done()
    const inactive = [
      ...input.medications.map((m) => find.drug(m.drugId)).filter((d) => d && !d.active).map((d) => d!.name),
      ...input.procedures.map((p) => find.procedure(p.procId)).filter((p) => p && !p.active).map((p) => p!.name),
    ]
    if (inactive.length) fail(`${inactive.join('、')} 已停用，不能存進組套`)
    const existing = db.orderSets.find((s) => (s.scope ?? 'personal') === scope && canUse(s, m) && s.name === name)
    if (existing && !input.overwrite) {
      const who = scope === 'dept' ? `（最後由 ${nameOf.doctor(existing.updatedBy ?? existing.doctorId)} 修改）` : ''
      fail(`已有名為「${name}」的${scopeText(existing)}${who}`, 'CONFLICT', 'name')
    }
    const t = now()
    const medications = structuredClone(input.medications)
    cleanRxTimings(medications)
    const content = {
      diagnoses: structuredClone(input.diagnoses),
      medications,
      procedures: structuredClone(input.procedures),
      subjective: input.subjective?.trim() || undefined,
      plan: input.plan?.trim() || undefined,
    }
    let s: OrderSet
    if (existing) {
      s = Object.assign(existing, content, { updatedAt: t, updatedBy: doctorId })
      audit('更新組套', `${scopeText(s)}「${name}」`)
    } else {
      s = { id: newId('OS'), doctorId, scope, ...(scope === 'dept' ? { deptId: m.deptId } : {}), name, ...content, createdAt: t, updatedAt: t, updatedBy: doctorId }
      db.orderSets.push(s)
      audit('新增組套', `${scopeText(s)}「${name}」`)
    }
    return view(s)
  })
}

export function deleteOrderSet(id: string): Promise<void> {
  return mutate(() => {
    const s = usableSet(id)
    db.orderSets = db.orderSets.filter((x) => x.id !== s.id)
    audit('刪除組套', `${scopeText(s)}「${s.name}」`)
  })
}

/** 要帶進本次處方的內容（組套、同前次共用）：只有目前還能開立的項目，停用的列在 skipped */
export interface ExpandedOrders {
  diagnoses: Diagnosis[]
  medications: MedicationOrder[]
  procedures: ProcedureOrder[]
  subjective?: string
  assessment?: string
  plan?: string
  /** 已停用、沒有帶入的項目名稱 */
  skipped: string[]
}

export interface ExpandedOrderSet extends ExpandedOrders {
  name: string
}

/** 套用前展開：只回傳目前還能開立的項目，停用的列在 skipped（頁面告訴醫師哪些沒帶入） */
export function expandOrderSet(id: string): Promise<ExpandedOrderSet> {
  return query(() => {
    const s = usableSet(id)
    return { name: s.name, ...pickUsable(s), subjective: s.subjective, plan: s.plan }
  })
}
