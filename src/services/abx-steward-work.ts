// 抗生素管理的內部工具（index 不匯出）：病人的抗生素療程從哪天算、最近一次長菌的培養、能不能進食、
// 每日審視的建議（規則在 abx-steward-rules）、哪些已處理過、各種待辦（首頁、審視頁、住院醫囑共用），
// 以及主治停止／修改醫囑時把待回覆的建議記為「已接受」
import type { AbxIntervention, DietKind, IpdOrder, LabReport } from '@/types'
import { db } from '@/mock/db'
import { ABX_ADVICE_LABEL, abxCourseStart, stewardFindings, type StewardFinding } from './abx-steward-rules'
import { isAntibiotic } from './abx-work'
import { perDayOf, renalOf } from './renal-work'
import { find, nameOf } from './views'

/** 建議裡寫藥名用學名（Amoxicillin/Clavulanate），商品名留在醫囑上 */
export const abxDrugName = (id: string) => find.drug(id)?.generic ?? id

/** 同一次住院的給藥醫囑（含已停的）：算療程、換同類提示用 */
export const medHistory = (admissionId: string) => db.ipdOrders.filter((o) => o.admissionId === admissionId && o.category === 'medication')

/** 療程第一天：管制性抗生素存在 abx.courseStart；其他抗生素往回接（修改的前身、48 小時內停過又開） */
export const courseStartOf = (o: IpdOrder) => o.abx?.courseStart ?? abxCourseStart(o, medHistory(o.admissionId))

/** 執行中的抗生素醫囑（長期、不是需要時） */
export const activeAbxOf = (admissionId: string) =>
  db.ipdOrders.filter((o) => o.admissionId === admissionId && o.status === 'active' && o.category === 'medication' && o.type === 'long' && o.freq !== 'PRN' && isAntibiotic(find.drug(o.drugId ?? '')))

/** 這次住院最近一份有長菌的培養報告（無菌生長的追蹤培養不算：用藥看的是長出來的那株） */
export const latestCulture = (admissionId: string): LabReport | undefined =>
  db.labReports.filter((r) => r.admissionId === admissionId && r.culture?.isolates.length).sort((a, b) => b.reportedAt.localeCompare(a.reportedAt))[0]

/** 目前的飲食（執行中最新的飲食醫囑）；沒開飲食醫囑回 undefined（不知道能不能吃，就不建議改口服） */
export function dietOf(admissionId: string): DietKind | undefined {
  return db.ipdOrders.filter((o) => o.admissionId === admissionId && o.category === 'diet' && o.status === 'active').sort((a, b) => b.startAt.localeCompare(a.startAt))[0]?.diet?.kind
}

/** 一位住院病人的每日審視：執行中的抗生素和規則標出的建議 */
export function stewardOf(admissionId: string, t: string): { orders: IpdOrder[]; findings: StewardFinding[] } {
  const orders = activeAbxOf(admissionId)
  if (!orders.length) return { orders, findings: [] }
  const findings = stewardFindings({
    orders: orders.map((o) => ({ id: o.id, drugId: o.drugId!, route: o.route, freq: o.freq, startAt: o.startAt, courseStart: courseStartOf(o), ...(o.abx?.status === 'approved' && o.abx.approvedDays ? { approvedDays: o.abx.approvedDays } : {}) })),
    isolates: latestCulture(admissionId)?.culture?.isolates ?? [],
    diet: dietOf(admissionId),
    now: t,
    drugName: abxDrugName,
    renal: { crcl: renalOf(admissionId, t).crcl, bandsOf: (id) => find.drug(id)?.renal, perDay: perDayOf },
  })
  return { orders, findings }
}

/**
 * 這條建議處理過了沒：同一筆醫囑、同一類有介入紀錄（發出、不用介入、接受、不接受都算）。
 * 重疊是兩筆一起的：對其中一筆處理過（例：建議停 Ceftriaxone），另一筆的重疊也算處理過
 */
export function handledBy(f: StewardFinding): AbxIntervention | undefined {
  const ids = [f.orderId, ...(f.kind === 'overlap' ? f.withOrderIds ?? [] : [])]
  return db.abxInterventions.filter((x) => x.kind === f.kind && ids.includes(x.orderId)).sort((a, b) => b.at.localeCompare(a.at))[0]
}

const admitted = () => db.admissions.filter((a) => a.status === 'admitted')

/** 感染科待審視：有還沒處理的建議的抗生素醫囑幾筆 */
export function stewardTodoCount(t: string): number {
  return admitted().reduce((n, a) => n + new Set(stewardOf(a.id, t).findings.filter((f) => !handledBy(f)).map((f) => f.orderId)).size, 0)
}

/** 待主治回覆的建議（住院中、醫囑還在執行）；給 doctorId 就只算他的病人 */
export function openAdvice(doctorId?: string): AbxIntervention[] {
  return db.abxInterventions.filter((x) => {
    if (x.status !== 'sent') return false
    const a = find.admission(x.admissionId)
    return a?.status === 'admitted' && (!doctorId || a.doctorId === doctorId) && db.ipdOrders.find((o) => o.id === x.orderId)?.status === 'active'
  })
}

export interface AbxAdviceView {
  id: string
  kindLabel: string
  finding: string
  note: string
  byName: string
  at: string
}

/** 醫囑列上的「感染科建議」：這筆醫囑待回覆的 */
export function adviceOfOrder(orderId: string): AbxAdviceView[] {
  return db.abxInterventions
    .filter((x) => x.orderId === orderId && x.status === 'sent')
    .map((x) => ({ id: x.id, kindLabel: ABX_ADVICE_LABEL[x.kind], finding: x.finding, note: x.note, byName: nameOf.user(x.by), at: x.at }))
}

/** 主治停止或修改了這筆醫囑：待回覆的建議記為「已接受」（回覆寫做了什麼） */
export function acceptAdviceOn(order: IpdOrder, by: string, t: string, text: string): number {
  const list = db.abxInterventions.filter((x) => x.orderId === order.id && x.status === 'sent')
  for (const x of list) Object.assign(x, { status: 'accepted', reply: { by, at: t, text } })
  return list.length
}
