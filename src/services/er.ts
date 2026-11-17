// 急診：護理師檢傷（主訴＋生命徵象 → 建議級數；可調升、要原因；不能比建議輕）並掛急診 → 醫師在「門診看診」的急診診次看（依檢傷級數排）
// → 完成看診後決定去向：離院（批價、領藥照門診流程）、收住院（建住院預約，住院中心報到；沒床在看板標待床）、轉院。
// 費用：急診診察費、急診部分負擔依檢傷級數、觀察床費依時數（billing.calcChargeLines）。規則在 er-rules
import type { TriageLevel, TriageVitals, Visit } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { checkTriageInput, ER_DISPOSITION_LABEL, suggestLevel, TRIAGE_LABEL } from './er-rules'
import { erItem, erSessionFor, erVisits, isErDoctor, type ErBoardItem } from './er-work'
import { find, nameOf, visitView, type VisitView } from './views'

export interface ErBoard {
  items: ErBoardItem[]
  /** 目前的人：可以檢傷掛號（護理師）、可以決定去向（急診醫師） */
  canTriage: boolean
  canDispose: boolean
}

const STAGE_ORDER: Record<string, number> = { waiting: 0, seeing: 1, deciding: 2, bed: 3, billing: 4, admitted: 5, left: 6 }

/** 急診看板：待看診依級數、再依檢傷時間；其他依階段 */
export function erBoard(): Promise<ErBoard> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'clerk', 'admin')
    const t = now()
    const items = erVisits(t).map((v) => erItem(v, t))
      .sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || (a.stage === 'waiting' ? a.level - b.level || a.triagedAt.localeCompare(b.triagedAt) : b.arrivedAt.localeCompare(a.arrivedAt)))
    return { items, canTriage: u.role === 'nurse', canDispose: u.role === 'doctor' && isErDoctor(u.doctorId) }
  })
}

export interface TriageInput {
  patientId: string
  complaint: string
  vitals: TriageVitals
  level: TriageLevel
  /** 比建議嚴重（調升）的原因 */
  reason?: string
  identityCode?: string
}

/** 檢傷並掛急診（護理師）：同一位病人已在急診（還沒結束）或正在住院中不能再掛；到院時間＝現在，直接報到 */
export function triageAndRegister(input: TriageInput): Promise<VisitView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const p = must(find.patient(input.patientId), '病人')
    const e = checkTriageInput({ complaint: input.complaint, vitals: input.vitals, level: input.level, reason: input.reason })
    failFields(e)
    const t = now()
    if (erVisits(t).some((v) => v.patientId === p.id && ['registered', 'in-consult'].includes(v.status))) fail(`${p.name} 已經在急診候診或看診中`, 'CONFLICT')
    if (db.admissions.some((a) => a.patientId === p.id && a.status === 'admitted')) fail(`${p.name} 正在住院中`, 'CONFLICT')
    const identityCode = input.identityCode && find.identity(input.identityCode) ? input.identityCode : p.defaultIdentity
    const s = erSessionFor(t.slice(0, 10))
    const sug = suggestLevel(input.complaint, input.vitals)
    const vitals: TriageVitals = Object.fromEntries(Object.entries(input.vitals ?? {}).filter(([, x]) => x !== undefined && x !== null && !Number.isNaN(x)).map(([k, x]) => [k, Number(x)]))
    const v: Visit = {
      id: newId('V'), date: s.date, sessionId: s.id, deptId: s.deptId, doctorId: s.doctorId, patientId: p.id,
      seqNo: nextCounter(`seq:${s.id}`), identityCode, caseType: 'E1',
      cardSeq: String(nextCounter(`cardseq:${p.id}`)).padStart(4, '0'), status: 'registered',
      firstVisit: !db.visits.some((x) => x.patientId === p.id && x.status !== 'cancelled'), preventItems: [], createdAt: t, checkedInAt: t,
      er: {
        arrivedAt: t, complaint: input.complaint.trim(), vitals, suggested: sug.level, level: input.level,
        ...(input.level < sug.level ? { reason: input.reason!.trim() } : {}), triagedBy: u.id, triagedAt: t,
      },
    }
    db.visits.push(v)
    audit('急診檢傷掛號', `${p.chartNo} ${p.name}：${input.complaint.trim()}，檢傷 ${input.level} 級（${TRIAGE_LABEL[input.level]}）${input.level < sug.level ? `，由建議 ${sug.level} 級調升：${input.reason!.trim()}` : ''}`)
    return visitView(v)
  })
}

