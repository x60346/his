// 管制性抗生素審核：感染科醫師審核（核准給天數、不核准要寫建議）；主治處理不核准（申覆）與核准天數快到（申請續用）。
// 開立時的把關在 ipd.createOrder（先用後審：要理由與感染部位）；規則在 abx-rules（純函式），待辦在 abx-work
import type { AbxStep, IpdOrder, VitalRecord } from '@/types'
import { db } from '@/mock/db'
import { addDays, now } from '@/utils/date'
import { audit, fail, failField, must, mutate, query, requireUser } from './http'
import { ABX_DEFAULT_DAYS, ABX_MAX_DAYS, abxDay, abxState, abxText } from './abx-rules'
import { courseStartOf } from './abx-steward-work'
import { abxInfoOf, activeAbxOrders, isAntibiotic, isInfectious, type AbxInfo } from './abx-work'
import { orderView, type OrderView } from './ipd'
import { flagsOf, type PatientFlags } from './flag-work'
import { requireCare } from './care-team'
import { find, nameOf } from './views'

/** 審核、每日審視共用的病人資料：床號、診斷、過敏、隔離、生命徵象、最近檢驗、目前所有的抗生素 */
export interface AbxPatientPart {
  admissionId: string
  admitNo: string
  bedNo: string
  patientName: string
  chartNo: string
  age: string
  diagnosis: string
  attendingName: string
  deptName: string
  allergies: string[]
  flags: PatientFlags
  latestVitals?: VitalRecord
  /** 最近的檢驗（每種一份，最新的在前，最多 4 份）：有異常的值 */
  labs: { procName: string; at: string; abnormal: string[] }[]
  /** 這位病人目前所有的抗生素（含這一筆）：「Ceftriaxone 1g Inj・使用第 5 天」 */
  antibiotics: string[]
}
export interface AbxReviewItem extends AbxPatientPart {
  order: OrderView
  abx: AbxInfo
}

function itemOf(o: IpdOrder, t: string): AbxReviewItem {
  return { order: orderView(o), abx: abxInfoOf(o.abx!, t), ...abxPatientPart(o.admissionId, t) }
}

export function abxPatientPart(admissionId: string, t: string): AbxPatientPart {
  const a = must(find.admission(admissionId), '住院紀錄')
  const p = find.patient(a.patientId)
  const latest = db.vitals.filter((v) => v.admissionId === a.id).reduce<VitalRecord | undefined>((b, v) => (!b || v.at >= b.at ? v : b), undefined)
  const seen = new Set<string>()
  const labs = db.labReports
    .filter((r) => r.patientId === a.patientId)
    .sort((x, y) => y.reportedAt.localeCompare(x.reportedAt))
    .filter((r) => !seen.has(r.procId) && seen.add(r.procId))
    .slice(0, 4)
    .map((r) => ({ procName: find.procedure(r.procId)?.name ?? r.procId, at: r.reportedAt, abnormal: r.values.filter((v) => v.flag).map((v) => `${v.name} ${v.value}${v.flag === 'H' ? '↑' : v.flag === 'L' ? '↓' : ''}`) }))
  const antibiotics = db.ipdOrders
    .filter((x) => x.admissionId === a.id && x.status === 'active' && x.category === 'medication' && isAntibiotic(find.drug(x.drugId ?? '')))
    // 一般抗生素也接續療程（修改醫囑、48 小時內停過又開）
    .map((x) => `${x.content}・${x.abx ? abxText(x.abx, t) : `使用第 ${abxDay(courseStartOf(x), t)} 天`}`)
  return {
    admissionId: a.id, admitNo: a.admitNo, bedNo: find.bed(a.bedId ?? '')?.bedNo ?? '',
    patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', age: p ? `${new Date(t).getFullYear() - Number(p.birthDate.slice(0, 4))} 歲` : '',
    diagnosis: a.diagnosis, attendingName: nameOf.doctor(a.doctorId), deptName: nameOf.dept(a.deptId), allergies: p?.allergies ?? [], flags: flagsOf(a.patientId),
    ...(latest ? { latestVitals: latest } : {}), labs, antibiotics,
  }
}

/**
 * 感染科審核頁：待審核（逾時的在前、再依送審時間）＋最近 7 天審核過的（含已停的醫囑）。
 * 不是感染科的醫師也能看（知道在等誰），但只有感染科能審（canReview）
 */
