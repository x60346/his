// 事前審查：需事前審查的藥（開住院醫囑自動建）、特殊材料（主刀申請）→ 主治填病情摘要與理由 → 申報組送審 → 結果：
// 核准、不核准（藥品醫囑自動停）、補件（主治補資料後再送）。核准前給藥、登記植入物都擋；病人同意自費或醫師寫緊急理由放行。
// 規則在 preauth-rules；把關、帳單自費、申報檢核在 preauth-work
import type { PreAuth } from '@/types'
import { db } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requirePermission, requireUser } from './http'
import { checkPreAuthFill, opdIntervalWait, opdPreAuthLeft, opdPreAuthTimesLeft, opdPreAuthUntil, opdPreAuthValid, preAuthAllows, preAuthDays, preAuthOverdue, PREAUTH_STATUS_LABEL } from './preauth-rules'
import { createImplantPreAuth, createOpdDrugPreAuth, implantPreAuthOf, lastOpdNhiDate, opdDrugPreAuthOf, opdPreAuthUsed, opdPreAuthUsedTimes } from './preauth-work'
import { IMPLANT_FOR } from './implant-rules'
import { stopOrderRecord } from './order-ops'
import { surgeryOf } from './surgery-work'
import { find, nameOf } from './views'

export interface PreAuthView extends PreAuth {
  statusLabel: string
  patientName: string
  chartNo: string
  admitNo: string
  doctorName: string
  /** 送審幾天、審查中超過 14 天 */
  days?: number
  overdue: boolean
  /** 現在能不能用（核准、自費、緊急） */
  allows: boolean
  notesText: string[]
  resultText?: string
  selfPayText?: string
  emergencyText?: string
  /** 門診（核准後效期內回診都能健保開）或住院 */
  opd: boolean
  /** 門診核准的有效期限 */
  validUntil?: string
  /** 門診核准量：核准、已健保開、還剩（沒寫核准量的沒有） */
  qty?: { approved: number; used: number; left: number; unit: string }
  /** 門診核准次數：核准、已開、還剩 */
  times?: { approved: number; used: number; left: number }
  /** 門診間隔天數 */
  interval?: number
  /** 門診每月上限 */
  monthlyQty?: number
}

function view(p: PreAuth): PreAuthView {
  const t = now()
  const a = p.admissionId ? find.admission(p.admissionId) : undefined
  return {
    ...p, opd: !p.admissionId, ...((u) => (u && !p.admissionId ? { validUntil: u } : {}))(opdPreAuthUntil(p)),
    ...(!p.admissionId && p.status === 'approved' && p.result?.qty !== undefined ? ((used) => ({ qty: { approved: p.result!.qty!, used, left: opdPreAuthLeft(p, used)!, unit: find.drug(p.itemId)?.unit ?? '' } }))(opdPreAuthUsed(p)) : {}),
    ...(!p.admissionId && p.status === 'approved' && p.result?.times !== undefined ? ((used) => ({ times: { approved: p.result!.times!, used, left: opdPreAuthTimesLeft(p, used)! } }))(opdPreAuthUsedTimes(p)) : {}),
    ...(!p.admissionId && p.result?.interval !== undefined ? { interval: p.result.interval } : {}),
    ...(!p.admissionId && p.result?.monthlyQty !== undefined ? { monthlyQty: p.result.monthlyQty } : {}), statusLabel: PREAUTH_STATUS_LABEL[p.status], patientName: nameOf.patient(p.patientId), chartNo: find.patient(p.patientId)?.chartNo ?? '', admitNo: a?.admitNo ?? '', doctorName: nameOf.doctor(p.doctorId),
    ...((d) => (d !== undefined ? { days: d } : {}))(preAuthDays(p, t)), overdue: preAuthOverdue(p, t), allows: preAuthAllows(p),
    notesText: p.notes.map((n) => `${n.at.slice(5)} ${nameOf.user(n.by)}：${n.text}`),
    ...(p.result ? { resultText: `${p.result.outcome === 'approved' ? '核准' : p.result.outcome === 'rejected' ? '不核准' : '補件'}・${nameOf.user(p.result.by)} ${p.result.at.slice(5)}${p.result.until ? `・期限 ${p.result.until}` : ''}${p.result.qty !== undefined ? `・核准量 ${p.result.qty} ${find.drug(p.itemId)?.unit ?? ''}` : ''}${p.result.times !== undefined ? `・核准 ${p.result.times} 次` : ''}${p.result.interval !== undefined ? `・間隔 ${p.result.interval} 天` : ''}${p.result.monthlyQty !== undefined ? `・每月最多 ${p.result.monthlyQty} ${find.drug(p.itemId)?.unit ?? ''}` : ''}${p.result.note ? `：${p.result.note}` : ''}` } : {}),
    ...(p.selfPay ? { selfPayText: `病人同意自費・${nameOf.user(p.selfPay.by)} ${p.selfPay.at.slice(5)}：${p.selfPay.note}` } : {}),
    ...(p.emergency ? { emergencyText: `緊急先用・${nameOf.user(p.emergency.by)} ${p.emergency.at.slice(5)}：${p.emergency.reason}` } : {}),
  }
}
const RANK: Record<PreAuth['status'], number> = { ready: 0, submitted: 1, more: 2, draft: 3, approved: 4, rejected: 5 }
const sorted = (xs: PreAuthView[]) => xs.sort((a, b) => Number(b.overdue) - Number(a.overdue) || RANK[a.status] - RANK[b.status] || b.createdAt.localeCompare(a.createdAt))
const paOf = (id: string) => must(db.preAuths.find((x) => x.id === id), '事前審查')

