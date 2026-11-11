// 醫師個人組套（常用處方）：存下常用的「診斷＋藥品＋處置」，看診時一鍵帶入。
// 套用時才逐項檢查是否已停用——組套可能是半年前存的，停用的藥不能就這樣帶進處方；
// 以前「複製處方」要到完成看診時才被擋下，醫師已經整張開好了才發現。
import type { Diagnosis, MedicationOrder, OrderSet, ProcedureOrder } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, fieldErrors, must, mutate, query, requireUser } from './http'
import { find } from './views'

function myDoctorId(): string {
  const u = requireUser('doctor')
  if (!u.doctorId) fail('此帳號沒有對應的醫師資料', 'FORBIDDEN')
  return u.doctorId
}

function mine(id: string): OrderSet {
  const doctorId = myDoctorId()
  const s = must(db.orderSets.find((x) => x.id === id), '組套')
  if (s.doctorId !== doctorId) fail('這不是您的組套', 'FORBIDDEN')
  return s
}

export interface OrderSetView extends OrderSet {
  /** 清單上的摘要：「J06.9・3 種藥・1 項處置」 */
  summary: string
}
const view = (s: OrderSet): OrderSetView => ({
  ...s,
  summary: [s.diagnoses.map((d) => d.icd).join('、'), s.medications.length && `${s.medications.length} 種藥`, s.procedures.length && `${s.procedures.length} 項處置`].filter(Boolean).join('・'),
})

/** 我的組套（依名稱排序） */
export function listOrderSets(): Promise<OrderSetView[]> {
  return query(() => {
    const doctorId = myDoctorId()
    return db.orderSets.filter((s) => s.doctorId === doctorId).sort((a, b) => a.name.localeCompare(b.name)).map(view)
  })
}

export interface OrderSetInput {
  name: string
  diagnoses: Diagnosis[]
  medications: MedicationOrder[]
  procedures: ProcedureOrder[]
  subjective?: string
  plan?: string
  /** 已有同名組套時，醫師確認要覆蓋 */
  overwrite?: boolean
}

/** 存成組套：同名時回 CONFLICT（頁面確認後帶 overwrite 重送）；停用的藥、醫令、診斷不能存進去 */
export function saveOrderSet(input: OrderSetInput): Promise<OrderSetView> {
  return mutate(() => {
    const doctorId = myDoctorId()
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
    const existing = db.orderSets.find((s) => s.doctorId === doctorId && s.name === name)
    if (existing && !input.overwrite) fail(`已有名為「${name}」的組套`, 'CONFLICT', 'name')
    const t = now()
    const content = {
      diagnoses: structuredClone(input.diagnoses),
      medications: structuredClone(input.medications),
      procedures: structuredClone(input.procedures),
      subjective: input.subjective?.trim() || undefined,
      plan: input.plan?.trim() || undefined,
    }
    let s: OrderSet
    if (existing) {
      s = Object.assign(existing, content, { updatedAt: t })
      audit('更新組套', name)
    } else {
      s = { id: newId('OS'), doctorId, name, ...content, createdAt: t, updatedAt: t }
      db.orderSets.push(s)
      audit('新增組套', name)
    }
    return view(s)
  })
}

export function deleteOrderSet(id: string): Promise<void> {
  return mutate(() => {
    const s = mine(id)
    db.orderSets = db.orderSets.filter((x) => x.id !== s.id)
    audit('刪除組套', s.name)
  })
}

export interface ExpandedOrderSet {
  name: string
  diagnoses: Diagnosis[]
  medications: MedicationOrder[]
  procedures: ProcedureOrder[]
  subjective?: string
  plan?: string
  /** 已停用、沒有帶入的項目名稱 */
  skipped: string[]
}

/** 套用前展開：只回傳目前還能開立的項目，停用的列在 skipped（頁面告訴醫師哪些沒帶入） */
export function expandOrderSet(id: string): Promise<ExpandedOrderSet> {
  return query(() => {
    const s = mine(id)
    const skipped: string[] = []
    const medications = s.medications.filter((m) => {
      const d = find.drug(m.drugId)
      if (d?.active) return true
      skipped.push(d?.name ?? m.drugId)
      return false
    })
    const procedures = s.procedures.filter((p) => {
      const pr = find.procedure(p.procId)
      if (pr?.active) return true
      skipped.push(pr?.name ?? p.procId)
      return false
    })
    const diagnoses = s.diagnoses.filter((d) => {
      const c = db.icdCodes.find((x) => x.code === d.icd)
      if (c && c.active !== false) return true
      skipped.push(`診斷 ${d.icd}`)
      return false
    })
    return { name: s.name, diagnoses: structuredClone(diagnoses), medications: structuredClone(medications), procedures: structuredClone(procedures), subjective: s.subjective, plan: s.plan, skipped }
  })
}
