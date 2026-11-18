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
import { awaitingReceipt } from './specimen'
import { qcBlockers } from './qc-rules'
import { opdSpecimenOf } from './specimen-work'
import { canAckLab, pendingLabWork, procItems, reportedIpd, reportedOpd, type LabWorkItem } from './lab-work'

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
  /** 醫師要確認（危急值或更正過，還沒按已知悉） */
  needsAck: boolean
  /** 目前登入的醫師能不能按「已知悉」（開立醫師、住院另含主治） */
  canAck: boolean
  hasCritical: boolean
  patientName: string
  chartNo: string
  gender: Gender
  ackByName?: string
  /** 檢驗值的定義＋這位病人的參考範圍（更正時畫面用來即時標示） */
  items: (LabItemDef & { ref: string })[]
}

function reportView(r: LabReport): LabReportView {
  const p = find.patient(r.patientId)
  return {
    ...r,
    procName: find.procedure(r.procId)?.name ?? r.procId,
    doctorName: nameOf.doctor(r.doctorId),
    reportedByName: nameOf.user(r.reportedBy),
    source: r.orderId ? 'ipd' : 'opd',
    needsAck: labNeedsAck(r),
    canAck: labNeedsAck(r) && sessionRole() === 'doctor' && canAckLab(r, sessionUser()?.doctorId),
    hasCritical: r.values.some((v) => v.critical),
    patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', gender: p?.gender ?? 'M',
    ...(r.ackBy ? { ackByName: nameOf.user(r.ackBy) } : {}),
    items: procItems(r.procId).map((d) => ({ ...d, ref: labRefText(d, p?.gender ?? 'M') })),
  }
}

function nextLabNo(at: string): string {
  const day = at.slice(0, 10).replace(/-/g, '')
  const key = `lab:${day}`
  db.counters[key] = (db.counters[key] ?? 0) + 1
  return `L${day}${String(db.counters[key]).padStart(4, '0')}`
}

/** 這筆待檢驗是誰的（門診看診的醫令、住院的臨時醫囑）：檢查能不能發報告。發報告、發培養報告共用 */
function labTarget(key: string): Pick<LabReport, 'patientId' | 'procId' | 'doctorId' | 'orderedAt' | 'encounterId' | 'orderId' | 'admissionId'> {
    const [kind, a, b] = (key ?? '').split(':')
    let base: Pick<LabReport, 'patientId' | 'procId' | 'doctorId' | 'orderedAt' | 'encounterId' | 'orderId' | 'admissionId'>
    if (kind === 'E') {
      const e = must(db.encounters.find((x) => x.id === a), '病歷')
      const x = e.procedures.find((p) => p.procId === b)
      if (!x) fail('這次看診沒有這項檢驗，請重新整理', 'CONFLICT')
      if (x!.notDone) fail('櫃台已標「未執行」（病人沒做），不能發報告', 'CONFLICT')
      const v = find.visit(e.visitId)
      if (v?.status !== 'charged' && v?.status !== 'dispensed') fail('病人還沒批價，請先到批價櫃台', 'CONFLICT')
      if (reportedOpd(e.id, b)) fail('這項已經發過報告了；要改請用「更正」', 'CONFLICT')
      const sp = opdSpecimenOf(key)
      if (!sp?.collectedAt) fail('病人還沒在抽血櫃台採檢（或還沒交回檢體），不能發報告', 'CONFLICT')
      if (!sp!.receivedAt) fail(`檢體還沒收件（條碼 ${sp!.barcode}），請先在「待收件」掃條碼收件`, 'CONFLICT')
      base = { patientId: e.patientId, procId: b, doctorId: e.doctorId, orderedAt: e.completedAt ?? e.date, encounterId: e.id }
    } else if (kind === 'O') {
      const o = must(db.ipdOrders.find((x) => x.id === a), '醫囑')
      if (o.category !== 'procedure' || !o.procId) fail('這不是檢驗醫囑')
      if (o.status === 'active') fail('護理師還沒採檢（臨時醫囑還沒執行），不能發報告', 'CONFLICT')
      if (o.status === 'stopped') fail('醫囑已停止，不能發報告', 'CONFLICT')
      const waitSp = awaitingReceipt(o.id)
      if (waitSp) fail(`檢體還沒收件（條碼 ${waitSp.barcode}），請先在「待收件」掃條碼收件`, 'CONFLICT')
      if (reportedIpd(o.id)) fail('這項已經發過報告了；要改請用「更正」', 'CONFLICT')
      base = { patientId: must(find.admission(o.admissionId), '住院').patientId, procId: o.procId!, doctorId: o.doctorId, orderedAt: o.createdAt, orderId: o.id, admissionId: o.admissionId }
    } else {
      fail('找不到這筆檢驗，請重新整理')
    }
    return base!
}

/** 發報告：一份檢驗醫令的所有檢驗值都要填（一次標出所有沒填好的）。細菌培養要用 reportCulture（檢體、菌種、藥敏） */
export function reportLab(input: { key: string; values: Record<string, string> }): Promise<LabReportView> {
  return mutate(() => {
    const u = requireUser('lab')
    const base = labTarget(input.key)
    if (base.procId === 'P059') fail('細菌培養請用培養報告登打（檢體、菌種、藥敏）', 'CONFLICT')
    const defs = procItems(base!.procId)
    if (!defs.length) fail('這個醫令沒有設定檢驗項目')
    // 品管：這份檢驗裡的品管項目今天都要通過（沒做、被拒絕都不能發）
    const qc = qcBlockers(defs.map((d) => d.code), db.qcRuns, now().slice(0, 10))
    if (qc.length) fail(`${qc.join('；')}，不能發報告（到「品管」登打）`, 'CONFLICT', 'qc')
    const p = must(find.patient(base!.patientId), '病患')
    const { values, errors } = buildLabValues(defs, input.values ?? {}, p.gender)
    failFields(errors)
    const t = now()
    const r: LabReport = { id: newId('LR'), no: nextLabNo(t), ...base!, values, reportedBy: u.id, reportedAt: t }
    db.labReports.push(r)
    const crit = values.filter((x) => x.critical)
    audit(crit.length ? '發檢驗報告（危急值）' : '發檢驗報告', `${r.no} ${p.name} ${find.procedure(r.procId)?.name}${crit.length ? `：${crit.map((x) => `${x.name} ${x.value}`).join('、')}` : ''}`)
    return reportView(r)
  })
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

