// 病安異常事件通報：任何臨床人員都能通報（跌倒、給藥、管路、檢體、其他），可選匿名——系統記得是誰（通報人自己看得到），
// 審查的人看不到。給藥、採檢的「掃描不符」可以一鍵帶入（跡近錯失）。
// 有「病安事件審查」權限的人（預設管理員，可指定護理長等個人）評定嚴重度（SAC）、寫原因分析與改善措施、結案；30 天統計。規則在 incident-rules
import type { Incident, IncidentCategory, IncidentHarm } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { addDays, now } from '@/utils/date'
import { audit, fail, failFields, must, mutate, permissionsOf, query, requirePermission, requireUser } from './http'
import { find, nameOf } from './views'
import { checkIncident, checkIncidentReview, incidentStats, INCIDENT_CATEGORY_LABEL, INCIDENT_HARM_LABEL, INCIDENT_STATUS_LABEL, SAC_LABEL, sacSuggest } from './incident-rules'

const CLINICAL = ['doctor', 'nurse', 'pharmacist', 'lab', 'radtech', 'clerk', 'diet', 'admin'] as const

export interface IncidentView extends Omit<Incident, 'reportedBy'> {
  categoryLabel: string
  harmLabel: string
  statusLabel: string
  patientName?: string
  chartNo?: string
  /** 匿名的：審查的人看到「匿名」；通報人自己看到自己的名字 */
  reporterName: string
  /** 目前登入的人是通報人 */
  mine: boolean
  sacSuggested: 1 | 2 | 3 | 4
  sacLabel?: string
  reviewerName?: string
}
function view(x: Incident, me: string): IncidentView {
  const { reportedBy, ...rest } = x
  const p = x.patientId ? find.patient(x.patientId) : undefined
  return {
    ...rest, categoryLabel: INCIDENT_CATEGORY_LABEL[x.category], harmLabel: INCIDENT_HARM_LABEL[x.harm], statusLabel: INCIDENT_STATUS_LABEL[x.status],
    ...(p ? { patientName: p.name, chartNo: p.chartNo } : {}),
    reporterName: x.anonymous && reportedBy !== me ? '匿名' : nameOf.user(reportedBy), mine: reportedBy === me, sacSuggested: sacSuggest(x.harm),
    ...(x.review ? { sacLabel: SAC_LABEL[x.review.sac], reviewerName: nameOf.user(x.review.by) } : {}),
  }
}

export interface IncidentInput {
  category: IncidentCategory
  occurredAt: string
  location: string
  patientId?: string
  description: string
  harm: IncidentHarm
  immediateAction?: string
  anonymous?: boolean
  fromScanMismatchId?: string
}

/** 通報（臨床人員）：發生時間不能在未來；病人可不填；可匿名。同一筆掃描不符只能通報一次 */
export function reportIncident(input: IncidentInput): Promise<IncidentView> {
  return mutate(() => {
    const u = requireUser(...CLINICAL)
    const t = now()
    failFields(checkIncident(input ?? {}, t))
    if (input.patientId) must(find.patient(input.patientId), '病患')
    if (input.fromScanMismatchId) {
      must(db.scanMismatches.find((m) => m.id === input.fromScanMismatchId) ?? db.dispenseMismatches.find((m) => m.id === input.fromScanMismatchId), '掃描不符紀錄')
      if (db.incidents.some((x) => x.fromScanMismatchId === input.fromScanMismatchId)) fail('這筆掃描不符已經通報過了', 'CONFLICT')
    }
    const no = `INC${t.slice(0, 10).replace(/-/g, '')}${String(nextCounter(`incident:${t.slice(0, 10)}`)).padStart(3, '0')}`
    const x: Incident = {
      id: newId('IN'), no, category: input.category, occurredAt: input.occurredAt, location: input.location.trim(), ...(input.patientId ? { patientId: input.patientId } : {}),
      description: input.description.trim(), harm: input.harm, ...(input.immediateAction?.trim() ? { immediateAction: input.immediateAction.trim() } : {}),
      reportedBy: u.id, reportedAt: t, anonymous: !!input.anonymous, ...(input.fromScanMismatchId ? { fromScanMismatchId: input.fromScanMismatchId } : {}), status: 'reported',
    }
    db.incidents.push(x)
    // 稽核：匿名的不寫通報內容與病人（稽核紀錄管理員看得到，避免從這裡推出是誰）
    audit('病安事件通報', `${no} ${INCIDENT_CATEGORY_LABEL[x.category]}（${INCIDENT_HARM_LABEL[x.harm]}）${x.anonymous ? '・匿名' : ''}`)
    return view(x, u.id)
  })
}

