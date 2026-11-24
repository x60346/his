// 檢驗（醫檢師）：待檢驗清單 → 逐項登打結果 → 發報告；發出後只能「更正」（寫原因、留舊值、醫師要重新確認）。
// 醫師（與護理師）看病人的檢驗報告與趨勢；有危急值或更正過的報告，開立醫師（住院再加主治）要按「已知悉」。
//
// 待檢驗清單不另存資料，由醫令推算（還沒發報告的）：
//   門診：完成看診、已批價（先批價再到檢驗科）的檢驗醫令；櫃台標「未執行」的不列
//   住院：檢驗的臨時醫囑。護理師「執行」＝已採檢，才能發報告；還沒採檢的列在清單上但不能登打
import type { CultureIsolate, CultureSpecimen } from '@/types'
import { checkCulture, cultureValue, mdroOf, organismName, ORGANISMS, specimenLabel } from './culture-rules'
import type { Gender, LabItemDef, LabReport, LabValue } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser, sessionRole, sessionUser } from './http'
import { find, nameOf } from './views'
import { buildLabValues, labNeedsAck, labRefText } from './lab-rules'
import { issueLabReport, labTarget, nextLabNo } from './lab-issue'
import { calloutEscalated, calloutRate, calloutStatus, calloutTarget, checkCallout, checkCalloutAttempt, CALLOUT_ROLE_LABEL } from './callout-rules'
import { onCallFor } from './duty-rules'
import { addDays } from '@/utils/date'
import { calloutMinutesOf, canAckLab, careAdmissionOf, pendingLabWork, procItems, type LabWorkItem } from './lab-work'

export type { LabWorkItem }

export function listLabWork(): Promise<LabWorkItem[]> {
  return query(() => {
    requireUser('lab', 'admin')
    return pendingLabWork()
  })
}

export interface LabReportView extends LabReport {
  procName: string
  doctorName: string
  reportedByName: string
  source: 'opd' | 'ipd'
  /** 急診開的 */
  er: boolean
  /** 醫師要確認（危急值或更正過，還沒按已知悉） */
  needsAck: boolean
  /** 目前登入的醫師能不能按「已知悉」（開立醫師、住院另含主治） */
  canAck: boolean
  hasCritical: boolean
  patientName: string
  chartNo: string
  gender: Gender
  ackByName?: string
  /** 危急值通報：狀態、期限、通報人 */
  calloutState: 'none' | 'done' | 'late' | 'pending'
  calloutDue?: string
  calloutOnTime?: boolean
  /** 這份的通報時限（分鐘；主檔設定或預設） */
  calloutMinutes: number
  calloutByName?: string
  /** 沒聯絡上的次數、要不要升級、這次要通報誰（提示文字） */
  calloutTries: number
  calloutEscalated: boolean
  calloutTarget: string
  /** 住院：主治醫師；門診：同科其他醫師（升級時建議打給誰） */
  calloutSuggest: string[]
  /** 住院：病房床號；門診：科別門診 */
  where: string
  /** 檢驗值的定義＋這位病人的參考範圍（更正時畫面用來即時標示） */
  items: (LabItemDef & { ref: string })[]
}

const whereOf = (r: LabReport) => {
  const ca = careAdmissionOf(r)
  if (ca) {
    const a = ca
    const bed = a?.bedId ? find.bed(a.bedId) : undefined
    return bed ? `${bed.ward} ${bed.bedNo}` : '住院'
  }
  const e = r.encounterId ? db.encounters.find((x) => x.id === r.encounterId) : undefined
  return e ? `${nameOf.dept(e.deptId)}門診` : '門診'
}

/** 住院的主治醫師（升級通報的對象） */
const attendingOf = (r: LabReport) => careAdmissionOf(r)?.doctorId
/** 升級時建議打給誰：住院＝主治；門診＝同科其他醫師 */
function suggestOf(r: LabReport): string[] {
  const att = attendingOf(r)
  if (careAdmissionOf(r)) return att ? [nameOf.doctor(att)] : []
  const dept = find.doctor(r.doctorId)?.deptId
  return db.doctors.filter((d) => d.deptId === dept && d.id !== r.doctorId).map((d) => d.name)
}