/** 重新檢傷（候診中病情變化）：可以調升或調降（都要原因）；舊的級數留在紀錄裡 */
export function retriage(visitId: string, input: { level: TriageLevel; reason: string }): Promise<ErBoardItem> {
  return mutate(() => {
    const u = requireUser('nurse')
    const v = must(find.visit(visitId), '急診就醫')
    if (!v.er) fail('這不是急診就醫')
    if (v.status !== 'registered') fail('醫師已經看了，不能再重新檢傷', 'CONFLICT')
    if (![1, 2, 3, 4, 5].includes(input.level)) failField('level', '請選檢傷級數')
    if (input.level === v.er!.level) failField('level', '級數沒有變')
    if (!input.reason?.trim()) failField('reason', '請寫重新檢傷的原因（例：候診中血壓下降到 85/50）')
    const t = now()
    ;(v.er!.history ??= []).push({ level: v.er!.level, at: v.er!.triagedAt, by: v.er!.triagedBy, reason: v.er!.reason ?? '首次檢傷' })
    Object.assign(v.er!, { level: input.level, reason: input.reason.trim(), triagedBy: u.id, triagedAt: t })
    audit('急診重新檢傷', `${nameOf.patient(v.patientId)}：${v.er!.history!.at(-1)!.level} → ${input.level} 級，${input.reason.trim()}`)
    return erItem(v, t)
  })
}

export interface DispositionInput {
  kind: 'home' | 'admit' | 'transfer'
  note?: string
  hospital?: string
  /** 收住院：科別、主治、入院診斷 */
  deptId?: string
  doctorId?: string
  diagnosis?: string
}

/**
 * 決定去向（急診醫師）：看完診（完成病歷）後。收住院＝建住院預約（今天、標來自急診），住院中心有床就報到；
 * 已經住院預約或住院中的不能重複。去向只能決定一次（要改請取消住院預約後由櫃台處理）
 */
export function setDisposition(visitId: string, input: DispositionInput): Promise<ErBoardItem> {
  return mutate(() => {
    const u = requireUser('doctor')
    if (!isErDoctor(u.doctorId)) fail('急診去向由急診醫師決定', 'FORBIDDEN')
    const v = must(find.visit(visitId), '急診就醫')
    if (!v.er) fail('這不是急診就醫')
    if (v.er.disposition) fail(`已經決定去向（${ER_DISPOSITION_LABEL[v.er.disposition.kind]}）`, 'CONFLICT')
    if (v.status === 'registered' || v.status === 'in-consult') fail('請先完成看診（病歷、處方），再決定去向', 'CONFLICT')
    const t = now()
    const note = input.note?.trim()
    if (input.kind === 'transfer') {
      if (!input.hospital?.trim()) failField('hospital', '請寫轉到哪一家醫院')
      if (!note) failField('note', '請寫轉院原因（例：需心導管，本院無設備）')
      v.er.disposition = { kind: 'transfer', at: t, by: u.id, hospital: input.hospital!.trim(), note }
    } else if (input.kind === 'admit') {
      const f: Record<string, string> = {}
      const dept = input.deptId ? db.departments.find((d) => d.id === input.deptId && d.active) : undefined
      const doc = input.doctorId ? db.doctors.find((d) => d.id === input.doctorId && d.active) : undefined
      if (!dept) f.deptId = '請選住院科別'
      if (!doc) f.doctorId = '請選主治醫師'
      else if (dept && doc.deptId !== dept.id) f.doctorId = `${doc.name} 不是${dept.name}的醫師`
      if (!input.diagnosis?.trim()) f.diagnosis = '請寫入院診斷'
      failFields(f)
      if (db.admissions.some((a) => a.patientId === v.patientId && (a.status === 'reserved' || a.status === 'admitted'))) fail(`${nameOf.patient(v.patientId)} 已有住院預約或正在住院中`, 'CONFLICT')
      const a = { id: newId('A'), admitNo: '', patientId: v.patientId, fromVisitId: v.id, deptId: dept!.id, doctorId: doc!.id, preferBedClass: '健保床' as const, reason: `急診收住院${note ? `：${note}` : ''}`, diagnosis: input.diagnosis!.trim(), status: 'reserved' as const, reservedAt: t, expectedDate: t.slice(0, 10) }
      db.admissions.push(a)
      v.er.disposition = { kind: 'admit', at: t, by: u.id, admissionId: a.id, ...(note ? { note } : {}) }
    } else if (input.kind === 'home') {
      v.er.disposition = { kind: 'home', at: t, by: u.id, ...(note ? { note } : {}) }
    } else fail('請選擇去向')
    audit('急診去向', `${nameOf.patient(v.patientId)}：${ER_DISPOSITION_LABEL[input.kind]}${input.kind === 'admit' ? ` ${nameOf.dept(input.deptId)} ${nameOf.doctor(input.doctorId)}，${input.diagnosis}` : input.kind === 'transfer' ? ` ${input.hospital}` : ''}${note ? `；${note}` : ''}`)
    return erItem(v, t)
  })
}

export type { ErBoardItem }
