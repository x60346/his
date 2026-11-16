// 影像檢查報告：判讀醫師寫「所見」「結論」→ 發報告；發出後只能加「補充報告」（原文不改，醫師要重新確認）。
// 重要發現（氣胸、腦出血…）比照檢驗危急值：開立醫師（住院含主治）要按「已知悉」。待判讀清單由醫令推算（見 imaging-work）。
import type { ImagingReport } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failFields, must, mutate, query, requireUser, sessionRole, sessionUser } from './http'
import { find, nameOf } from './views'
import { canAckImaging, canReadImaging, imagingNeedsAck, imagingOf, isRadiologist, pendingImagingWork, reportedImagingIpd, reportedImagingOpd, type ImagingWorkItem } from './imaging-work'

export type { ImagingWorkItem }

/** 待判讀：放射科醫師看放射科的；其他醫師看自己開、自己判讀的（心電圖）；管理員看全部（只能看） */
export function listImagingWork(): Promise<ImagingWorkItem[]> {
  return query(() => {
    const u = requireUser('doctor', 'admin')
    const all = pendingImagingWork()
    return sessionRole() === 'admin' ? all : all.filter((w) => canReadImaging(w, u.doctorId))
  })
}

export interface ImagingReportView extends ImagingReport {
  procName: string
  doctorName: string
  readerName: string
  source: 'opd' | 'ipd'
  patientName: string
  chartNo: string
  needsAck: boolean
  /** 目前登入的醫師能不能按「已知悉」 */
  canAck: boolean
  /** 目前登入的醫師能不能加補充報告（判讀的人；放射科的報告放射科醫師都可以） */
  canAddendum: boolean
  ackByName?: string
}

function reportView(r: ImagingReport): ImagingReportView {
  const p = find.patient(r.patientId)
  const me = sessionRole() === 'doctor' ? sessionUser()?.doctorId : undefined
  const reader = imagingOf(r.procId)?.reader ?? 'radiology'
  return {
    ...r,
    procName: find.procedure(r.procId)?.name ?? r.procId,
    doctorName: nameOf.doctor(r.doctorId),
    readerName: nameOf.doctor(r.readerId),
    source: r.orderId ? 'ipd' : 'opd',
    patientName: p?.name ?? '', chartNo: p?.chartNo ?? '',
    needsAck: imagingNeedsAck(r),
    canAck: imagingNeedsAck(r) && canAckImaging(r, me),
    canAddendum: !!me && (reader === 'radiology' ? isRadiologist(me) : r.readerId === me),
    ...(r.ackBy ? { ackByName: nameOf.user(r.ackBy) } : {}),
  }
}

function nextNo(at: string): string {
  const day = at.slice(0, 10).replace(/-/g, '')
  const key = `img:${day}`
  db.counters[key] = (db.counters[key] ?? 0) + 1
  return `R${day}${String(db.counters[key]).padStart(4, '0')}`
}

/** 發影像報告：所見與結論都要寫 */
export function reportImaging(input: { key: string; findings: string; impression: string; significant?: boolean }): Promise<ImagingReportView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const w = pendingImagingWork().find((x) => x.key === input.key)
    if (!w) {
      // 不在清單上：分清楚是發過了、還是根本找不到
      const [kind, a, b] = (input.key ?? '').split(':')
      if ((kind === 'E' && reportedImagingOpd(a, b)) || (kind === 'O' && reportedImagingIpd(a))) fail('這項已經發過報告了；要補充請用「補充報告」', 'CONFLICT')
      fail('找不到這筆影像檢查（可能還沒批價、已標未執行或醫囑已停止），請重新整理', 'CONFLICT')
    }
    if (w!.awaitingExam) fail('還沒做檢查（臨時醫囑還沒執行），不能發報告', 'CONFLICT')
    if (!canReadImaging(w!, u.doctorId)) fail(w!.reader === 'radiology' ? '這項由放射科醫師判讀' : '心電圖由開立醫師判讀', 'FORBIDDEN')
    const findings = input.findings?.trim() ?? ''
    const impression = input.impression?.trim() ?? ''
    failFields({ ...(findings ? {} : { findings: '請寫所見' }), ...(impression ? {} : { impression: '請寫結論' }) })
    const [kind, a] = w!.key.split(':')
    const t = now()
    const r: ImagingReport = {
      id: newId('IR'), no: nextNo(t), patientId: w!.patientId, procId: w!.procId,
      ...(kind === 'E' ? { encounterId: a } : { orderId: a, admissionId: db.ipdOrders.find((o) => o.id === a)?.admissionId }),
      doctorId: w!.doctorId, orderedAt: w!.orderedAt, findings, impression, ...(input.significant ? { significant: true } : {}),
      readerId: u.doctorId!, reportedAt: t,
    }
    db.imagingReports.push(r)
    audit(r.significant ? '發影像報告（重要發現）' : '發影像報告', `${r.no} ${w!.patientName} ${w!.procName}：${impression}`)
    return reportView(r)
  })
}

