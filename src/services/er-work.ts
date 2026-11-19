// 急診的內部工具（index 不匯出、不會被包成 API）：每天的急診診次、看板資料、首頁待辦。
// 規則在 er-rules（純函式）；API 在 er.ts
import type { ClinicSession, Visit } from '@/types'
import { db } from '@/mock/db'
import { addMinutes, ageOf } from '@/utils/date'
import { ER_DISPOSITION_LABEL, ER_STAGE_LABEL, erStage, OBS_LONG_HOURS, OBS_TODO_HOURS, obsHours, TRIAGE_LABEL, waitState, type ErStage } from './er-rules'
import { inObsBed } from './bed-work'
import { flagsOf, type PatientFlags } from './flag-work'
import { find, nameOf } from './views'
import { erLabCounts } from './er-lab-work'

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
  /** 留觀：床號（還沒排床就沒有）、留觀幾小時、超過 24 小時（看板標紅）、超過 48 小時（首頁待辦） */
  obs?: { bedNo?: string; hours: number; long: boolean; overdue: boolean; ended: boolean; endText?: string }
  history: { level: number; at: string; byName: string; reason: string }[]
  /** 急診檢驗進度（有送出檢驗才有）：待採檢、待收件、檢驗中、已出、醫師還沒看的新報告 */
  labs?: { toCollect: number; toReceive: number; inLab: number; reported: number; fresh: number }
}

const mins = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to.replace(' ', 'T')) - Date.parse(from.replace(' ', 'T'))) / 60000))

export function erItem(v: Visit, t: string): ErBoardItem {
  const er = v.er!
  const p = find.patient(v.patientId)
  const adm = er.disposition?.admissionId ? find.admission(er.disposition.admissionId) : undefined
  const stage = erStage(v.status, er, adm ? { status: adm.status, inObsBed: inObsBed(adm) } : undefined)
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
    ...(stage === 'bed' && d ? { bedWaitMinutes: mins(er.obsEnd?.at ?? d.at, t) } : {}),
    ...(adm ? { admissionId: adm.id } : {}),
    ...(d?.kind === 'obs' ? (() => {
      const hours = obsHours(d.at, er.obsEnd?.at ?? t)
      const e = er.obsEnd
      const bed = adm?.bedId ? find.bed(adm.bedId) : undefined
      return { obs: { ...(bed ? { bedNo: bed.bedNo } : {}), hours, long: !e && hours >= OBS_LONG_HOURS, overdue: !e && hours >= OBS_TODO_HOURS, ended: !!e,
        ...(e ? { endText: `留觀 ${hours} 小時後${ER_DISPOSITION_LABEL[e.kind]}${e.hospital ? `：${e.hospital}` : ''}${e.kind === 'admit' && adm ? `：${nameOf.dept(adm.deptId)} ${nameOf.doctor(adm.doctorId)}` : ''}${e.note ? `（${e.note}）` : ''}` } : {}) } }
    })() : {}),
    history: (er.history ?? []).map((h) => ({ level: h.level, at: h.at, byName: nameOf.user(h.by), reason: h.reason })),
    ...((l) => (l ? { labs: l } : {}))(erLabCounts(v)),
  }
}

/** 看板階段（和 erItem 同一個判斷） */
export function erStageOf(v: Visit): ErStage {
  const adm = v.er?.disposition?.admissionId ? find.admission(v.er.disposition.admissionId) : undefined
  return erStage(v.status, v.er!, adm ? { status: adm.status, inObsBed: inObsBed(adm) } : undefined)
}

/** 急診病人（最近 24 小時到院的、或還沒離開急診的：待看診、看診中、待決定、留觀、待批價、待床） */
export function erVisits(t: string): Visit[] {
  const since = addMinutes(t, -24 * 60)
  return db.visits.filter((v) => v.er && v.status !== 'cancelled' && (v.er.arrivedAt >= since || !['left', 'admitted'].includes(erStageOf(v))))
}

/** 首頁：急診待看診（其中超過目標等候時間的）、待決定去向、待床 */
export function erCounts(t: string): { waiting: number; overdue: number; deciding: number; bed: number; obsBed: number; obsOverdue: number } {
  const items = erVisits(t).map((v) => erItem(v, t))
  const w = items.filter((i) => i.stage === 'waiting')
  return {
    waiting: w.length, overdue: w.filter((i) => i.wait.overdue).length, deciding: items.filter((i) => i.stage === 'deciding').length, bed: items.filter((i) => i.stage === 'bed').length,
    obsBed: items.filter((i) => i.stage === 'obs-bed').length, obsOverdue: items.filter((i) => i.obs?.overdue).length,
  }
}
