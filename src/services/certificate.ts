// 診斷證明書：醫師開立（門診看診中／完成後、住院中），費用跟著那次帳單收（certificate-fee），收費後才能列印。
//   收費前：醫師可改內容、改份數、作廢（費用跟著調整）
//   收費後：內容鎖定；寫錯只能「作廢重開」——換新字號、留紀錄，重開的不另收費（不必走退費）
import type { MedicalCertificate } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failFields, must, mutate, query, requireUser, sessionRole } from './http'
import { find, nameOf } from './views'
import { requireCare } from './care-team'
import { activeIpdChargeOf } from './ipd-bill'
import { CERT_MAX_COPIES } from './certificate-rules'


export interface CertificateInput {
  diagnoses: string
  advice: string
  purpose: string
  copies: number
}

/** 這張證明書的費用收了沒（門診：那次掛號已批價；住院：住院已結帳） */
function feePaid(c: Pick<MedicalCertificate, 'encounterId' | 'admissionId'>): boolean {
  if (c.encounterId) {
    const e = db.encounters.find((x) => x.id === c.encounterId)
    const v = e ? find.visit(e.visitId) : undefined
    return v?.status === 'charged' || v?.status === 'dispensed'
  }
  return !!c.admissionId && !!activeIpdChargeOf(c.admissionId)
}

export interface CertificateView extends MedicalCertificate {
  doctorName: string
  doctorLicenseNo: string
  deptName: string
  /** 列印用的病人資料 */
  patient: { name: string; gender: string; birthDate: string; idNo: string; address: string; chartNo: string }
  feePaid: boolean
  /** 醫師可以直接改、作廢（還沒收費、沒作廢） */
  editable: boolean
  /** 可以列印（費用已收、沒作廢） */
  printable: boolean
  /** 收費後才能作廢重開 */
  reissuable: boolean
  replacesNo?: string
  replacedByNo?: string
}

function view(c: MedicalCertificate): CertificateView {
  const p = must(find.patient(c.patientId), '病患')
  const doc = find.doctor(c.doctorId)
  const paid = feePaid(c) // 作廢重開的跟著原本那張收（同一次帳單）
  const live = !c.voided
  return {
    ...c,
    doctorName: doc?.name ?? c.doctorId, doctorLicenseNo: doc?.licenseNo ?? '', deptName: nameOf.dept(c.deptId),
    patient: { name: p.name, gender: p.gender === 'M' ? '男' : '女', birthDate: p.birthDate, idNo: p.idNo, address: p.address, chartNo: p.chartNo },
    feePaid: paid, editable: live && !paid, printable: live && paid, reissuable: live && paid,
    ...(c.replaces ? { replacesNo: db.certificates.find((x) => x.id === c.replaces)?.no } : {}),
    ...(c.voided?.replacedBy ? { replacedByNo: db.certificates.find((x) => x.id === c.voided!.replacedBy)?.no } : {}),
  }
}

function checkInput(input: CertificateInput) {
  const e: Record<string, string> = {}
  if (!input.diagnoses?.trim()) e.diagnoses = '請填寫病名'
  if (!input.advice?.trim()) e.advice = '請填寫醫師囑言（例：宜休養三日）'
  if (!input.purpose?.trim()) e.purpose = '請選擇用途'
  if (!Number.isInteger(input.copies) || input.copies < 1 || input.copies > CERT_MAX_COPIES) e.copies = `份數為 1–${CERT_MAX_COPIES} 的整數`
  failFields(e)
}

/** 證明書字號：民國年＋流水號（每年重編） */
function nextNo(at: string): string {
  const roc = Number(at.slice(0, 4)) - 1911
  return `${roc} 診字第 ${String(nextCounter(`cert:${roc}`)).padStart(6, '0')} 號`
}