/** 補充報告：原文不改，加一段；開立醫師要重新確認 */
export function addImagingAddendum(id: string, input: { text: string; significant?: boolean }): Promise<ImagingReportView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const r = must(db.imagingReports.find((x) => x.id === id), '影像報告')
    if (!reportView(r).canAddendum) fail('只有判讀醫師（放射科的報告由放射科醫師）能補充', 'FORBIDDEN')
    const text = input.text?.trim()
    failFields(text ? {} : { text: '請寫補充內容' })
    ;(r.addenda ??= []).push({ at: now(), by: u.doctorId!, text: text!, ...(input.significant ? { significant: true } : {}) })
    if (input.significant) r.significant = true
    delete r.ackAt
    delete r.ackBy
    audit('補充影像報告', `${r.no} ${nameOf.patient(r.patientId)}：${text}`)
    return reportView(r)
  })
}

/** 某天發出或補充的報告（判讀頁「已報告」）：放射科看放射科的，其他醫師看自己判讀的 */
export function listImagingReports(q: { date: string }): Promise<ImagingReportView[]> {
  return query(() => {
    const u = requireUser('doctor', 'admin')
    return db.imagingReports
      .filter((r) => r.reportedAt.startsWith(q.date) || r.addenda?.some((x) => x.at.startsWith(q.date)))
      .filter((r) => sessionRole() === 'admin' || r.readerId === u.doctorId || (imagingOf(r.procId)?.reader === 'radiology' && isRadiologist(u.doctorId)))
      .sort((a, b) => b.reportedAt.localeCompare(a.reportedAt))
      .map(reportView)
  })
}

/** 病人的影像：報告（新到舊）＋還沒判讀的（讓開單醫師知道在等什麼；能判讀的直接標出） */
export function patientImaging(patientId: string): Promise<{ reports: ImagingReportView[]; pending: (ImagingWorkItem & { canRead: boolean })[] }> {
  return query(() => {
    const u = requireUser('doctor', 'nurse', 'admin')
    const me = sessionRole() === 'doctor' ? u.doctorId : undefined
    return {
      reports: db.imagingReports.filter((r) => r.patientId === patientId).sort((a, b) => b.reportedAt.localeCompare(a.reportedAt)).map(reportView),
      pending: pendingImagingWork().filter((w) => w.patientId === patientId).map((w) => ({ ...w, canRead: !w.awaitingExam && canReadImaging(w, me) })),
    }
  })
}

/** 確認重要發現（或補充過的報告） */
export function ackImaging(id: string): Promise<ImagingReportView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const r = must(db.imagingReports.find((x) => x.id === id), '影像報告')
    if (!imagingNeedsAck(r)) fail('這份報告不需要確認，或已經確認過了', 'CONFLICT')
    if (!canAckImaging(r, u.doctorId)) fail('只有開立醫師（住院另含主治醫師）能確認', 'FORBIDDEN')
    r.ackBy = u.id
    r.ackAt = now()
    audit('確認影像報告', `${r.no} ${nameOf.patient(r.patientId)} ${find.procedure(r.procId)?.name}${r.significant ? '（重要發現）' : '（補充報告）'}`)
    return reportView(r)
  })
}

/** 待我確認的影像報告（首頁） */
export function myImagingAcks(): Promise<ImagingReportView[]> {
  return query(() => {
    const u = requireUser('doctor')
    return db.imagingReports.filter((r) => imagingNeedsAck(r) && canAckImaging(r, u.doctorId)).sort((a, b) => a.reportedAt.localeCompare(b.reportedAt)).map(reportView)
  })
}
