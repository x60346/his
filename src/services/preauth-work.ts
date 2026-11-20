// 事前審查的內部工具（index 不匯出、不會被包成 API）：找送審單、建送審單、給藥與登記植入物前的把關、帳單自費、申報檢核、首頁待辦
import type { Encounter, IpdOrder, PreAuth } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { fail } from './http'
import { opdPreAuthBlockText, opdPreAuthLeft, opdIntervalWait, opdPreAuthTimesLeft, opdPreAuthUntil, opdPreAuthValid, opdRxQty, opdRxTimes, preAuthAllows, preAuthBlockText, preAuthOverdue } from './preauth-rules'
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

/**
 * 門診核准後已經健保開了多少（這個病人這個藥、核准日到效期內完成的看診與慢箋領藥，不算自費的、不算 exceptEncounterId）。
 * 慢箋原處方算整張（每次調劑同量 × 可調劑次數），之後的領藥不再重算
 */
export function opdPreAuthUsed(p: PreAuth, exceptEncounterId?: string): number {
  const from = p.result?.at.slice(0, 10) ?? ''
  const until = opdPreAuthUntil(p) ?? ''
  return db.encounters
    .filter((e) => e.patientId === p.patientId && e.status === 'completed' && e.id !== exceptEncounterId && e.date >= from && e.date <= until && !find.visit(e.visitId)?.refillOf)
    .reduce((n, e) => n + e.medications.filter((m) => m.drugId === p.itemId && !m.selfPay).reduce((k, m) => k + opdRxQty(m.qty, e.refillTimes), 0), 0)
}

/** 門診核准後已經健保開了幾次（同上的範圍；一張處方有這個藥就算，慢箋算可調劑次數） */
export function opdPreAuthUsedTimes(p: PreAuth, exceptEncounterId?: string): number {
  const from = p.result?.at.slice(0, 10) ?? ''
  const until = opdPreAuthUntil(p) ?? ''
  return db.encounters
    .filter((e) => e.patientId === p.patientId && e.status === 'completed' && e.id !== exceptEncounterId && e.date >= from && e.date <= until && !find.visit(e.visitId)?.refillOf && e.medications.some((m) => m.drugId === p.itemId && !m.selfPay))
    .reduce((n, e) => n + opdRxTimes(e.refillTimes), 0)
}

/** 這個病人這個藥某個月健保調劑了多少（看診與慢箋領藥都算，各算在自己那天；排除 exceptEncounterId） */
export function opdMonthQty(patientId: string, drugId: string, month: string, exceptEncounterId?: string): number {
  return db.encounters.filter((e) => e.patientId === patientId && e.status === 'completed' && e.id !== exceptEncounterId && e.date.startsWith(month)).reduce((n, e) => n + e.medications.filter((m) => m.drugId === drugId && !m.selfPay).reduce((k, m) => k + m.qty, 0), 0)
}

/** 這個病人這個藥上次健保開立（含慢箋領藥）是哪天（排除 exceptEncounterId） */
export function lastOpdNhiDate(patientId: string, drugId: string, exceptEncounterId?: string): string | undefined {
  return db.encounters.filter((e) => e.patientId === patientId && e.status === 'completed' && e.id !== exceptEncounterId && e.medications.some((m) => m.drugId === drugId && !m.selfPay)).map((e) => e.date).sort().at(-1)
}

