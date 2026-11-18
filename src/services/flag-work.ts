// 病人重要標記的內部工具（index 不匯出）：目前的隔離與 DNR、病人資訊列的摘要、同房的人、這張床能不能排、
// 隔離期間的單人房天數（差額免收）。排床（admission.takeBed）、帳單（ipd-bill）、各種清單共用
import type { Bed, DnrItem, DnrRecord, Isolation, IsolationKind } from '@/types'
import { db } from '@/mock/db'
import { addDays } from '@/utils/date'
import { dnrText, placementProblem } from './flag-rules'
import { icuWard } from '@/mock/codes'
import { shiftRange } from './nursing-rules'
import { negativeAdmitProblem, pressureState } from './pressure-rules'
import { mdroOf, organismName } from './culture-rules'

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
  placementProblem({ isolations: activeIsolations(patientId), bedClass: bed.bedClass, roommates: roommatesOf(bed, patientId), negative: !!bed.negativePressure, icu: bed.ward === icuWard })

/**
 * 培養出多重抗藥菌（MRSA、CRE、VRE；最近 30 天的報告）、但沒有對應的接觸隔離：提醒醫師開接觸隔離。
 * 「對應」＝隔離中的接觸隔離原因寫了那個菌（例：MRSA（傷口））
 */
export function mdroAlertsOf(patientId: string, t: string): { reportId: string; no: string; at: string; mdro: string; organism: string }[] {
  const from = addDays(t.slice(0, 10), -30)
  const isos = activeIsolations(patientId).filter((i) => i.kind === 'contact').map((i) => i.organism.toUpperCase())
  const out: { reportId: string; no: string; at: string; mdro: string; organism: string }[] = []
  for (const r of db.labReports.filter((x) => x.patientId === patientId && x.culture && x.reportedAt.slice(0, 10) >= from)) {
    for (const iso of r.culture!.isolates) {
      const m = mdroOf(iso)
      if (m && !isos.some((o) => o.includes(m)) && !out.some((x) => x.mdro === m)) out.push({ reportId: r.id, no: r.no, at: r.reportedAt, mdro: m, organism: organismName(iso.organism) })
    }
  }
  return out
}

/** 負壓隔離室這一班的壓差狀態 */
export function negativeRoomState(bed: Bed, t: string) {
  const { start } = shiftRange(t)
  return pressureState(db.pressureLogs.filter((l) => l.bedId === bed.id && l.at >= start && l.at <= t))
}
/**
 * 新排床（報到、轉床、保留）時的負壓把關：空氣隔離的病人排進負壓室，這一班要有正常的壓差紀錄。
 * 只用在「新排進去」：已經住著的病人不會因為這班還沒記錄就被標成床位不合
 */
export function negativeAdmitFor(patientId: string, bed: Bed, t: string): string | undefined {
  if (!bed.negativePressure || !activeIsolations(patientId).some((i) => i.kind === 'airborne')) return undefined
  return negativeAdmitProblem(bed.bedNo, negativeRoomState(bed, t).state)
}

/** 某一天（YYYY-MM-DD）這位病人有沒有在隔離中：開始那天算、解除那天不算 */
export const isolatedOn = (patientId: string, date: string) =>
  db.isolations.some((i) => i.patientId === patientId && i.startedAt.slice(0, 10) <= date && (!i.ended || i.ended.at.slice(0, 10) > date))

/** 從 start 起 days 天裡，有幾天在隔離中（隔離期間住單人房，差額免收） */
export function isolatedDays(patientId: string, start: string, days: number): number {
  let n = 0
  for (let k = 0; k < days; k++) if (isolatedOn(patientId, addDays(start, k))) n++
  return n
}