/** 申報組：全部（逾時、待送審在前） */
export function preAuthBoard(): Promise<PreAuthView[]> {
  return query(() => {
    requirePermission('nhi.claim')
    return sorted(db.preAuths.map(view))
  })
}
/** 主治：我的病人的送審單 */
export function myPreAuths(admissionId?: string): Promise<PreAuthView[]> {
  return query(() => {
    const u = requireUser('doctor', 'nurse')
    return sorted(db.preAuths.filter((p) => (admissionId ? p.admissionId === admissionId : u.role === 'doctor' && p.doctorId === u.doctorId)).map(view))
  })
}

function requireAttending(p: PreAuth) {
  const u = requireUser('doctor')
  if (u.doctorId !== p.doctorId) fail('只有主治醫師能處理這張送審單', 'FORBIDDEN')
  return u
}

/** 主治填寫（或補件）：病情摘要、使用理由；補件要寫補了什麼 → 待送審 */
export function fillPreAuth(id: string, input: { summary: string; reason: string; note?: string }): Promise<PreAuthView> {
  return mutate(() => {
    const p = paOf(id)
    const u = requireAttending(p)
    if (!['draft', 'more', 'ready'].includes(p.status)) fail(`這張送審單${PREAUTH_STATUS_LABEL[p.status]}，不能再改`, 'CONFLICT')
    const e = checkPreAuthFill(input)
    if (p.status === 'more' && !input.note?.trim()) e.note = '請寫補了哪些資料'
    failFields(e)
    const t = now()
    p.summary = input.summary.trim()
    p.reason = input.reason.trim()
    p.notes.push({ at: t, by: u.id, text: p.status === 'more' ? `補件：${input.note!.trim()}` : p.status === 'draft' ? '填寫送審資料' : '修改送審資料' })
    p.status = 'ready'
    audit('事前審查填寫', `${p.no} ${p.itemName}（${nameOf.patient(p.patientId)}）`)
    return view(p)
  })
}

/** 送審（申報組）：待送審的 */
export function submitPreAuth(id: string): Promise<PreAuthView> {
  return mutate(() => {
    const u = requirePermission('nhi.claim')
    const p = paOf(id)
    if (p.status !== 'ready') fail(p.status === 'draft' || p.status === 'more' ? '主治還沒填寫（或補件）' : `這張送審單${PREAUTH_STATUS_LABEL[p.status]}`, 'CONFLICT')
    Object.assign(p, { status: 'submitted', submittedAt: now(), submittedBy: u.id })
    delete p.result
    audit('事前審查送審', `${p.no} ${p.itemName}（${nameOf.patient(p.patientId)}）`)
    return view(p)
  })
}