function reportView(r: LabReport): LabReportView {
  const p = find.patient(r.patientId)
  const att = attendingOf(r)
  return {
    ...r,
    procName: find.procedure(r.procId)?.name ?? r.procId,
    doctorName: nameOf.doctor(r.doctorId),
    reportedByName: nameOf.user(r.reportedBy),
    source: r.orderId ? 'ipd' : 'opd',
    er: !!r.encounterId && !!find.visit(db.encounters.find((x) => x.id === r.encounterId)?.visitId ?? '')?.er,
    needsAck: labNeedsAck(r),
    canAck: labNeedsAck(r) && sessionRole() === 'doctor' && canAckLab(r, sessionUser()?.doctorId),
    hasCritical: r.values.some((v) => v.critical),
    patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', gender: p?.gender ?? 'M',
    ...(r.ackBy ? { ackByName: nameOf.user(r.ackBy) } : {}),
    ...((c) => ({ calloutState: c.status, ...(c.due ? { calloutDue: c.due } : {}), ...(c.ontime !== undefined ? { calloutOnTime: c.ontime } : {}) }))(calloutStatus(r, now(), calloutMinutesOf(r.procId))),
    ...(r.callout ? { calloutByName: nameOf.user(r.callout.by) } : {}),
    calloutMinutes: calloutMinutesOf(r.procId),
    calloutTries: r.calloutAttempts?.length ?? 0,
    calloutEscalated: calloutEscalated(r),
    calloutTarget: ((ca) => calloutTarget(r.orderId || ca ? 'ipd' : 'opd', calloutEscalated(r), { doctorName: nameOf.doctor(r.doctorId), ...(att ? { attendingName: nameOf.doctor(att) } : {}), ...((s) => (s ? { onCallName: nameOf.user(s.userId) } : {}))(ca ? onCallFor(db.dutyShifts, ca.deptId, now()) : undefined) }))(careAdmissionOf(r)),
    calloutSuggest: suggestOf(r),
    where: whereOf(r),
    items: procItems(r.procId).map((d) => ({ ...d, ref: labRefText(d, p?.gender ?? 'M') })),
  }
}

/** 發報告：一份檢驗醫令的所有檢驗值都要填（一次標出所有沒填好的）。細菌培養要用 reportCulture（檢體、菌種、藥敏） */
export function reportLab(input: { key: string; values: Record<string, string> }): Promise<LabReportView> {
  return mutate(() => reportView(issueLabReport(input.key, input.values ?? {}, requireUser('lab'))))
}

/**
 * 發細菌培養報告：檢體、長出的菌（最多 3 株、不重複）與各自藥敏組合的 S／I／R；沒長菌＝無菌生長。
 * 報告上的「培養結果」值由菌種推（無菌生長、MRSA、CRE、VRE、其他細菌：解除隔離看這個）；血液培養有長菌是危急值
 */
export function reportCulture(input: { key: string; specimen: CultureSpecimen; isolates: CultureIsolate[] }): Promise<LabReportView> {
  return mutate(() => {
    const u = requireUser('lab')
    const base = labTarget(input.key)
    if (base.procId !== 'P059') fail('這不是細菌培養', 'CONFLICT')
    failFields(checkCulture(input))
    const p = must(find.patient(base.patientId), '病患')
    const isolates = (input.isolates ?? []).map((x) => {
      const o = ORGANISMS.find((v) => v.id === x.organism)!
      return { organism: o.id, ast: Object.fromEntries(o.panel.map((k) => [k, x.ast[k]])) as CultureIsolate['ast'] }
    })
    const { values } = buildLabValues(procItems('P059'), { CULT: cultureValue(isolates) }, p.gender)
    if (input.specimen === 'blood' && isolates.length) values.forEach((v) => (v.critical = true))
    const t = now()
    const r: LabReport = { id: newId('LR'), no: nextLabNo(t), ...base, values, culture: { specimen: input.specimen, isolates }, reportedBy: u.id, reportedAt: t }
    db.labReports.push(r)
    const mdro = isolates.map(mdroOf).filter(Boolean)
    audit(values.some((v) => v.critical) ? '發培養報告（危急值）' : '發培養報告', `${r.no} ${p.name} ${specimenLabel(input.specimen)}：${isolates.length ? isolates.map((x) => organismName(x.organism)).join('、') : '無菌生長'}${mdro.length ? `（${mdro.join('、')}）` : ''}`)
    return reportView(r)
  })
}