/** 開立的對象與權限：門診＝這次看診的醫師、叫號後；住院＝本科醫師（主治、值班代理） */
function target(input: { encounterId?: string; admissionId?: string }) {
  const u = requireUser('doctor')
  if (input.encounterId) {
    const e = must(db.encounters.find((x) => x.id === input.encounterId), '病歷')
    const v = must(find.visit(e.visitId), '掛號紀錄')
    if (v.doctorId !== u.doctorId) fail('只能替自己看的病人開立證明書', 'FORBIDDEN')
    return { u, base: { patientId: e.patientId, encounterId: e.id, deptId: e.deptId, doctorId: u.doctorId!, visitDate: e.date }, defaultDx: e.diagnoses.map((d) => `${d.icd} ${d.name}`).join('\n') }
  }
  const a = must(find.admission(input.admissionId ?? ''), '住院紀錄')
  if (a.status === 'reserved') fail('病人還沒住院', 'CONFLICT')
  requireCare(u.doctorId, a, '開立診斷證明書', { consult: false })
  const stayTo = (a.dischargedAt ?? now()).slice(0, 10)
  return { u, base: { patientId: a.patientId, admissionId: a.id, deptId: a.deptId, doctorId: u.doctorId!, stayFrom: (a.admittedAt ?? a.reservedAt).slice(0, 10), stayTo }, defaultDx: a.dischargeSummary?.diagnosis || a.diagnosis }
}

/** 開立前的預設內容（病名帶這次的診斷） */
export function certificateDraft(input: { encounterId?: string; admissionId?: string }): Promise<CertificateInput & { visitDate?: string; stayFrom?: string; stayTo?: string }> {
  return query(() => {
    const { base, defaultDx } = target(input)
    return { diagnoses: defaultDx, advice: '', purpose: '請假', copies: 1, ...('visitDate' in base ? { visitDate: base.visitDate } : { stayFrom: base.stayFrom, stayTo: base.stayTo }) }
  })
}

/** 開立：還沒收費才能開（費用跟著這次帳單） */
export function issueCertificate(input: CertificateInput & { encounterId?: string; admissionId?: string }): Promise<CertificateView> {
  return mutate(() => {
    const { u, base } = target(input)
    if (feePaid(base)) fail(input.encounterId ? '這次看診已批價：證明書費收不到了，請櫃台作廢收據重新批價後再開' : '住院已結帳：請櫃台作廢重結後再開', 'CONFLICT')
    checkInput(input)
    const t = now()
    const c: MedicalCertificate = { id: newId('MC'), no: nextNo(t), ...base, diagnoses: input.diagnoses.trim(), advice: input.advice.trim(), purpose: input.purpose.trim(), copies: input.copies, issuedAt: t }
    db.certificates.push(c)
    audit('開立診斷證明書', `${c.no} ${nameOf.patient(c.patientId)} ${c.copies} 份（${c.purpose}）${u.name}`)
    return view(c)
  })
}

/** 修改：收費前、開立的醫師本人 */
export function updateCertificate(id: string, input: CertificateInput): Promise<CertificateView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const c = must(db.certificates.find((x) => x.id === id), '證明書')
    if (c.doctorId !== u.doctorId) fail('只有開立的醫師可以修改', 'FORBIDDEN')
    if (!view(c).editable) fail(c.voided ? '這張已作廢' : '費用已收，內容不能直接改：請用「作廢重開」', 'CONFLICT')
    checkInput(input)
    Object.assign(c, { diagnoses: input.diagnoses.trim(), advice: input.advice.trim(), purpose: input.purpose.trim(), copies: input.copies, updatedAt: now() })
    audit('修改診斷證明書', `${c.no} ${nameOf.patient(c.patientId)} ${c.copies} 份`)
    return view(c)
  })
}

/** 作廢：收費前（費用跟著拿掉）；收費後請用作廢重開 */
export function voidCertificate(id: string, reason: string): Promise<CertificateView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const c = must(db.certificates.find((x) => x.id === id), '證明書')
    if (c.doctorId !== u.doctorId) fail('只有開立的醫師可以作廢', 'FORBIDDEN')
    if (!view(c).editable) fail(c.voided ? '這張已作廢' : '費用已收：請用「作廢重開」（重開不另收費）', 'CONFLICT')
    const why = reason?.trim()
    failFields(why ? {} : { reason: '請寫作廢原因' })
    c.voided = { at: now(), by: u.id, reason: why! }
    audit('作廢診斷證明書', `${c.no} ${nameOf.patient(c.patientId)}：${why}`)
    return view(c)
  })
}

