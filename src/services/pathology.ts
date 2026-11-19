// 手術病理檢體：手術中流動護理師逐件登記（部位、容器、固定液）→ 手術完成時送出 → 病理收件（權限「病理」的醫檢師，逐件核對；
// 少了要寫原因）→ 發報告（權限「病理」的醫師）→ 惡性或和術前診斷不符，主刀必須確認看過。
// 完成手術要有檢體或確認「本台無檢體」（surgery.finishSurgery 擋）。規則在 pathology-rules
import type { PathContainer, PathFixative, Surgery, SurgicalSpecimen } from '@/types'
import { db } from '@/mock/db'
import { now, parseDate } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, permissionsOf, query, requirePermission, requireUser, type Actor } from './http'
import { checkPathReport, checkSpecimen, nextSpecimenLabel, pathCritical, pathOverdue, pathStage, PATH_RECEIVE_HOURS, specimenText, type PathStage } from './pathology-rules'
import { surgeryOf } from './surgery-work'
import { SIDE_LABEL } from './surgery-rules'
import { find, nameOf } from './views'

const minutesBetween = (a: string, b: string) => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 60000)
const audText = (s: Surgery) => `${s.no} ${nameOf.patient(s.patientId)} ${find.procedure(s.procId)?.name ?? ''}（${SIDE_LABEL[s.side]}）`

// ---------- 手術室：登記檢體 ----------

/** 登記一件檢體（手術中；護理師） */
export function addSpecimen(surgeryId: string, input: { site: string; container: PathContainer; fixative: PathFixative; note?: string }): Promise<SurgicalSpecimen[]> {
  return mutate(() => {
    const u = requireUser('nurse')
    const s = must(surgeryOf(surgeryId), '手術')
    if (s.status !== 'in-progress') fail('手術中才能登記檢體', 'CONFLICT')
    failFields(checkSpecimen(input))
    const list = s.specimens ?? []
    const x: SurgicalSpecimen = { id: `SP${list.length + 1}-${Math.random().toString(36).slice(2, 6)}`, label: nextSpecimenLabel(list), site: input.site.trim(), container: input.container, fixative: input.fixative, ...(input.note?.trim() ? { note: input.note.trim() } : {}), by: u.id, at: now().slice(0, 16) }
    s.specimens = [...list, x]
    audit('登記檢體', `${audText(s)}：${specimenText(x)}`)
    return s.specimens
  })
}

/** 刪一件登記錯的（手術中；寫稽核）。標籤不補號 */
export function removeSpecimen(surgeryId: string, specimenId: string): Promise<SurgicalSpecimen[]> {
  return mutate(() => {
    requireUser('nurse')
    const s = must(surgeryOf(surgeryId), '手術')
    if (s.status !== 'in-progress') fail('手術完成後檢體不能再改', 'CONFLICT')
    const x = must(s.specimens?.find((y) => y.id === specimenId), '檢體')
    s.specimens = s.specimens!.filter((y) => y !== x)
    audit('刪除檢體', `${audText(s)}：${specimenText(x)}`)
    return s.specimens
  })
}

// ---------- 病理 ----------

export interface PathItem {
  surgeryId: string
  no: string
  patientName: string
  chartNo: string
  procName: string
  diagnosis: string
  surgeonName: string
  stage: PathStage
  sentAt: string
  /** 送出到現在（或到收件）幾分鐘 */
  minutes: number
  overdue: boolean
  specimens: (SurgicalSpecimen & { text: string })[]
  receivedText?: string
  /** 收件時少了的 */
  missing: string[]
  report?: { diagnosis: string; malignant: boolean; consistent: boolean; note?: string; byName: string; at: string }
  critical: boolean
  ackText?: string
  canReceive: boolean
  canReport: boolean
  canAck: boolean
}

const isPath = (u: Actor) => permissionsOf(u).includes('pathology')
/** 主刀，或和主刀同科的醫師（病人出院後報告才出來也能確認） */
const surgeonSide = (s: Surgery, u: Actor) => u.role === 'doctor' && !!u.doctorId && (u.doctorId === s.doctorId || find.doctor(u.doctorId)?.deptId === find.doctor(s.doctorId)?.deptId)

function pathItem(s: Surgery, u: Actor, t: string): PathItem {
  const p = s.path!
  const st = pathStage(p)!
  const pt = find.patient(s.patientId)
  return {
    surgeryId: s.id, no: s.no, patientName: pt?.name ?? '', chartNo: pt?.chartNo ?? '', procName: find.procedure(s.procId)?.name ?? '', diagnosis: s.diagnosis, surgeonName: nameOf.doctor(s.doctorId),
    stage: st, sentAt: p.sentAt, minutes: minutesBetween(p.sentAt, p.received?.at ?? t), overdue: pathOverdue(p, t, minutesBetween),
    specimens: (s.specimens ?? []).map((x) => ({ ...x, text: specimenText(x) })),
    ...(p.received ? { receivedText: `${p.received.at.slice(5)} ${nameOf.user(p.received.by)} 收件${p.received.missing?.length ? `（少了 ${p.received.missing.join('、')}：${p.received.note ?? ''}）` : ''}` } : {}),
    missing: p.received?.missing ?? [],
    ...(p.report ? { report: { diagnosis: p.report.diagnosis, malignant: p.report.malignant, consistent: p.report.consistent, ...(p.report.note ? { note: p.report.note } : {}), byName: nameOf.user(p.report.by), at: p.report.at } } : {}),
    critical: pathCritical(p.report),
    ...(p.ack ? { ackText: `${p.ack.at.slice(5)} ${nameOf.user(p.ack.by)} 確認${p.ack.note ? `：${p.ack.note}` : ''}` } : {}),
    canReceive: isPath(u) && u.role === 'lab' && st === 'sent',
    canReport: isPath(u) && u.role === 'doctor' && st === 'received',
    canAck: surgeonSide(s, u) && st === 'reported',
  }
}

