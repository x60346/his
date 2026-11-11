// 住院中心：預約、報到配床、轉床、出院、病床狀態。
// 狀態：reserved →（報到）admitted →（出院）discharged；預約可取消為 cancelled。
// 病床：empty → occupied（報到）→ cleaning（出院或轉出）→ empty（清潔完成）。
import type { Admission, AdmissionStatus, Bed, BedStatus } from '@/types'
import { db, nextCounter, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, fieldErrors, must, mutate, query, requireUser } from './http'
import { admissionView, find, patientBrief, type AdmissionView, type PatientBrief } from './views'

export function listAdmissions(q: { status?: AdmissionStatus[]; ward?: string; patientId?: string } = {}): Promise<AdmissionView[]> {
  return query(() =>
    db.admissions
      .filter(
        (a) =>
          (!q.status || q.status.includes(a.status)) &&
          (!q.patientId || a.patientId === q.patientId) &&
          (!q.ward || (a.bedId && find.bed(a.bedId)?.ward === q.ward)),
      )
      .sort((a, b) => (b.admittedAt ?? b.reservedAt).localeCompare(a.admittedAt ?? a.reservedAt))
      .map(admissionView),
  )
}

export const getAdmission = (id: string): Promise<AdmissionView> => query(() => admissionView(must(find.admission(id), '住院紀錄')))

export interface BedView extends Bed {
  patient?: PatientBrief
  admission?: Admission
}

export function listBeds(ward?: string): Promise<BedView[]> {
  return query(() =>
    db.beds
      .filter((b) => !ward || b.ward === ward)
      .map((b) => {
        const adm = b.admissionId ? find.admission(b.admissionId) : undefined
        return { ...b, admission: adm, patient: adm ? patientBrief(adm.patientId) : undefined }
      }),
  )
}

export type ReserveInput = Pick<Admission, 'patientId' | 'deptId' | 'doctorId' | 'preferBedClass' | 'reason' | 'diagnosis' | 'expectedDate' | 'fromVisitId'>

export function reserve(input: ReserveInput): Promise<Admission> {
  return mutate(() => {
    requireUser('clerk', 'doctor', 'nurse')
    const p = must(find.patient(input.patientId), '病患')
    must(find.doctor(input.doctorId), '主治醫師')
    if (!input.diagnosis.trim()) fail('請輸入入院診斷')
    if (input.expectedDate < today()) fail('預計入院日不可早於今天')
    if (db.admissions.some((a) => a.patientId === p.id && (a.status === 'reserved' || a.status === 'admitted'))) {
      fail(`${p.name} 已有住院預約或正在住院中`, 'CONFLICT')
    }
    const a: Admission = { ...input, id: newId('A'), admitNo: '', status: 'reserved', reservedAt: now() }
    db.admissions.push(a)
    audit('住院預約', `${p.name} ${input.diagnosis}`)
    return a
  })
}

export function cancelReservation(id: string): Promise<Admission> {
  return mutate(() => {
    requireUser('clerk', 'nurse')
    const a = must(find.admission(id), '住院紀錄')
    if (a.status !== 'reserved') fail('只有預約中的住院可以取消', 'CONFLICT')
    a.status = 'cancelled'
    audit('取消住院預約', find.patient(a.patientId)?.name ?? '')
    return a
  })
}

function takeBed(bedId: string, admissionId: string): Bed {
  const bed = must(find.bed(bedId), '病床')
  if (bed.status !== 'empty') fail(`${bed.bedNo} 目前無法使用（${bedStatusLabel[bed.status]}）`, 'CONFLICT')
  bed.status = 'occupied'
  bed.admissionId = admissionId
  return bed
}

function releaseBed(bedId?: string): void {
  if (!bedId) return
  const bed = find.bed(bedId)
  if (!bed) return
  bed.status = 'cleaning'
  bed.admissionId = undefined
}

export const bedStatusLabel: Record<BedStatus, string> = { empty: '空床', occupied: '使用中', reserved: '保留', cleaning: '清潔中' }

/** 報到：配床、產生住院號 */
export function checkIn(admissionId: string, bedId: string): Promise<AdmissionView> {
  return mutate(() => {
    requireUser('clerk', 'nurse')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'reserved') fail('此住院紀錄不是預約狀態', 'CONFLICT')
    const bed = takeBed(bedId, a.id)
    const t = now()
    a.status = 'admitted'
    a.bedId = bed.id
    a.admittedAt = t
    a.admitNo = `I${t.slice(2, 10).replace(/-/g, '')}${String(nextCounter('admitNo')).padStart(3, '0')}`
    audit('住院報到', `${a.admitNo} ${find.patient(a.patientId)?.name} → ${bed.bedNo}`)
    return admissionView(a)
  })
}

