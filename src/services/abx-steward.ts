// 抗生素管理介入（感染科每日審視）：全院住院中使用的抗生素，系統依規則標建議（藥敏無效、重疊、降階、改口服、超過 7 天），
// 感染科「發出建議」（寫給主治的說明）或標「不用介入」；主治停止或修改醫囑＝接受（ipd 自動記），不接受要寫原因。
// 規則在 abx-steward-rules（純函式），療程、培養、待辦在 abx-steward-work
import type { AbxAdviceKind, AbxIntervention, LabReport } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now } from '@/utils/date'
import { audit, fail, failField, must, mutate, query, requireUser } from './http'
import { abxDay } from './abx-rules'
import { ABX_ADVICE_KINDS, ABX_ADVICE_LABEL, ABX_INTERVENTION_STATUS, abxCourseHint, type StewardFinding } from './abx-steward-rules'
import { abxDrugName, courseStartOf, handledBy, latestCulture, medHistory, stewardOf } from './abx-steward-work'
import { isInfectious } from './abx-work'
import { abxPatientPart, type AbxPatientPart } from './abx'
import { orderView, type OrderView } from './ipd'
import { requireCare } from './care-team'
import { find, nameOf } from './views'

export interface AbxInterventionView extends AbxIntervention {
  kindLabel: string
  statusLabel: string
  byName: string
  replyByName?: string
  /** 醫囑內容（Ceftriaxone 1g Inj） */
  orderText: string
  patientName: string
  bedNo: string
  attendingName: string
}

export interface StewardFindingView extends StewardFinding {
  label: string
  /** 處理過了：最近那一筆介入（重疊可能是另一筆醫囑上的） */
  handled?: AbxInterventionView
}

export interface StewardItem extends AbxPatientPart {
  order: OrderView
  /** 療程第一天、今天第幾天 */
  courseStart: string
  courseDay: number
  findings: StewardFindingView[]
  /** 還沒處理的建議幾條 */
  open: number
  /** 最近一份有長菌的培養（藥敏表） */
  culture?: { reportedAt: string; culture: NonNullable<LabReport['culture']> }
}

function interventionView(x: AbxIntervention): AbxInterventionView {
  const a = find.admission(x.admissionId)
  return {
    ...x, kindLabel: ABX_ADVICE_LABEL[x.kind], statusLabel: ABX_INTERVENTION_STATUS[x.status], byName: nameOf.user(x.by),
    ...(x.reply ? { replyByName: nameOf.user(x.reply.by) } : {}),
    orderText: db.ipdOrders.find((o) => o.id === x.orderId)?.content ?? '', patientName: nameOf.patient(a?.patientId), bedNo: find.bed(a?.bedId ?? '')?.bedNo ?? '', attendingName: nameOf.doctor(a?.doctorId),
  }
}

/**
 * 每日審視頁：住院中所有在用的抗生素（有還沒處理的建議排前面，再依建議的輕重、床號）＋介入紀錄
 * （待主治回覆的全部、其他 7 天內的）。不是感染科也能看，但只有感染科能發建議（canReview）
 */
export function listAbxStewardship(): Promise<{ canReview: boolean; items: StewardItem[]; interventions: AbxInterventionView[] }> {
  return query(() => {
    const u = requireUser('doctor')
    const t = now()
    const items = db.admissions
      .filter((a) => a.status === 'admitted')
      .flatMap((a) => {
        const { orders, findings } = stewardOf(a.id, t)
        if (!orders.length) return []
        const part = abxPatientPart(a.id, t)
        const cult = latestCulture(a.id)
        return orders.map((o): StewardItem => {
          const fs = findings.filter((f) => f.orderId === o.id).map((f) => {
            const h = handledBy(f)
            return { ...f, label: ABX_ADVICE_LABEL[f.kind], ...(h ? { handled: interventionView(h) } : {}) }
          })
          const start = courseStartOf(o)
          return { ...part, order: orderView(o), courseStart: start, courseDay: abxDay(start, t), findings: fs, open: fs.filter((f) => !f.handled).length, ...(cult?.culture ? { culture: { reportedAt: cult.reportedAt, culture: cult.culture } } : {}) }
        })
      })
      .sort((x, y) => {
        const rank = (i: StewardItem) => Math.min(...i.findings.filter((f) => !f.handled).map((f) => ABX_ADVICE_KINDS.indexOf(f.kind)), 99)
        return Number(y.open > 0) - Number(x.open > 0) || rank(x) - rank(y) || x.bedNo.localeCompare(y.bedNo)
      })
    const since = addDays(t, -7)
    const interventions = db.abxInterventions
      .filter((x) => x.status === 'sent' || (x.reply?.at ?? x.at) >= since)
      .sort((a, b) => (b.reply?.at ?? b.at).localeCompare(a.reply?.at ?? a.at))
      .map(interventionView)
    return { canReview: isInfectious(u.doctorId), items, interventions }
  })
}