/** 作廢重開：收費後寫錯——原本那張作廢（留紀錄），換新字號開一張，不另收費、份數不能比原本多 */
export function reissueCertificate(id: string, input: CertificateInput & { reason: string }): Promise<CertificateView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const old = must(db.certificates.find((x) => x.id === id), '證明書')
    if (old.doctorId !== u.doctorId) fail('只有開立的醫師可以作廢重開', 'FORBIDDEN')
    if (!view(old).reissuable) fail(old.voided ? '這張已作廢' : '還沒收費：直接修改就好', 'CONFLICT')
    const why = input.reason?.trim()
    checkInput(input)
    failFields(why ? {} : { reason: '請寫重開原因（例：病名寫錯）' })
    if (input.copies > old.copies) failFields({ copies: `重開不另收費，份數不能超過原本的 ${old.copies} 份` })
    const t = now()
    const { id: _id, no: _no, voided: _v, printed: _p, updatedAt: _u, replaces: _r, ...keep } = old
    const nc: MedicalCertificate = { ...keep, id: newId('MC'), no: nextNo(t), diagnoses: input.diagnoses.trim(), advice: input.advice.trim(), purpose: input.purpose.trim(), copies: input.copies, issuedAt: t, replaces: old.replaces ?? old.id }
    db.certificates.push(nc)
    old.voided = { at: t, by: u.id, reason: why!, replacedBy: nc.id }
    audit('作廢重開診斷證明書', `${old.no} → ${nc.no} ${nameOf.patient(old.patientId)}：${why}`)
    return view(nc)
  })
}

/** 證明書清單：某次看診、某次住院、或某位病人（新的在前） */
export function listCertificates(q: { encounterId?: string; admissionId?: string; patientId?: string }): Promise<CertificateView[]> {
  return query(() => {
    requireUser('doctor', 'clerk', 'nurse', 'admin')
    return db.certificates
      .filter((c) => (q.encounterId ? c.encounterId === q.encounterId : q.admissionId ? c.admissionId === q.admissionId : c.patientId === q.patientId))
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
      .map(view)
  })
}

/** 列印（記下誰、何時印的）：費用收了才可以；醫師、櫃台可印 */
export function printCertificate(id: string): Promise<CertificateView> {
  return mutate(() => {
    const u = requireUser('doctor', 'clerk')
    const c = must(db.certificates.find((x) => x.id === id), '證明書')
    const v = view(c)
    if (c.voided) fail('這張已作廢', 'CONFLICT')
    if (!v.printable) fail('證明書費還沒收：請病人先到櫃台批價（住院：出院結帳）', 'CONFLICT')
    ;(c.printed ??= []).push({ at: now(), by: u.id })
    audit('列印診斷證明書', `${c.no} ${nameOf.patient(c.patientId)}${sessionRole() === 'clerk' ? '（櫃台）' : ''}${c.printed.length > 1 ? `（第 ${c.printed.length} 次）` : ''}`)
    return view(c)
  })
}

/** 現在能不能在這次看診／住院開證明書（畫面決定要不要顯示「開立」；開立時服務層照樣檢查） */
export function certificateIssuable(q: { encounterId?: string; admissionId?: string }): Promise<{ ok: boolean; reason?: string }> {
  return query(() => {
    if (sessionRole() !== 'doctor') return { ok: false, reason: '只有醫師可以開立' }
    try {
      const { base } = target(q)
      if (feePaid(base)) return { ok: false, reason: q.encounterId ? '這次看診已批價，不能再開（要開請櫃台作廢收據重新批價）' : '住院已結帳，不能再開（要開請櫃台作廢重結）' }
      if ('admissionId' in base && find.admission(base.admissionId!)?.status === 'discharged') return { ok: false, reason: '病人已出院' }
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  })
}
