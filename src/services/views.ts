// 服務層內部：查表與組合檢視資料（相當於後端的 JOIN + DTO）。
// 頁面拿到的列表已經帶好姓名、科別等顯示欄位，不必自己再到處查。
import type { Admission, Bed, ClinicSession, Patient, Visit } from '@/types'
import { db } from '@/mock/db'
import { ageOf, diffDays, today } from '@/utils/date'
import { outstandingOf, type BillingLookup } from './billing'
import { fail, must } from './http'

export const find = {
  patient: (id: string) => db.patients.find((p) => p.id === id),
  doctor: (id: string) => db.doctors.find((d) => d.id === id),
  dept: (id: string) => db.departments.find((d) => d.id === id),
  identity: (code: string) => db.identities.find((x) => x.code === code),
  drug: (id: string) => db.drugs.find((d) => d.id === id),
  procedure: (id: string) => db.procedures.find((p) => p.id === id),
  freq: (code: string) => db.frequencies.find((f) => f.code === code),
  session: (id: string) => db.sessions.find((s) => s.id === id),
  room: (roomNo: string) => db.rooms.find((r) => r.roomNo === roomNo),
  visit: (id: string) => db.visits.find((v) => v.id === id),
  encounterOfVisit: (visitId: string) => db.encounters.find((e) => e.visitId === visitId),
  bed: (id: string) => db.beds.find((b) => b.id === id),
  admission: (id: string) => db.admissions.find((a) => a.id === id),
  user: (id: string) => db.users.find((u) => u.id === id),
}

/**
 * 「可以拿來開新單」的主檔項目：存在、而且未停用。
 * 開立處方、醫囑、診斷一律走 usable；顯示歷史紀錄用 find（停用的項目在舊病歷上照常顯示）。
 * 集中在這裡，各服務就不會有的檢查、有的忘了檢查。
 */
export const usable = {
  drug(id: string) {
    const d = must(find.drug(id), `藥品 ${id}`)
    if (!d.active) fail(`${d.name} 已停用，不能開立`)
    return d
  },
  procedure(id: string) {
    const p = must(find.procedure(id), `醫令 ${id}`)
    if (!p.active) fail(`${p.name} 已停用，不能開立`)
    return p
  },
  icd(code: string) {
    const c = must(db.icdCodes.find((x) => x.code === code), `診斷碼 ${code}`)
    if (c.active === false) fail(`診斷碼 ${c.code} ${c.name} 已停用`)
    return c
  },
}

export const nameOf = {
  doctor: (id?: string) => (id ? find.doctor(id)?.name ?? id : ''),
  dept: (id?: string) => (id ? find.dept(id)?.name ?? id : ''),
  identity: (code?: string) => (code ? find.identity(code)?.name ?? code : ''),
  user: (id?: string) => (id ? find.user(id)?.name ?? id : ''),
  patient: (id?: string) => (id ? find.patient(id)?.name ?? id : ''),
}

export function billingLookup(identityCode: string): BillingLookup {
  return {
    identity: find.identity(identityCode) ?? find.identity('01')!,
    settings: db.billingSettings,
    drug: find.drug,
    procedure: find.procedure,
  }
}

/** 列表中顯示病患的精簡資訊 */
export interface PatientBrief {
  patientId: string
  chartNo: string
  patientName: string
  gender: Patient['gender']
  birthDate: string
  age: number
  allergies: string[]
  /** 尚欠金額（所有未作廢收據的欠款 − 已收回）；0 = 沒欠。掛號、批價時提醒櫃台收回 */
  debt: number
}

/** 病人目前尚欠多少（跨所有就醫） */
export const debtOf = (patientId: string) =>
  db.charges.filter((c) => c.patientId === patientId).reduce((s, c) => s + outstandingOf(c), 0)

export function patientBrief(patientId: string): PatientBrief {
  const p = find.patient(patientId)
  return {
    patientId,
    chartNo: p?.chartNo ?? '',
    patientName: p?.name ?? '（未知病患）',
    gender: p?.gender ?? 'M',
    birthDate: p?.birthDate ?? '',
    age: p ? ageOf(p.birthDate) : 0,
    allergies: p?.allergies ?? [],
    debt: debtOf(patientId),
  }
}

export interface VisitView extends Visit, PatientBrief {
  doctorName: string
  deptName: string
  identityName: string
  period: ClinicSession['period']
  roomNo: string
  /** 診間位置（掛號單用） */
  roomLocation: string
}

export function visitView(v: Visit): VisitView {
  const s = find.session(v.sessionId)
  return {
    ...v,
    ...patientBrief(v.patientId),
    doctorName: nameOf.doctor(v.doctorId),
    deptName: nameOf.dept(v.deptId),
    identityName: nameOf.identity(v.identityCode),
    period: s?.period ?? 'AM',
    roomNo: s?.roomNo ?? '',
    roomLocation: s ? (find.room(s.roomNo)?.location ?? '') : '',
  }
}

export interface AdmissionView extends Admission, PatientBrief {
  doctorName: string
  deptName: string
  bed?: Bed
  /** 住院天數（報到當天算第 1 天） */
  days: number
  /** 醫師已准予出院（病摘已簽署），等住院中心辦理 */
  dischargeReady: boolean
  /** 病摘撰寫醫師 */
  summaryDoctorName?: string
}

export function admissionView(a: Admission): AdmissionView {
  const end = a.dischargedAt ?? today()
  return {
    ...a,
    ...patientBrief(a.patientId),
    doctorName: nameOf.doctor(a.doctorId),
    deptName: nameOf.dept(a.deptId),
    bed: a.bedId ? find.bed(a.bedId) : undefined,
    days: a.admittedAt ? diffDays(a.admittedAt, end) + 1 : 0,
    dischargeReady: a.status === 'admitted' && !!a.dischargeSummary?.signedAt,
    summaryDoctorName: a.dischargeSummary ? nameOf.doctor(a.dischargeSummary.doctorId) : undefined,
  }
}

/** 文字比對（不分大小寫） */
export const contains = (text: string | undefined, kw: string) => (text ?? '').toLowerCase().includes(kw.toLowerCase())
