// 事前審查的內部工具（index 不匯出、不會被包成 API）：找送審單、建送審單、給藥與登記植入物前的把關、帳單自費、申報檢核、首頁待辦
import type { Encounter, IpdOrder, PreAuth } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { fail } from './http'
import { opdPreAuthBlockText, opdPreAuthValid, preAuthAllows, preAuthBlockText, preAuthOverdue } from './preauth-rules'
import { find } from './views'

const live = (p: PreAuth) => p.status !== 'rejected'

/** 這次住院這個藥的送審單（不核准的不算） */
export const drugPreAuthOf = (admissionId: string, drugId: string) => db.preAuths.find((p) => p.kind === 'drug' && p.admissionId === admissionId && p.itemId === drugId && live(p))
export const implantPreAuthOf = (surgeryId: string, procId: string) => db.preAuths.find((p) => p.kind === 'implant' && p.surgeryId === surgeryId && p.itemId === procId && live(p))

function create(p: Omit<PreAuth, 'id' | 'no' | 'status' | 'notes'>): PreAuth {
  const d = p.createdAt.slice(0, 10).replace(/-/g, '')
  const x: PreAuth = { id: newId('PA'), no: `PA${d}${String(nextCounter(`preauth:${d}`)).padStart(3, '0')}`, status: 'draft', notes: [], ...p }
  db.preAuths.push(x)
  return x
}

/** 開立住院藥品醫囑：需事前審查的藥、這次住院還沒有送審單 → 自動建一張（待主治填寫） */
export function ensureDrugPreAuth(o: IpdOrder, t: string): PreAuth | undefined {
  const d = o.drugId ? find.drug(o.drugId) : undefined
  if (!d?.preAuth) return undefined
  const old = drugPreAuthOf(o.admissionId, d.id)
  if (old) return old
  const a = find.admission(o.admissionId)!
  return create({ kind: 'drug', itemId: d.id, itemName: d.name, patientId: a.patientId, admissionId: a.id, doctorId: a.doctorId, orderId: o.id, createdAt: t })
}

export function createOpdDrugPreAuth(input: { drugId: string; itemName: string; patientId: string; encounterId: string; doctorId: string; createdAt: string }): PreAuth {
  return create({ kind: 'drug', itemId: input.drugId, itemName: input.itemName, patientId: input.patientId, encounterId: input.encounterId, doctorId: input.doctorId, createdAt: input.createdAt })
}

export function createImplantPreAuth(input: { surgeryId: string; procId: string; patientId: string; admissionId: string; doctorId: string; itemName: string; createdAt: string }): PreAuth {
  return create({ kind: 'implant', itemId: input.procId, itemName: input.itemName, patientId: input.patientId, admissionId: input.admissionId, doctorId: input.doctorId, surgeryId: input.surgeryId, createdAt: input.createdAt })
}

/**
 * 門診：這個病人這個藥最新的送審單（不核准的、門診核准已過期的不算）。核准在效期內的優先
 */
export function opdDrugPreAuthOf(patientId: string, drugId: string, date: string): PreAuth | undefined {
  const xs = db.preAuths.filter((p) => p.kind === 'drug' && !p.admissionId && p.patientId === patientId && p.itemId === drugId && live(p)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return xs.find((p) => opdPreAuthValid(p, date)) ?? xs.find((p) => p.status !== 'approved')
}

/** 門診完成看診前：需事前審查的藥用健保開（沒勾自費、不是自費身分）要有效期內的核准 */
export function requireOpdDrugPreAuth(e: Pick<Encounter, 'patientId' | 'date' | 'medications'>, selfPayVisit: boolean) {
  if (selfPayVisit) return
  for (const m of e.medications.filter((x) => !x.selfPay)) {
    const d = find.drug(m.drugId)
    if (!d?.preAuth) continue
    const p = opdDrugPreAuthOf(e.patientId, d.id, e.date)
    if (!p || !opdPreAuthValid(p, e.date)) fail(opdPreAuthBlockText(d.name, p, e.date), 'CONFLICT')
  }
}

/** 給藥前：需事前審查的藥要核准（或自費、緊急）才能給 */
export function requireDrugPreAuth(o: IpdOrder) {
  const d = o.drugId ? find.drug(o.drugId) : undefined
  if (!d?.preAuth) return
  const p = drugPreAuthOf(o.admissionId, d.id)
  if (!p) fail(`${d.name} 需健保事前審查，還沒有送審單：請主治醫師申請`, 'CONFLICT')
  if (!preAuthAllows(p!)) fail(preAuthBlockText(p!), 'CONFLICT')
}
/** 登記植入物前：需事前審查的特殊材料 */
export function requireImplantPreAuth(surgeryId: string, procId: string) {
  const pr = find.procedure(procId)
  if (!pr?.preAuth) return
  const p = implantPreAuthOf(surgeryId, procId)
  if (!p) fail(`${pr.name} 需健保事前審查，這台還沒有申請：請主刀在病人「手術」分頁申請`, 'CONFLICT')
  if (!preAuthAllows(p!)) fail(preAuthBlockText(p!), 'CONFLICT')
}

/** 帳單：病人同意自費的（這次住院這個藥、這台這個植入物）照自費算 */
export const drugSelfPay = (admissionId: string, drugId: string) => !!db.preAuths.find((p) => p.kind === 'drug' && p.admissionId === admissionId && p.itemId === drugId && p.selfPay)
export const implantSelfPay = (surgeryId: string, procId: string) => !!db.preAuths.find((p) => p.kind === 'implant' && p.surgeryId === surgeryId && p.itemId === procId && p.selfPay)

/** 申報檢核：這次住院用了需事前審查的項目、沒核准也不是自費 */
export function preAuthUnapproved(admissionId: string): string[] {
  const out: string[] = []
  for (const p of db.preAuths.filter((x) => x.admissionId === admissionId && x.status !== 'approved' && !x.selfPay)) {
    const used = p.kind === 'drug' ? db.mar.some((m) => m.admissionId === admissionId && m.status === 'given' && db.ipdOrders.find((o) => o.id === m.orderId)?.drugId === p.itemId) : !!db.surgeries.find((s) => s.id === p.surgeryId)?.implants?.some((u) => db.implantLots.find((l) => l.id === u.lotId)?.procId === p.itemId)
    if (used) out.push(`${p.itemName}（${p.no}）`)
  }
  return out
}

/** 首頁：主治待填寫（含補件）；申報組待送審、審查中逾時 */
export function preAuthCounts(t: string, doctorId?: string) {
  return {
    toFill: doctorId ? db.preAuths.filter((p) => p.doctorId === doctorId && (p.status === 'draft' || p.status === 'more')).length : 0,
    toSubmit: db.preAuths.filter((p) => p.status === 'ready').length,
    overdue: db.preAuths.filter((p) => preAuthOverdue(p, t)).length,
  }
}