/** 一台手術的病理（手術室、病人「手術」分頁） */
export function pathOf(surgeryId: string): Promise<PathItem | null> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'lab', 'admin')
    const s = must(surgeryOf(surgeryId), '手術')
    return s.path ? pathItem(s, u, now()) : null
  })
}

export interface PathBoard {
  toReceive: PathItem[]
  toReport: PathItem[]
  /** 近 14 天發的報告（要確認的在前） */
  reported: PathItem[]
  receiveHours: number
}
/** 病理頁（權限「病理」）：待收件（逾時的標紅）、待發報告、近期報告 */
export function pathBoard(): Promise<PathBoard> {
  return query(() => {
    const u = requirePermission('pathology')
    const t = now()
    const all = db.surgeries.filter((s) => s.path).map((s) => pathItem(s, u, t))
    const since = parseDate(t).getTime() - 14 * 24 * 3600000
    return {
      toReceive: all.filter((x) => x.stage === 'sent').sort((a, b) => a.sentAt.localeCompare(b.sentAt)),
      toReport: all.filter((x) => x.stage === 'received').sort((a, b) => a.sentAt.localeCompare(b.sentAt)),
      reported: all.filter((x) => x.report && parseDate(x.report.at).getTime() >= since).sort((a, b) => Number(b.critical && b.stage === 'reported') - Number(a.critical && a.stage === 'reported') || b.report!.at.localeCompare(a.report!.at)),
      receiveHours: PATH_RECEIVE_HOURS,
    }
  })
}

/** 收件（權限「病理」的醫檢師）：逐件勾到了的；少了要寫原因（記下來，主刀與手術室看得到） */
export function receivePath(surgeryId: string, input: { received: string[]; note?: string }): Promise<PathItem> {
  return mutate(() => {
    requireUser('lab')
    const u = requirePermission('pathology')
    const s = must(surgeryOf(surgeryId), '手術')
    if (pathStage(s.path) !== 'sent') fail(s.path ? '已經收件了' : '這台手術沒有送病理', 'CONFLICT')
    const got = new Set(input.received ?? [])
    const missing = (s.specimens ?? []).filter((x) => !got.has(x.id)).map((x) => x.label)
    if (missing.length === (s.specimens ?? []).length) failField('received', '請勾收到的檢體')
    const note = input.note?.trim()
    if (missing.length && !note) failField('note', `少了 ${missing.join('、')}：請寫原因與處理（例：已通知手術室尋找）`)
    const t = now().slice(0, 16)
    s.path!.received = { at: t, by: u.id, ...(missing.length ? { missing, note } : {}) }
    audit('病理收件', `${audText(s)}：${(s.specimens ?? []).length - missing.length} 件${missing.length ? `；少了 ${missing.join('、')}（${note}）` : ''}`)
    return pathItem(s, u, t)
  })
}

/** 發報告（權限「病理」的醫師）：診斷、良惡性、和術前診斷是否相符 */
export function reportPath(surgeryId: string, input: { diagnosis: string; malignant: boolean; consistent: boolean; note?: string }): Promise<PathItem> {
  return mutate(() => {
    requireUser('doctor')
    const u = requirePermission('pathology')
    const s = must(surgeryOf(surgeryId), '手術')
    if (pathStage(s.path) !== 'received') fail(s.path?.report ? '報告已經發了' : '還沒收件，不能發報告', 'CONFLICT')
    failFields(checkPathReport(input))
    const t = now().slice(0, 16)
    s.path!.report = { diagnosis: input.diagnosis.trim(), malignant: input.malignant, consistent: input.consistent, ...(input.note?.trim() ? { note: input.note.trim() } : {}), by: u.id, at: t }
    audit('病理報告', `${audText(s)}：${input.diagnosis.trim()}${input.malignant ? '（惡性）' : ''}${input.consistent ? '' : '（和術前診斷不符）'}`)
    return pathItem(s, u, t)
  })
}

/** 主刀確認看過（惡性、不符的必須；其他可以按「已讀」） */
export function ackPath(surgeryId: string, input: { note?: string } = {}): Promise<PathItem> {
  return mutate(() => {
    const u = requireUser('doctor')
    const s = must(surgeryOf(surgeryId), '手術')
    if (!surgeonSide(s, u)) fail('主刀或同科醫師才能確認病理報告', 'FORBIDDEN')
    if (pathStage(s.path) !== 'reported') fail(s.path?.ack ? '已經確認過了' : '還沒有報告', 'CONFLICT')
    const t = now().slice(0, 16)
    s.path!.ack = { by: u.id, at: t, ...(input.note?.trim() ? { note: input.note.trim() } : {}) }
    audit('確認病理報告', `${audText(s)}：${s.path!.report!.diagnosis}${input.note?.trim() ? `；${input.note.trim()}` : ''}`)
    return pathItem(s, u, t)
  })
}