/** 審查結果（申報組）：核准（可寫期限）、不核准（寫理由；藥品醫囑自動停）、補件（寫要補什麼） */
export function recordPreAuthResult(id: string, input: { outcome: 'approved' | 'rejected' | 'more'; note?: string; until?: string; qty?: number | null; times?: number | null; interval?: number | null; monthlyQty?: number | null }): Promise<PreAuthView> {
  return mutate(() => {
    const u = requirePermission('nhi.claim')
    const p = paOf(id)
    if (p.status !== 'submitted') fail('送審後才能記結果', 'CONFLICT')
    if (!['approved', 'rejected', 'more'].includes(input.outcome)) failField('outcome', '請選核准、不核准或補件')
    if (input.outcome !== 'approved' && !input.note?.trim()) failField('note', input.outcome === 'rejected' ? '請寫不核准理由' : '請寫要補哪些資料')
    if (input.until && !/^\d{4}-\d{2}-\d{2}$/.test(input.until)) failField('until', '期限格式不對')
    // 門診核准量（選填）：正整數
    const hasQty = input.outcome === 'approved' && !p.admissionId && input.qty !== undefined && input.qty !== null && String(input.qty) !== ''
    if (hasQty && (!Number.isInteger(Number(input.qty)) || Number(input.qty) <= 0)) failField('qty', '核准量是正整數（例：6 支）')
    const hasTimes = input.outcome === 'approved' && !p.admissionId && input.times !== undefined && input.times !== null && String(input.times) !== ''
    if (hasTimes && (!Number.isInteger(Number(input.times)) || Number(input.times) <= 0)) failField('times', '核准次數是正整數（例：6 次）')
    const hasInterval = input.outcome === 'approved' && !p.admissionId && input.interval !== undefined && input.interval !== null && String(input.interval) !== ''
    const hasMonthly = input.outcome === 'approved' && !p.admissionId && input.monthlyQty !== undefined && input.monthlyQty !== null && String(input.monthlyQty) !== ''
    if (hasMonthly && (!Number.isInteger(Number(input.monthlyQty)) || Number(input.monthlyQty) <= 0)) failField('monthlyQty', '每月上限是正整數')
    if (hasInterval && (!Number.isInteger(Number(input.interval)) || Number(input.interval) <= 0 || Number(input.interval) > 365)) failField('interval', '間隔天數是 1–365 的整數')
    const t = now()
    p.result = { outcome: input.outcome, note: input.note?.trim() ?? '', at: t, by: u.id, ...(input.until ? { until: input.until } : {}), ...(hasQty ? { qty: Number(input.qty) } : {}), ...(hasTimes ? { times: Number(input.times) } : {}), ...(hasInterval ? { interval: Number(input.interval) } : {}), ...(hasMonthly ? { monthlyQty: Number(input.monthlyQty) } : {}) }
    p.status = input.outcome
    // 不核准：這次住院這個藥還在用的醫囑停掉（自費、緊急先用的除外）
    let stopped = 0
    if (input.outcome === 'rejected' && p.kind === 'drug' && !p.selfPay) {
      for (const o of db.ipdOrders.filter((x) => x.admissionId === p.admissionId && x.drugId === p.itemId && x.status === 'active')) {
        stopOrderRecord(o, u.id, t)
        o.stopReason = `健保事前審查不核准（${p.no}）`
        stopped++
      }
    }
    audit('事前審查結果', `${p.no} ${p.itemName}（${nameOf.patient(p.patientId)}）：${PREAUTH_STATUS_LABEL[p.status]}${input.note?.trim() ? `，${input.note.trim()}` : ''}${stopped ? `；停止醫囑 ${stopped} 筆` : ''}`)
    return view(p)
  })
}

/** 病人同意改自費（主治記；核准前、不核准前）：這次用的照自費算 */
export function selfPayPreAuth(id: string, note: string): Promise<PreAuthView> {
  return mutate(() => {
    const p = paOf(id)
    const u = requireAttending(p)
    if (!p.admissionId) fail('門診改自費：在處方那一列勾「自費」就好（這次自費，送審單照常審）', 'CONFLICT')
    if (p.status === 'approved' || p.status === 'rejected') fail(`已經${PREAUTH_STATUS_LABEL[p.status]}`, 'CONFLICT')
    if (p.selfPay) fail('已經記過病人同意自費', 'CONFLICT')
    if (!note?.trim()) failField('note', '請寫同意情形（例：病人已簽自費同意書，了解費用）')
    p.selfPay = { at: now(), by: u.id, note: note.trim() }
    audit('事前審查改自費', `${p.no} ${p.itemName}（${nameOf.patient(p.patientId)}）：${note.trim()}`)
    return view(p)
  })
}

