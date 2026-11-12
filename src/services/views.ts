// 服務層內部：查表與組合檢視資料（相當於後端的 JOIN + DTO）。
// 頁面拿到的列表已經帶好姓名、科別等顯示欄位，不必自己再到處查。
import type { Admission, DeptTransfer, Bed, ClinicSession, Diagnosis, Drug, MedicationOrder, Patient, ProcedureOrder, Visit } from '@/types'
import { db } from '@/mock/db'
import { ageOf, diffDays, today } from '@/utils/date'
import { outstandingOf, type BillingLookup } from './billing'
import { fail, must } from './http'
import { openQuery } from './nursing-rules'
import { checkInProblem } from './queue-rules'

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

/**
 * 把一批舊的診斷／藥品／處置帶進新處方之前，濾掉已停用的（組套、同前次共用同一份判斷）。
 * 和 usable.* 同一個標準，只是不丟錯：停用的列在 skipped，讓頁面告訴醫師哪些沒帶入。
 */
export function pickUsable(src: { diagnoses: Diagnosis[]; medications: MedicationOrder[]; procedures: ProcedureOrder[] }) {
  const skipped: string[] = []
  const keep = <X>(items: X[], ok: (x: X) => boolean, label: (x: X) => string) =>
    structuredClone(items).filter((x) => {
      if (ok(x)) return true
      skipped.push(label(x))
      return false
    })
  const medications = keep(src.medications, (m) => !!find.drug(m.drugId)?.active, (m) => find.drug(m.drugId)?.name ?? m.drugId)
  const procedures = keep(src.procedures, (p) => !!find.procedure(p.procId)?.active, (p) => find.procedure(p.procId)?.name ?? p.procId)
  const diagnoses = keep(src.diagnoses, (d) => { const c = db.icdCodes.find((x) => x.code === d.icd); return !!c && c.active !== false }, (d) => `診斷 ${d.icd}`)
  return { diagnoses, medications, procedures, skipped }
}

/**
 * 庫存地點（小型只有一個藥局；大型是藥庫＋多個藥局）。哪裡發門診藥、哪裡收採購，由地點主檔的旗標決定，
 * 各服務一律用這幾個函式，不自己寫死「藥局」——同一套程式跑兩種規模。
 */
export const stockLoc = {
  /** 門診發藥的藥局：醫師開藥看的「可用量」、藥局發藥扣的都是這裡 */
  opd: () => (db.stockLocations.find((l) => l.dispensesOpd && l.active) ?? db.stockLocations[0]).id,
  /** 住院調劑（UD）、病房常備扣的地點：大型＝住院藥局；小型＝唯一的藥局 */
  ipd: () => (db.stockLocations.find((l) => l.dispensesIpd && l.active) ?? db.stockLocations.find((l) => l.dispensesOpd && l.active) ?? db.stockLocations[0]).id,
  /** 採購到貨入庫的地點 */
  receiving: () => (db.stockLocations.find((l) => l.receivesPurchase && l.active) ?? db.stockLocations[0]).id,
  /** 指定的地點（沒指定＝門診藥局）；不存在或停用就擋 */
  usable(id?: string) {
    const loc = must(db.stockLocations.find((l) => l.id === (id || stockLoc.opd())), '庫存地點')
    if (!loc.active) fail(`${loc.name}已停用`)
    return loc
  },
  /** 某藥在某地點的批號 */
  lots: (drugId: string, locationId: string) => db.drugLots.filter((l) => l.drugId === drugId && l.locationId === locationId),
  /**
   * 盲盤：這種藥在這個地點正在盤點（清點中、待覆核）就回傳盤點單號——帳上數量不給看。
   * 由服務層遮掉（回 0 並標出單號），不是畫面藏起來：資料根本不出去
   */
  counting: (drugId: string, locationId: string) =>
    db.stocktakes.find((s) => (s.status === 'counting' || s.status === 'submitted') && s.locationId === locationId && s.lines.some((l) => l.drugId === drugId))?.no,
  /** 撥往這個地點、運送中還沒簽收的量（藥庫已扣、藥局還沒入；庫存頁另外標出來） */
  inTransit: (drugId: string, locationId: string) =>
    db.transfers.filter((x) => x.status === 'issued' && x.toLocationId === locationId).flatMap((x) => x.lines).filter((l) => l.drugId === drugId).reduce((n, l) => n + (l.issuedQty ?? 0), 0),
  /** 某藥在某地點的安全庫存（沒設定就用藥品主檔的值） */
  safety: (drug: Pick<Drug, 'id' | 'safetyStock'>, locationId: string) => db.safetyStocks.find((x) => x.locationId === locationId && x.drugId === drug.id)?.qty ?? drug.safetyStock,
}

export const nameOf = {
  doctor: (id?: string) => (id ? find.doctor(id)?.name ?? id : ''),
  dept: (id?: string) => (id ? find.dept(id)?.name ?? id : ''),
  identity: (code?: string) => (code ? find.identity(code)?.name ?? code : ''),
  user: (id?: string) => (id ? find.user(id)?.name ?? id : ''),
  location: (id?: string) => (id ? db.stockLocations.find((l) => l.id === id)?.name ?? id : ''),
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
  /** 現在可以報到（今天、候診中、還沒報到；規則 checkInProblem，服務層 checkIn 用同一條） */
  canCheckIn: boolean
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
    canCheckIn: !checkInProblem(v, today()),
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
  /** 待醫師回覆的醫囑疑問數 */
  openQueries: number
  /** 最近一筆轉科申請（申請中、或剛被婉拒／接受／撤回的那筆）；從未申請過沒有 */
  lastTransfer?: DeptTransferView
}

export interface DeptTransferView extends DeptTransfer {
  fromDeptName: string
  toDeptName: string
  fromDoctorName: string
  toDoctorName?: string
  requestedByName: string
  decidedByName?: string
}

/** 申請中的轉科（同一時間最多一筆） */
export const openDeptTransfer = (a: Pick<Admission, 'deptTransfers'>) => a.deptTransfers?.find((x) => x.status === 'pending')

export const deptTransferView = (x: DeptTransfer): DeptTransferView => ({
  ...x,
  fromDeptName: nameOf.dept(x.fromDeptId),
  toDeptName: nameOf.dept(x.toDeptId),
  fromDoctorName: nameOf.doctor(x.fromDoctorId),
  ...(x.toDoctorId ? { toDoctorName: nameOf.doctor(x.toDoctorId) } : {}),
  requestedByName: nameOf.user(x.requestedBy),
  ...(x.decidedBy ? { decidedByName: nameOf.user(x.decidedBy) } : {}),
})

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
    // 護理師提出、待醫師回覆的醫囑疑問（醫師的住院病人清單標出來）
    openQueries: db.ipdOrders.filter((o) => o.admissionId === a.id && !!openQuery(o)).length,
    ...(a.deptTransfers?.length ? { lastTransfer: deptTransferView(a.deptTransfers[a.deptTransfers.length - 1]) } : {}),
  }
}

/** 文字比對（不分大小寫） */
export const contains = (text: string | undefined, kw: string) => (text ?? '').toLowerCase().includes(kw.toLowerCase())