/** 更正已發出的報告：寫原因、舊值留在 corrections；醫師要重新確認（清掉已知悉） */
export function correctLab(id: string, input: { values: Record<string, string>; reason: string }): Promise<LabReportView> {
  return mutate(() => {
    const u = requireUser('lab')
    const r = must(db.labReports.find((x) => x.id === id), '檢驗報告')
    // 培養報告的菌種、危急值是登打培養時設的，一般更正會重算數值、把危急值弄掉
    if (r.culture) fail('培養報告不能用一般更正（請重新登打培養結果）', 'CONFLICT')
    const why = input.reason?.trim()
    const p = must(find.patient(r.patientId), '病患')
    const { values, errors } = buildLabValues(procItems(r.procId), input.values ?? {}, p.gender)
    failFields({ ...errors, ...(why ? {} : { reason: '請寫更正原因（例：檢體溶血重驗、登打錯誤）' }) })
    const changed = values.filter((v) => r.values.find((o) => o.code === v.code)?.value !== v.value)
    if (!changed.length) failField('reason', '數值沒有改變，不需要更正')
    const before: LabValue[] = structuredClone(r.values)
    ;(r.corrections ??= []).push({ at: now(), by: u.id, reason: why!, before })
    r.values = values
    delete r.ackAt
    delete r.ackBy
    audit('更正檢驗報告', `${r.no} ${p.name}：${changed.map((v) => `${v.name} ${before.find((o) => o.code === v.code)?.value} → ${v.value}`).join('、')}（${why}）`)
    return reportView(r)
  })
}

/** 檢驗科的「已報告」：某天發出或更正的 */
export function listLabReports(q: { date: string }): Promise<LabReportView[]> {
  return query(() => {
    requireUser('lab', 'admin')
    return db.labReports
      .filter((r) => r.reportedAt.startsWith(q.date) || r.corrections?.some((c) => c.at.startsWith(q.date)))
      .sort((a, b) => b.reportedAt.localeCompare(a.reportedAt))
      .map(reportView)
  })
}

export interface LabTrend {
  code: string
  name: string
  unit?: string
  ref: string
  /** 舊到新，最多 6 筆 */
  points: { at: string; value: string; flag: LabValue['flag']; critical?: boolean }[]
}

/** 病人的檢驗報告（新到舊）與各檢驗值的趨勢（醫師、護理師、檢驗科） */
export function patientLabs(patientId: string): Promise<{ reports: LabReportView[]; trends: LabTrend[] }> {
  return query(() => {
    requireUser('doctor', 'nurse', 'lab', 'admin')
    const list = db.labReports.filter((r) => r.patientId === patientId).sort((a, b) => b.reportedAt.localeCompare(a.reportedAt))
    const trends = new Map<string, LabTrend>()
    for (const r of [...list].reverse()) {
      for (const v of r.values) {
        const t = trends.get(v.code) ?? { code: v.code, name: v.name, ...(v.unit ? { unit: v.unit } : {}), ref: v.ref, points: [] }
        t.points.push({ at: r.reportedAt, value: v.value, flag: v.flag, ...(v.critical ? { critical: true } : {}) })
        trends.set(v.code, t)
      }
    }
    return { reports: list.map(reportView), trends: [...trends.values()].map((t) => ({ ...t, points: t.points.slice(-6) })) }
  })
}

/** 危急值通報：醫檢師打電話給病房護理師或主治（門診：開立醫師），記受話者、對方已複誦；逾時照樣可以補記（標逾時） */
export function calloutLab(id: string, input: { to: string; toRole: 'nurse' | 'doctor'; readBack: boolean; note?: string }): Promise<LabReportView> {
  return mutate(() => {
    const u = requireUser('lab')
    const r = must(db.labReports.find((x) => x.id === id), '檢驗報告')
    if (!r.values.some((v) => v.critical)) fail('這份報告沒有危急值，不需要通報', 'CONFLICT')
    if (r.callout) fail('這份報告已經通報過了', 'CONFLICT')
    const escalated = calloutEscalated(r)
    failFields(checkCallout(input ?? {}, r.admissionId ? 'ipd' : 'opd', { escalated, orderingDoctor: nameOf.doctor(r.doctorId) }))
    const t = now()
    const late = calloutStatus(r, t, calloutMinutesOf(r.procId)).status === 'late'
    r.callout = { at: t, by: u.id, to: input.to.trim(), toRole: input.toRole, readBack: true, ...(input.note?.trim() ? { note: input.note.trim() } : {}), ...(escalated ? { escalated: true as const } : {}) }
    audit(late ? '危急值通報（逾時）' : '危急值通報', `${r.no} ${nameOf.patient(r.patientId)}：${r.values.filter((v) => v.critical).map((v) => `${v.name} ${v.value}`).join('、')} → ${CALLOUT_ROLE_LABEL[input.toRole]} ${r.callout.to}（已複誦${escalated ? `；前 ${r.calloutAttempts!.length} 次沒聯絡上，升級通報` : r.calloutAttempts?.length ? `；之前 ${r.calloutAttempts.length} 次沒聯絡上` : ''}）`)
    return reportView(r)
  })
}