/** 審視者處理一條建議前的檢查：感染科、醫囑還在、這條建議現在還成立、還沒處理過 */
function openFinding(orderId: string, kind: AbxAdviceKind) {
  const u = requireUser('doctor')
  if (!isInfectious(u.doctorId)) fail('抗生素每日審視由感染科醫師處理', 'FORBIDDEN')
  const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
  if (o.status !== 'active') fail('醫囑已停止，不用再處理', 'CONFLICT')
  if (find.admission(o.admissionId)?.status !== 'admitted') fail('病人已出院', 'CONFLICT')
  const f = stewardOf(o.admissionId, now()).findings.find((x) => x.orderId === orderId && x.kind === kind)
  if (!f) fail(`這筆醫囑目前沒有「${ABX_ADVICE_LABEL[kind]}」的建議（狀況可能已經改變，請重新整理）`, 'CONFLICT')
  const h = handledBy(f)
  if (h) fail(`這條建議已經處理過了（${nameOf.user(h.by)} ${h.at.slice(5)}：${ABX_INTERVENTION_STATUS[h.status]}）`, 'CONFLICT')
  return { u, o, f }
}

function record(orderId: string, kind: AbxAdviceKind, note: string, status: 'sent' | 'dismissed'): AbxInterventionView {
  const { u, o, f } = openFinding(orderId, kind)
  const text = note?.trim()
  if (!text) failField('note', status === 'sent' ? '請寫給主治的建議（例：E. coli 對 Augmentin 抗藥，建議改 Cephalexin 500mg QID）' : '請寫不用介入的理由（例：已和主治討論，骨髓炎需長療程）')
  const t = now()
  const x: AbxIntervention = { id: newId('ABXI'), admissionId: o.admissionId, orderId: o.id, drugId: o.drugId!, kind, finding: f.text, status, by: u.id, at: t, note: text }
  db.abxInterventions.push(x)
  const a = find.admission(o.admissionId)
  audit(status === 'sent' ? '抗生素管理：發出建議' : '抗生素管理：不用介入', `${a?.admitNo} ${nameOf.patient(a?.patientId)} ${o.content}【${ABX_ADVICE_LABEL[kind]}】${text}`)
  return interventionView(x)
}

/** 感染科發出建議：主治首頁「抗生素建議待回覆」、住院醫囑列出這條建議 */
export function sendAbxAdvice(orderId: string, kind: AbxAdviceKind, note: string): Promise<AbxInterventionView> {
  return mutate(() => record(orderId, kind, note, 'sent'))
}

/** 感染科標「不用介入」（要寫理由）：這條建議不再列在待審視 */
export function dismissAbxFinding(orderId: string, kind: AbxAdviceKind, note: string): Promise<AbxInterventionView> {
  return mutate(() => record(orderId, kind, note, 'dismissed'))
}

/** 主治（本科）不接受建議：寫原因，感染科在「最近處理」看得到。接受不用按——停止或修改這筆醫囑就是接受 */
export function declineAbxAdvice(id: string, note: string): Promise<AbxInterventionView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const x = must(db.abxInterventions.find((v) => v.id === id), '建議')
    if (x.status !== 'sent') fail(`這條建議已經回覆過（${ABX_INTERVENTION_STATUS[x.status]}）`, 'CONFLICT')
    const a = must(find.admission(x.admissionId), '住院紀錄')
    requireCare(u.doctorId, a, '回覆感染科的抗生素建議', { consult: false })
    if (!note?.trim()) failField('note', '請寫不接受的原因（例：病人臨床改善中，維持原用藥）')
    const t = now()
    Object.assign(x, { status: 'declined', reply: { by: u.id, at: t, text: note.trim() } })
    audit('抗生素管理：不接受建議', `${a.admitNo} ${nameOf.patient(a.patientId)} ${db.ipdOrders.find((o) => o.id === x.orderId)?.content}【${ABX_ADVICE_LABEL[x.kind]}】${note.trim()}`)
    return interventionView(x)
  })
}

/** 開醫囑選了抗生素：同一支 48 小時內停過（接續療程）或換同類的提示；沒有就回 null */
export function abxCourseHintOf(admissionId: string, drugId: string): Promise<{ day: number; text: string } | null> {
  return query(() => abxCourseHint(drugId, medHistory(admissionId), now(), abxDrugName) ?? null)
}
