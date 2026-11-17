// 病人重要標記的內部工具（index 不匯出）：目前的隔離與 DNR、病人資訊列的摘要、同房的人、這張床能不能排、
// 隔離期間的單人房天數（差額免收）。排床（admission.takeBed）、帳單（ipd-bill）、各種清單共用
import type { Bed, DnrItem, DnrRecord, Isolation, IsolationKind } from '@/types'
import { db } from '@/mock/db'
import { addDays } from '@/utils/date'
import { dnrText, placementProblem } from './flag-rules'

export const activeIsolations = (patientId: string): Isolation[] =>
  db.isolations.filter((i) => i.patientId === patientId && !i.ended).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
export const activeDnr = (patientId: string): DnrRecord | undefined => db.dnrRecords.find((d) => d.patientId === patientId && !d.revoked)

/** 病人資訊列、清單、床位圖上的標記 */
export interface PatientFlags {
  isolations: { kind: IsolationKind; organism: string; since: string }[]
  dnr?: { doc: DnrRecord['doc']; withhold: DnrItem[]; label: string; title: string }
}
export function flagsOf(patientId: string): PatientFlags {
  const d = activeDnr(patientId)
  return {
    isolations: activeIsolations(patientId).map((i) => ({ kind: i.kind, organism: i.organism, since: i.startedAt })),
    ...(d ? { dnr: { doc: d.doc, withhold: d.withhold, ...dnrText(d.withhold) } } : {}),
  }
}

const patientOfAdmission = (admissionId?: string) => (admissionId ? db.admissions.find((a) => a.id === admissionId)?.patientId : undefined)

/** 同房其他床的病人（住著的、保留給他的），不含 patientId 自己 */
export function roommatesOf(bed: Bed, patientId: string) {
  return db.beds
    .filter((b) => b.id !== bed.id && b.ward === bed.ward && b.roomNo === bed.roomNo)
    .flatMap((b) => {
      const pid = patientOfAdmission(b.status === 'occupied' ? b.admissionId : b.status === 'reserved' ? b.reservedFor : undefined)
      if (!pid || pid === patientId) return []
      return [{ bedNo: b.bedNo, name: db.patients.find((p) => p.id === pid)?.name ?? '', isolations: activeIsolations(pid) }]
    })
}

/** 這位病人能不能排這張床（依隔離）：不能的回原因 */
export const placementFor = (patientId: string, bed: Bed): string | undefined =>
  placementProblem({ isolations: activeIsolations(patientId), bedClass: bed.bedClass, roommates: roommatesOf(bed, patientId) })

/** 某一天（YYYY-MM-DD）這位病人有沒有在隔離中：開始那天算、解除那天不算 */
export const isolatedOn = (patientId: string, date: string) =>
  db.isolations.some((i) => i.patientId === patientId && i.startedAt.slice(0, 10) <= date && (!i.ended || i.ended.at.slice(0, 10) > date))

/** 從 start 起 days 天裡，有幾天在隔離中（隔離期間住單人房，差額免收） */
export function isolatedDays(patientId: string, start: string, days: number): number {
  let n = 0
  for (let k = 0; k < days; k++) if (isolatedOn(patientId, addDays(start, k))) n++
  return n
}