/** 危急值打電話沒聯絡上（沒人接、不在單位）：記打給誰、幾點；連續兩次就要改通報下一層。30 分鐘時限照算，不會因此停表 */
export function calloutFailed(id: string, input: { to: string; toRole: 'nurse' | 'doctor'; note?: string }): Promise<LabReportView> {
  return mutate(() => {
    const u = requireUser('lab')
    const r = must(db.labReports.find((x) => x.id === id), '檢驗報告')
    if (!r.values.some((v) => v.critical)) fail('這份報告沒有危急值，不需要通報', 'CONFLICT')
    if (r.callout) fail('這份報告已經通報過了', 'CONFLICT')
    failFields(checkCalloutAttempt(input ?? {}, careAdmissionOf(r) ? 'ipd' : 'opd'))
    const t = now()
    ;(r.calloutAttempts ??= []).push({ at: t, by: u.id, to: input.to.trim(), toRole: input.toRole, ...(input.note?.trim() ? { note: input.note.trim() } : {}) })
    const n = r.calloutAttempts.length
    audit('危急值通報沒聯絡上', `${r.no} ${nameOf.patient(r.patientId)}：打給${CALLOUT_ROLE_LABEL[input.toRole]} ${input.to.trim()}${input.note?.trim() ? `（${input.note.trim()}）` : ''}，第 ${n} 次${calloutEscalated(r) ? '，要改通報下一層' : ''}`)
    return reportView(r)
  })
}

/** 危急值通報清單（檢驗科）：還沒通報的（逾時的在前）、今天通報過的、近 30 天通報時效達成率 */
export function calloutBoard(): Promise<{ pending: LabReportView[]; doneToday: LabReportView[]; rate: { total: number; ontime: number; pct: number } }> {
  return query(() => {
    requireUser('lab', 'admin')
    const t = now()
    const since = addDays(t.slice(0, 10), -30)
    const views = db.labReports.filter((r) => r.values.some((v) => v.critical)).map(reportView)
    return {
      pending: views.filter((v) => v.calloutState === 'pending' || v.calloutState === 'late').sort((a, b) => (a.calloutDue ?? '').localeCompare(b.calloutDue ?? '')),
      doneToday: views.filter((v) => v.callout?.at.startsWith(t.slice(0, 10))).sort((a, b) => b.callout!.at.localeCompare(a.callout!.at)),
      rate: calloutRate(db.labReports.filter((r) => r.reportedAt.slice(0, 10) >= since), t, (r) => calloutMinutesOf(r.procId)),
    }
  })
}

/** 醫師確認危急值（或更正過的報告）：記下誰、何時 */
export function ackLab(id: string): Promise<LabReportView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const r = must(db.labReports.find((x) => x.id === id), '檢驗報告')
    if (!labNeedsAck(r)) fail('這份報告不需要確認，或已經確認過了', 'CONFLICT')
    if (!canAckLab(r, u.doctorId)) fail('只有開立醫師（住院另含主治醫師）能確認', 'FORBIDDEN')
    r.ackBy = u.id
    r.ackAt = now()
    audit('確認檢驗報告', `${r.no} ${nameOf.patient(r.patientId)} ${find.procedure(r.procId)?.name}${r.values.some((v) => v.critical) ? '（危急值）' : '（更正）'}`)
    return reportView(r)
  })
}

/** 待我確認的報告（首頁、看診頁上方）：我開的，或我主治的住院病人的 */
export function myLabAcks(): Promise<LabReportView[]> {
  return query(() => {
    const u = requireUser('doctor')
    return db.labReports.filter((r) => labNeedsAck(r) && canAckLab(r, u.doctorId)).sort((a, b) => a.reportedAt.localeCompare(b.reportedAt)).map(reportView)
  })
}