/** 門診完成看診前：需事前審查的藥用健保開（沒勾自費、不是自費身分）要有效期內的核准，而且不超過核准量（慢箋算整張） */
export function requireOpdDrugPreAuth(e: Pick<Encounter, 'id' | 'patientId' | 'date' | 'medications' | 'refillTimes'>, selfPayVisit: boolean) {
  if (selfPayVisit) return
  for (const id of [...new Set(e.medications.filter((x) => !x.selfPay).map((x) => x.drugId))]) {
    const d = find.drug(id)
    if (!d?.preAuth) continue
    const p = opdDrugPreAuthOf(e.patientId, d.id, e.date)
    if (!p || !opdPreAuthValid(p, e.date)) fail(opdPreAuthBlockText(d.name, p, e.date), 'CONFLICT')
    const want = e.medications.filter((m) => m.drugId === id && !m.selfPay).reduce((n, m) => n + opdRxQty(m.qty, e.refillTimes), 0)
    const left = opdPreAuthLeft(p!, opdPreAuthUsed(p!, e.id))
    const last = lastOpdNhiDate(e.patientId, d.id, e.id)
    const wait = opdIntervalWait(p!.result?.interval, last, e.date)
    if (wait > 0) fail(`${d.name} 未達事前審查核准的間隔（${p!.no} 每次至少隔 ${p!.result!.interval} 天；上次健保開立 ${last}，還要 ${wait} 天）：請改自費或之後再開`, 'CONFLICT')
    const tLeft = opdPreAuthTimesLeft(p!, opdPreAuthUsedTimes(p!, e.id))
    const tWant = opdRxTimes(e.refillTimes)
    if (tLeft !== undefined && tWant > tLeft) fail(`${d.name} 超過事前審查核准次數（${p!.no} 核准 ${p!.result!.times} 次、還剩 ${tLeft} 次，這次${e.refillTimes >= 2 ? `慢箋 ${tWant} 次` : ' 1 次'}）：請重新申請或改自費`, 'CONFLICT')
    if (left !== undefined && want > left) fail(`${d.name} 超過事前審查核准量（${p!.no} 核准 ${p!.result!.qty} ${d.unit}、還剩 ${left}，這次${e.refillTimes >= 2 ? `慢箋共` : ''} ${want}）：請減量、改自費，或重新申請`, 'CONFLICT')
    const mq = p!.result?.monthlyQty
    if (mq !== undefined) {
      const now1 = e.medications.filter((m) => m.drugId === id && !m.selfPay).reduce((n, m) => n + m.qty, 0)
      const usedM = opdMonthQty(e.patientId, id, e.date.slice(0, 7), e.id)
      if (usedM + now1 > mq) fail(`${d.name} 超過事前審查的每月上限（${p!.no} 每月最多 ${mq} ${d.unit}；${e.date.slice(0, 7)} 已調劑 ${usedM}，這次 ${now1}）：請減量或改自費`, 'CONFLICT')
    }
  }
}

/** 慢箋領藥登記前：原處方裡健保開的需事前審查的藥，領藥這天核准還要在效期內 */
export function requireRefillPreAuth(e: Pick<Encounter, 'patientId' | 'medications'>, date: string) {
  for (const id of [...new Set(e.medications.filter((x) => !x.selfPay).map((x) => x.drugId))]) {
    const d = find.drug(id)
    if (!d?.preAuth) continue
    const p = opdDrugPreAuthOf(e.patientId, d.id, date)
    if (p && opdPreAuthValid(p, date)) {
      // 每月上限：領藥這天的月份，已調劑的加這次
      const mq = p.result?.monthlyQty
      const q = e.medications.filter((m) => m.drugId === id && !m.selfPay).reduce((n, m) => n + m.qty, 0)
      const usedM = opdMonthQty(e.patientId, id, date.slice(0, 7))
      if (mq !== undefined && usedM + q > mq) fail(`無法登記領藥：${d.name} 超過事前審查的每月上限（每月最多 ${mq} ${d.unit}；${date.slice(0, 7)} 已調劑 ${usedM}，這次 ${q}）：請下個月再領或改自費`, 'CONFLICT')
      continue
    }
    // 找最近一張過期的核准（說得出哪天到期）
    const old = db.preAuths.filter((x) => x.kind === 'drug' && !x.admissionId && x.patientId === e.patientId && x.itemId === d.id && x.status === 'approved').map(opdPreAuthUntil).filter((u): u is string => !!u).sort().at(-1)
    fail(`無法登記領藥：${d.name} 需健保事前審查，${old ? `核准已過期（${old}）` : '沒有有效的核准'}：請回診，由醫師重新申請或改自費`, 'CONFLICT')
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