/** 緊急先用（主治寫理由）：仍要送審，申報照檢核 */
export function emergencyPreAuth(id: string, reason: string): Promise<PreAuthView> {
  return mutate(() => {
    const p = paOf(id)
    const u = requireAttending(p)
    if (!p.admissionId) fail('門診沒有緊急先用：核准前請自費開立，或改住院處理', 'CONFLICT')
    if (p.status === 'approved' || p.status === 'rejected') fail(`已經${PREAUTH_STATUS_LABEL[p.status]}`, 'CONFLICT')
    if (p.emergency) fail('已經寫過緊急理由', 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫緊急理由（為什麼不能等審查結果）')
    p.emergency = { at: now(), by: u.id, reason: reason.trim() }
    audit('事前審查緊急先用', `${p.no} ${p.itemName}（${nameOf.patient(p.patientId)}）：${reason.trim()}`)
    return view(p)
  })
}

/** 主刀申請特殊材料的事前審查（手術完成、取消前；這個術式會用到、需事前審查的植入物） */
export function requestImplantPreAuth(surgeryId: string, procId: string): Promise<PreAuthView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const s = must(surgeryOf(surgeryId), '手術')
    if (s.doctorId !== u.doctorId) fail('由主刀申請', 'FORBIDDEN')
    if (s.status === 'done' || s.status === 'cancelled') fail('手術已完成或取消', 'CONFLICT')
    const pr = find.procedure(procId)
    if (!pr?.preAuth || !(IMPLANT_FOR[s.procId] ?? []).includes(procId)) fail('這個術式不用申請這項事前審查', 'CONFLICT')
    if (implantPreAuthOf(s.id, procId)) fail('已經申請過了', 'CONFLICT')
    const p = createImplantPreAuth({ surgeryId: s.id, procId, patientId: s.patientId, admissionId: s.admissionId, doctorId: s.doctorId, itemName: pr!.name, createdAt: now() })
    audit('事前審查申請', `${p.no} ${p.itemName}（${nameOf.patient(p.patientId)}，${s.no}）`)
    return view(p)
  })
}

// ---------- 門診 ----------

export interface OpdPreAuthState {
  drugId: string
  drugName: string
  /** 這個病人這個藥最新的送審單（核准在效期內的優先）；沒有＝還沒申請 */
  preAuth?: PreAuthView
  /** 今天能不能健保開（核准、效期） */
  valid: boolean
  /** 上次健保開立日、離核准間隔還要等幾天（0＝可以） */
  lastNhi?: string
  wait: number
}

/** 門診處方：這幾個藥裡需事前審查的，各自的送審狀態（看診中的病歷） */
export function opdPreAuthStates(encounterId: string, drugIds: string[]): Promise<OpdPreAuthState[]> {
  return query(() => {
    requireUser('doctor')
    const e = must(db.encounters.find((x) => x.id === encounterId), '病歷')
    return [...new Set(drugIds)].map((id) => find.drug(id)).filter((d) => !!d?.preAuth).map((d) => {
      const p = opdDrugPreAuthOf(e.patientId, d!.id, e.date)
      const last = lastOpdNhiDate(e.patientId, d!.id, e.id)
      return { drugId: d!.id, drugName: d!.name, ...(p ? { preAuth: view(p) } : {}), valid: !!p && opdPreAuthValid(p, e.date), ...(last ? { lastNhi: last } : {}), wait: p ? opdIntervalWait(p.result?.interval, last, e.date) : 0 }
    })
  })
}

/**
 * 門診申請事前審查（看診醫師）：需事前審查的藥、這個病人還沒有審查中或有效的送審單 → 建一張（醫師接著填病情摘要與理由）。
 * 這次看診先不開或自費開；核准後效期內回診就能健保開
 */
export function requestOpdDrugPreAuth(encounterId: string, drugId: string): Promise<PreAuthView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const e = must(db.encounters.find((x) => x.id === encounterId), '病歷')
    if (e.doctorId !== u.doctorId) fail('由看診醫師申請', 'FORBIDDEN')
    const d = find.drug(drugId)
    if (!d?.preAuth) fail('這個藥不用事前審查', 'CONFLICT')
    const old = opdDrugPreAuthOf(e.patientId, d!.id, e.date)
    if (old) fail(`已經有送審單 ${old.no}（${PREAUTH_STATUS_LABEL[old.status]}${old.status === 'approved' ? `，期限 ${opdPreAuthUntil(old)}` : ''}）`, 'CONFLICT')
    const p = createOpdDrugPreAuth({ drugId: d!.id, itemName: d!.name, patientId: e.patientId, encounterId: e.id, doctorId: e.doctorId, createdAt: now() })
    audit('事前審查申請（門診）', `${p.no} ${p.itemName}（${nameOf.patient(p.patientId)}）`)
    return view(p)
  })
}
