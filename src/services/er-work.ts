// 急診的內部工具（index 不匯出、不會被包成 API）：每天的急診診次、看板資料、首頁待辦。
// 規則在 er-rules（純函式）；API 在 er.ts
import type { ClinicSession, Visit } from '@/types'
import { db } from '@/mock/db'
import { addMinutes, ageOf } from '@/utils/date'
import { ER_DISPOSITION_LABEL, ER_STAGE_LABEL, erStage, TRIAGE_LABEL, waitState, type ErStage } from './er-rules'
import { flagsOf, type PatientFlags } from './flag-work'
import { find, nameOf } from './views'

export const erDept = () => db.departments.find((d) => d.code === 'ER' && d.active)
/** 急診醫師（急診科、啟用中）；急診診次掛在第一位名下（申報用），科內醫師都能看 */
export const erDoctors = () => db.doctors.filter((d) => d.active && d.deptId === erDept()?.id)
export const isErDoctor = (doctorId?: string) => !!doctorId && erDoctors().some((d) => d.id === doctorId)

/** 某天的急診診次（24 小時、不排門診表）：沒有就建一個 */
export function erSessionFor(date: string): ClinicSession {
  const id = `ER-${date}`
  let s = db.sessions.find((x) => x.id === id)
  if (!s) {
    const dept = erDept()
    const doc = erDoctors()[0]
    if (!dept || !doc) throw new Error('沒有急診科或急診醫師')
    s = { id, date, period: 'ER', deptId: dept.id, doctorId: doc.id, roomNo: '100', limit: 9999 }
    db.sessions.push(s)
  }
  return s
}

export interface ErBoardItem {
  visitId: string
  patientId: string
  patientName: string
  chartNo: string
  gender: string
  age: string
  allergies: string[]
  flags: PatientFlags
  level: 1 | 2 | 3 | 4 | 5
  levelLabel: string
  suggested: number
  reason?: string
  complaint: string
  vitalsText: string
  arrivedAt: string
  triagedAt: string
  triagedByName: string
  stage: ErStage
  stageLabel: string
  /** 等候（檢傷到叫號）：分鐘、目標、是否超過 */
  wait: { minutes: number; target: number; overdue: boolean }
  doctorName: string
  dispositionText?: string
  /** 待床：決定收住院後等了幾分鐘 */
  bedWaitMinutes?: number
  admissionId?: string
  history: { level: number; at: string; byName: string; reason: string }[]
}

const mins = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to.replace(' ', 'T')) - Date.parse(from.replace(' ', 'T'))) / 60000))

export function erItem(v: Visit, t: string): ErBoardItem {
  const er = v.er!
  const p = find.patient(v.patientId)
  const adm = er.disposition?.admissionId ? find.admission(er.disposition.admissionId) : undefined
  const stage = erStage(v.status, er, adm?.status)
  const x = er.vitals
  const vt = [x.temp !== undefined && `T ${x.temp}`, x.pulse !== undefined && `P ${x.pulse}`, x.resp !== undefined && `R ${x.resp}`, x.sbp !== undefined && `BP ${x.sbp}/${x.dbp ?? '—'}`, x.spo2 !== undefined && `SpO2 ${x.spo2}`, x.gcs !== undefined && `GCS ${x.gcs}`].filter(Boolean).join('・')
  const d = er.disposition
  return {
    visitId: v.id, patientId: v.patientId, patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', gender: p?.gender === 'M' ? '男' : '女',
    age: p ? `${ageOf(p.birthDate, v.date)} 歲` : '', allergies: p?.allergies ?? [], flags: flagsOf(v.patientId),
    level: er.level, levelLabel: TRIAGE_LABEL[er.level], suggested: er.suggested, ...(er.reason ? { reason: er.reason } : {}),
    complaint: er.complaint, vitalsText: vt, arrivedAt: er.arrivedAt, triagedAt: er.triagedAt, triagedByName: nameOf.user(er.triagedBy),
    stage, stageLabel: ER_STAGE_LABEL[stage], wait: waitState(er.level, er.triagedAt, v.calledAt, t), doctorName: nameOf.doctor(v.doctorId),
    ...(d ? { dispositionText: `${ER_DISPOSITION_LABEL[d.kind]}${d.hospital ? `：${d.hospital}` : ''}${adm ? `：${nameOf.dept(adm.deptId)} ${nameOf.doctor(adm.doctorId)}` : ''}${d.note ? `（${d.note}）` : ''}` } : {}),
    ...(stage === 'bed' && d ? { bedWaitMinutes: mins(d.at, t) } : {}),
    ...(adm ? { admissionId: adm.id } : {}),
    history: (er.history ?? []).map((h) => ({ level: h.level, at: h.at, byName: nameOf.user(h.by), reason: h.reason })),
  }
}

/** 急診病人（最近 24 小時到院的、或還沒結束的：待看診、看診中、待決定、待床） */
export function erVisits(t: string): Visit[] {
  const since = addMinutes(t, -24 * 60)
  return db.visits.filter((v) => v.er && v.status !== 'cancelled' && (v.er.arrivedAt >= since || ['registered', 'in-consult'].includes(v.status) || (v.er.disposition?.kind === 'admit' && find.admission(v.er.disposition.admissionId ?? '')?.status === 'reserved') || (v.status === 'consulted' && !v.er.disposition)))
}

/** 首頁：急診待看診（其中超過目標等候時間的）、待決定去向、待床 */
export function erCounts(t: string): { waiting: number; overdue: number; deciding: number; bed: number } {
  const items = erVisits(t).map((v) => erItem(v, t))
  const w = items.filter((i) => i.stage === 'waiting')
  return { waiting: w.length, overdue: w.filter((i) => i.wait.overdue).length, deciding: items.filter((i) => i.stage === 'deciding').length, bed: items.filter((i) => i.stage === 'bed').length }
}