export function transferBed(admissionId: string, bedId: string): Promise<AdmissionView> {
  return mutate(() => {
    requireUser('clerk', 'nurse')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('只有住院中的病人可以轉床')
    if (a.bedId === bedId) fail('與目前床位相同')
    const from = find.bed(a.bedId ?? '')?.bedNo
    releaseBed(a.bedId)
    const bed = takeBed(bedId, a.id)
    a.bedId = bed.id
    audit('轉床', `${a.admitNo} ${from} → ${bed.bedNo}`)
    return admissionView(a)
  })
}

/**
 * 訊息不能指向不存在的功能：本系統沒有轉科，要明說
 * （以前寫「跨科請辦理轉科」，使用者會到處找轉科按鈕）。對話框提示與服務層錯誤共用這一句。
 */
export const NO_TRANSFER_NOTE = '跨科轉科（換科別、主治與病房）本展示系統未提供'

/** 可以接手的主治醫師：同一科、在職、不是目前的主治（跨科是「轉科」，牽涉科別與床位，不在此處理） */
function attendingCandidates(a: Admission) {
  return db.doctors.filter((d) => d.active && d.deptId === a.deptId && d.id !== a.doctorId)
}

export function listAttendingCandidates(admissionId: string): Promise<{ id: string; name: string; title: string }[]> {
  return query(() => attendingCandidates(must(find.admission(admissionId), '住院紀錄')).map((d) => ({ id: d.id, name: d.name, title: d.title })))
}

/**
 * 變更主治醫師：住院中或預約住院的病人改由同科另一位醫師負責（醫師離職、休假、交班）。
 * 由住院中心（掛號批價、護理師）或醫師執行；管理員不執行臨床操作——停用醫師前，請住院中心先變更。
 * 變更紀錄只增不改（attendingHistory）；已開立的醫囑、病程紀錄不改，它們記的是當時的開立者。
 */
export function changeAttending(admissionId: string, doctorId: string, reason: string): Promise<AdmissionView> {
  return mutate(() => {
    const u = requireUser('clerk', 'nurse', 'doctor')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted' && a.status !== 'reserved') fail('只有住院中或預約住院的病人可以變更主治醫師', 'CONFLICT')
    const to = find.doctor(doctorId)
    const v = fieldErrors()
    if (!to) v.add('doctorId', '請選擇新的主治醫師')
    if (!reason?.trim()) v.add('reason', '請填寫變更原因')
    v.done()
    if (to!.id === a.doctorId) failField('doctorId', '與目前的主治醫師相同')
    if (!to!.active) failField('doctorId', `${to!.name} 已停用`)
    if (to!.deptId !== a.deptId) failField('doctorId', `${to!.name} 不是${find.dept(a.deptId)?.name ?? '同一科'}的醫師；${NO_TRANSFER_NOTE}`)
    const from = a.doctorId
    a.attendingHistory = [...(a.attendingHistory ?? []), { from, to: to!.id, at: now(), by: u.id, reason: reason.trim() }]
    a.doctorId = to!.id
    audit('變更主治醫師', `${a.admitNo || '（預約）'} ${find.patient(a.patientId)?.name}：${find.doctor(from)?.name} → ${to!.name}（${reason.trim()}）`)
    return admissionView(a)
  })
}

/** 出院：停止所有醫囑、刪除未執行的給藥排程、病床改為清潔中 */
export function discharge(admissionId: string, input: { dischargeType: string; dischargeSummary: string }): Promise<AdmissionView> {
  return mutate(() => {
    requireUser('doctor', 'nurse', 'clerk')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('只有住院中的病人可以辦理出院', 'CONFLICT')
    if (!input.dischargeType) fail('請選擇出院轉歸')
    const t = now()
    for (const o of db.ipdOrders.filter((o) => o.admissionId === a.id && o.status === 'active')) {
      o.status = 'stopped'
      o.stopAt = t
    }
    db.mar = db.mar.filter((m) => !(m.admissionId === a.id && m.status === 'pending'))
    releaseBed(a.bedId)
    Object.assign(a, { status: 'discharged', dischargedAt: t, ...input })
    audit('出院', `${a.admitNo} ${find.patient(a.patientId)?.name}（${input.dischargeType}）`)
    return admissionView(a)
  })
}

/** 病床狀態維護：清潔完成、保留／取消保留 */
export function setBedStatus(bedId: string, status: Exclude<BedStatus, 'occupied'>): Promise<Bed> {
  return mutate(() => {
    requireUser('clerk', 'nurse')
    const bed = must(find.bed(bedId), '病床')
    if (bed.status === 'occupied') fail('使用中的病床不可直接變更狀態', 'CONFLICT')
    bed.status = status
    return bed
  })
}
