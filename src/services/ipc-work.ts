// 感染管制的內部工具（index 不匯出、不會被包成 API）：個案在哪個病房、目前的群聚（含判定）、法定傳染病待通報。
// 規則在 ipc-rules
import type { Admission, InfectionCase } from '@/types'
import { db } from '@/mock/db'
import { addDays, today } from '@/utils/date'
import { find } from './views'
import { inIcu } from './icu-work'
import { findClusters, notifiableOf, notifyDueAt } from './ipc-rules'

/** 個案在哪個病房：發生那天住的床（床位紀錄），沒有就用目前（或最後）的床 */
export function wardOfCase(c: Pick<InfectionCase, 'admissionId' | 'onsetAt'>): string {
  const a = find.admission(c.admissionId)
  const hist = a?.bedHistory ?? []
  const at = `${c.onsetAt.slice(0, 10)} 23:59`
  const h = [...hist].filter((x) => x.from <= at).pop() ?? hist[hist.length - 1]
  return find.bed(h?.bedId ?? a?.bedId ?? '')?.ward ?? ''
}

/** 最近 60 天、沒被判定不成立的個案找群聚，帶上判定 */
export function currentClusters() {
  const from = addDays(today(), -60)
  const cases = db.infectionCases.filter((c) => c.status !== 'rejected' && c.onsetAt >= from)
  return findClusters(cases.map((c) => ({ id: c.id, ward: wardOfCase(c), kind: c.kind, culture: c.culture, onsetAt: c.onsetAt }))).map((cl) => {
    const d = db.clusterDecisions.find((x) => x.key === cl.key)
    return { ...cl, ...(d ? { decision: d } : {}) }
  })
}

export interface NotifiablePending {
  patientId: string
  admissionId: string
  disease: string
  label: string
  /** 依據：隔離原因或診斷 */
  basis: string
  triggeredAt: string
  dueAt: string
}
/** 住院中的病人：隔離原因或住院診斷符合法定傳染病、還沒通報的 */
export function pendingNotifiable(a: Admission): NotifiablePending[] {
  if (a.status !== 'admitted') return []
  const out: NotifiablePending[] = []
  const icu = inIcu(a)
  const sources = [
    ...db.isolations.filter((i) => i.patientId === a.patientId && !i.ended).map((i) => ({ text: i.organism, at: i.startedAt, basis: `隔離：${i.organism}` })),
    { text: a.diagnosis, at: a.admittedAt ?? a.reservedAt, basis: `診斷：${a.diagnosis}` },
  ]
  for (const s of sources) {
    const n = notifiableOf(s.text, icu)
    if (!n || out.some((x) => x.disease === n.key)) continue
    if (db.notifiableReports.some((r) => r.patientId === a.patientId && r.disease === n.key && r.reportedAt >= addDays(s.at.slice(0, 10), -30))) continue
    out.push({ patientId: a.patientId, admissionId: a.id, disease: n.key, label: n.label, basis: s.basis, triggeredAt: s.at, dueAt: notifyDueAt(s.at, n.hours) })
  }
  return out
}
