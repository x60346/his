// 病床與住院結束的內部工具（index 不匯出、不會被包成 API）：住院中心（admission.ts）與急診留觀（er.ts）共用，
// 排床規則（保留、隔離、留觀床只給留觀病人）只有這一份。
import type { Admission, Bed, BedStatus } from '@/types'
import { db, nextCounter } from '@/mock/db'
import { obsWard } from '@/mock/codes'
import { audit, fail, must } from './http'
import { find, nameOf } from './views'
import { placementFor } from './flag-work'

export const bedStatusLabel: Record<BedStatus, string> = { empty: '空床', occupied: '使用中', reserved: '保留', cleaning: '清潔中' }

export const isObsBed = (b: Pick<Bed, 'ward'> | undefined) => !!b && b.ward === obsWard
/** 留觀中（還沒結束）的留觀住院 */
export const obsOpen = (a: Pick<Admission, 'obs'> | undefined) => !!a?.obs && !a.obs.endAt
/** 這筆住院人在留觀床上（留觀中、或留觀轉住院還沒轉到病房） */
export const inObsBed = (a: Pick<Admission, 'bedId' | 'status'>) => a.status === 'admitted' && isObsBed(find.bed(a.bedId ?? ''))

/** 留觀床的排床規則：留觀床只給留觀中的病人；留觀中的病人只能排留觀床。沒問題回 undefined */
export function obsPlacementProblem(a: Pick<Admission, 'obs'> | undefined, bed: Pick<Bed, 'ward'>): string | undefined {
  if (isObsBed(bed) && !obsOpen(a)) return '急診留觀床只給急診留觀病人'
  if (!isObsBed(bed) && obsOpen(a)) return '留觀中的病人只能排急診留觀床（要住院請急診醫師結束留觀、決定收住院）'
  return undefined
}

/** 排床（報到、轉床、轉科選床、留觀排床都走這裡）：保留、隔離、留觀床規則 */
export function takeBed(bedId: string, admissionId: string): Bed {
  const bed = must(find.bed(bedId), '病床')
  // 保留給這位病人的床可以直接用（保留就是為了這一刻）；保留給別人的不行
  const mine = bed.status === 'reserved' && bed.reservedFor === admissionId
  if (bed.status === 'reserved' && !mine) {
    const forAdm = bed.reservedFor ? find.admission(bed.reservedFor) : undefined
    fail(`${bed.bedNo} 已保留給${forAdm ? ` ${nameOf.patient(forAdm.patientId)}` : '其他病人'}`, 'CONFLICT')
  }
  if (bed.status !== 'empty' && !mine) fail(`${bed.bedNo} 目前無法使用（${bedStatusLabel[bed.status]}）`, 'CONFLICT')
  const adm = find.admission(admissionId)
  const obs = obsPlacementProblem(adm, bed)
  if (obs) fail(`${bed.bedNo} 不能排：${obs}`, 'CONFLICT')
  // 隔離：空氣隔離只排單人房；同房的人隔離要完全一樣
  const problem = adm ? placementFor(adm.patientId, bed) : undefined
  if (problem) fail(`${bed.bedNo} 不能排：${problem}`, 'CONFLICT')
  bed.status = 'occupied'
  bed.admissionId = admissionId
  delete bed.reservedFor
  return bed
}

/** 報到（住院中心）或留觀排床（急診）：配床、產生住院號（腕帶條碼）、床位紀錄 */
export function admitInto(a: Admission, bedId: string, t: string): Bed {
  const bed = takeBed(bedId, a.id)
  releaseReservedBeds(a.id) // 有保留床卻報到在別床：保留的那床放回空床
  a.status = 'admitted'
  a.bedId = bed.id
  a.admittedAt = t
  a.bedHistory = [{ bedId: bed.id, from: t }]
  a.admitNo = `I${t.slice(2, 10).replace(/-/g, '')}${String(nextCounter('admitNo')).padStart(3, '0')}`
  return bed
}

/** 這筆住院不再需要保留床（預約取消、或報到在別床）：保留的床放回空床，免得一直佔著沒人用 */
export function releaseReservedBeds(admissionId: string): void {
  for (const b of db.beds.filter((x) => x.status === 'reserved' && x.reservedFor === admissionId)) {
    b.status = 'empty'
    delete b.reservedFor
    audit('取消保留床位', `${b.bedNo}（${nameOf.patient(find.admission(admissionId)?.patientId)}）`)
  }
}

/** 病人離開這張床：改清潔中 */
export function releaseBed(bedId?: string): void {
  if (!bedId) return
  const bed = find.bed(bedId)
  if (!bed) return
  bed.status = 'cleaning'
  bed.admissionId = undefined
}

/**
 * 住院（或留觀）結束時的醫囑與給藥排程：停止執行中的醫囑；逾時沒給的藥標「暫停：note」保留紀錄；還沒到時間的排程刪除。
 * 出院（admission.discharge）與結束留觀（er.endObservation）共用
 */
export function closeOrders(a: Admission, nurseOrDoctorId: string, t: string, note: string): void {
  for (const o of db.ipdOrders.filter((o) => o.admissionId === a.id && o.status === 'active')) {
    o.status = 'stopped'
    o.stopAt = t
  }
  for (const m of db.mar.filter((m) => m.admissionId === a.id && m.status === 'pending' && m.scheduledAt < t)) {
    Object.assign(m, { status: 'held', note, executedAt: t, nurseId: nurseOrDoctorId })
  }
  db.mar = db.mar.filter((m) => !(m.admissionId === a.id && m.status === 'pending'))
}