export function listAbxReviews(): Promise<{ canReview: boolean; pending: AbxReviewItem[]; decided: (AbxReviewItem & { decision: AbxStep })[] }> {
  return query(() => {
    const u = requireUser('doctor')
    const t = now()
    const pending = activeAbxOrders()
      .filter((o) => o.abx.status === 'pending')
      .sort((x, y) => Number(abxState(y.abx, t).overdue) - Number(abxState(x.abx, t).overdue) || x.abx.requestedAt.localeCompare(y.abx.requestedAt))
      .map((o) => itemOf(o, t))
    const since = addDays(t, -7)
    const decided = db.ipdOrders
      .flatMap((o) => {
        const d = o.abx?.steps.filter((s) => s.action === 'approve' || s.action === 'reject').at(-1)
        // 修改醫囑：舊的那筆被新的取代，審核紀錄跟著新的走，只列最新那筆
        return d && d.at >= since && !o.replacedBy && find.admission(o.admissionId) ? [{ ...itemOf(o, t), decision: d }] : []
      })
      .sort((x, y) => y.decision.at.localeCompare(x.decision.at))
    return { canReview: isInfectious(u.doctorId), pending, decided }
  })
}

function abxOrder(orderId: string) {
  const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
  if (!o.abx) fail('這不是管制性抗生素的醫囑')
  if (o.status !== 'active') fail('醫囑已停止，不用再審', 'CONFLICT')
  return o as IpdOrder & { abx: NonNullable<IpdOrder['abx']> }
}

/** 感染科審核：核准（核准到療程第幾天，預設 7）或不核准（要寫建議，例：建議降階為 Ceftriaxone） */
export function reviewAbx(orderId: string, input: { approve: boolean; days?: number; note?: string }): Promise<OrderView> {
  return mutate(() => {
    const u = requireUser('doctor')
    if (!isInfectious(u.doctorId)) fail('管制性抗生素由感染科醫師審核', 'FORBIDDEN')
    const o = abxOrder(orderId)
    if (o.abx.status !== 'pending') fail('這筆已經審核過了（主治申覆或申請續用後才會再送審）', 'CONFLICT')
    const t = now()
    const note = input.note?.trim() ?? ''
    if (input.approve) {
      const day = abxState(o.abx, t).day
      const days = input.days ?? ABX_DEFAULT_DAYS
      if (!Number.isInteger(days) || days < 1 || days > ABX_MAX_DAYS) failField('days', `核准天數是 1–${ABX_MAX_DAYS} 天（療程第幾天為止）`)
      if (days < day) failField('days', `今天已經是第 ${day} 天，核准天數不能比今天少`)
      Object.assign(o.abx, { status: 'approved', approvedDays: days })
      o.abx.steps.push({ action: 'approve', at: t, by: u.id, text: note || '同意使用', days })
    } else {
      if (!note) failField('note', '不核准要寫建議（例：建議降階為 Ceftriaxone、建議會診討論）')
      o.abx.status = 'rejected'
      o.abx.steps.push({ action: 'reject', at: t, by: u.id, text: note })
    }
    audit(input.approve ? '核准管制性抗生素' : '不核准管制性抗生素', `${find.admission(o.admissionId)?.admitNo} ${nameOf.patient(find.admission(o.admissionId)?.patientId)} ${o.content}：${input.approve ? `核准至第 ${o.abx.approvedDays} 天` : ''}${note ? `${input.approve ? '；' : ''}${note}` : ''}`)
    return orderView(o)
  })
}

/** 主治（本科）申覆不核准的：寫說明，回到待審核（重新起算 48 小時） */
export function appealAbx(orderId: string, note: string): Promise<OrderView> {
  return resubmit(orderId, note, 'appeal')
}

/** 主治（本科）申請續用：核准天數最後一天前後（或已超過）才能申請；回到待審核，原核准天數保留到審核完 */
export function requestAbxExtension(orderId: string, note: string): Promise<OrderView> {
  return resubmit(orderId, note, 'extend')
}

function resubmit(orderId: string, note: string, action: 'appeal' | 'extend'): Promise<OrderView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const o = abxOrder(orderId)
    requireCare(u.doctorId, must(find.admission(o.admissionId), '住院紀錄'), action === 'appeal' ? '申覆這筆抗生素' : '申請續用這筆抗生素', { consult: false })
    const t = now()
    if (action === 'appeal' && o.abx.status !== 'rejected') fail('只有審核未通過的可以申覆', 'CONFLICT')
    if (action === 'extend' && (o.abx.status !== 'approved' || !abxState(o.abx, t).extend)) fail(`核准天數最後一天前後才能申請續用（目前${o.abx.status === 'approved' ? `核准至第 ${o.abx.approvedDays} 天` : '不是核准狀態'}）`, 'CONFLICT')
    if (!note?.trim()) failField('note', action === 'appeal' ? '請寫申覆說明（例：病人對 Ceftriaxone 過敏、培養仍為抗藥菌）' : '請寫續用理由（例：骨髓炎需 6 週療程）')
    Object.assign(o.abx, { status: 'pending', requestedAt: t })
    o.abx.steps.push({ action, at: t, by: u.id, text: note.trim() })
    audit(action === 'appeal' ? '申覆管制性抗生素' : '申請續用管制性抗生素', `${find.admission(o.admissionId)?.admitNo} ${o.content}：${note.trim()}`)
    return orderView(o)
  })
}