/** 從掃描不符帶入通報（跡近錯失）：類別、時間、地點、病人、經過先填好 */
export function incidentDraftFromScan(mismatchId: string): Promise<IncidentInput> {
  return query(() => {
    requireUser(...CLINICAL)
    // 門診發藥的掃描不符（差點發錯）
    const dm = db.dispenseMismatches.find((x) => x.id === mismatchId)
    if (dm) {
      const d = db.dispenses.find((x) => x.id === dm.dispenseId)
      return {
        category: 'medication' as const, occurredAt: dm.at, location: '門診藥局', ...(d ? { patientId: d.patientId } : {}),
        description: `門診發藥（領藥號 ${d?.pickupNo ?? ''}）前掃描發現不符，當場擋下：${dm.message}`, harm: 'near-miss' as const, immediateAction: '換成處方上的藥、重新掃描核對後發藥', fromScanMismatchId: dm.id,
      }
    }
    const m = must(db.scanMismatches.find((x) => x.id === mismatchId), '掃描不符紀錄')
    const a = find.admission(m.admissionId)
    const bed = a?.bedId ? find.bed(a.bedId) : undefined
    const what = m.specimenId ? `採檢（${db.specimens.find((s) => s.id === m.specimenId)?.barcode ?? ''}）` : `給藥（${db.ipdOrders.find((o) => o.id === m.orderId)?.content ?? ''}）`
    return {
      category: m.specimenId ? 'specimen' : 'medication', occurredAt: m.at, location: bed ? `${bed.ward} ${bed.bedNo}` : '病房', ...(a ? { patientId: a.patientId } : {}),
      description: `${what}前掃描發現不符，當場擋下：${m.message}`, harm: 'near-miss', immediateAction: '重新核對病人與條碼後才執行', fromScanMismatchId: m.id,
    }
  })
}

/** 我通報的（含匿名的） */
export function myIncidents(): Promise<IncidentView[]> {
  return query(() => {
    const u = requireUser(...CLINICAL)
    return db.incidents.filter((x) => x.reportedBy === u.id).sort((a, b) => b.reportedAt.localeCompare(a.reportedAt)).map((x) => view(x, u.id))
  })
}

/** 審查清單（病安事件審查）：待審查、審查中在前；近 30 天統計 */
export function listIncidents(): Promise<{ items: IncidentView[]; stats: ReturnType<typeof incidentStats>; pending: number }> {
  return query(() => {
    const u = requirePermission('incident.review')
    const ORDER = { reported: 0, reviewing: 1, closed: 2 }
    const items = [...db.incidents].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.reportedAt.localeCompare(a.reportedAt)).map((x) => view(x, u.id))
    return { items, stats: incidentStats(db.incidents, `${addDays(now().slice(0, 10), -30)} 00:00`), pending: db.incidents.filter((x) => x.status !== 'closed').length }
  })
}

/** 審查（病安事件審查）：評定 SAC、原因分析、改善措施；close＝結案（原因、措施都要寫）。結案後不能再改 */
export function reviewIncident(id: string, input: { sac: number; cause?: string; actions?: string; close?: boolean }): Promise<IncidentView> {
  return mutate(() => {
    const u = requirePermission('incident.review')
    const x = must(db.incidents.find((v) => v.id === id), '病安事件')
    if (x.status === 'closed') fail('已經結案了', 'CONFLICT')
    failFields(checkIncidentReview(input ?? {}))
    const t = now()
    x.review = { by: u.id, at: t, sac: Number(input.sac) as 1 | 2 | 3 | 4, cause: input.cause?.trim() ?? '', actions: input.actions?.trim() ?? '', ...(input.close ? { closedAt: t } : {}) }
    x.status = input.close ? 'closed' : 'reviewing'
    audit(input.close ? '病安事件結案' : '病安事件審查', `${x.no} ${INCIDENT_CATEGORY_LABEL[x.category]}：${SAC_LABEL[x.review.sac]}`)
    return view(x, u.id)
  })
}

/** 首頁／頁面用：這個人能不能審查 */
export const incidentAccess = (): Promise<{ canReview: boolean }> => query(() => ({ canReview: permissionsOf(requireUser(...CLINICAL)).includes('incident.review') }))
