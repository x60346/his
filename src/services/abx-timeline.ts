// 抗生素時間軸：一位住院病人這次住院的抗生素（每支一列：給藥實心、有醫囑沒給空心）、細菌培養（送檢、報告）、
// 肌酸酐與 Vancomycin 谷濃度、感染科建議，同一條時間軸。醫師都能看。列的算法在 abx-timeline-rules（純函式）
import type { LabFlag, LabReport } from '@/types'
import { db } from '@/mock/db'
import { today } from '@/utils/date'
import { must, query, requireUser } from './http'
import { daysBetween, timelineRows, type TimelineRow } from './abx-timeline-rules'
import { ABX_ADVICE_LABEL, ABX_INTERVENTION_STATUS } from './abx-steward-rules'
import { organismName, specimenLabel } from './culture-rules'
import { isAntibiotic } from './abx-work'
import { find } from './views'

export interface AbxTimeline {
  admissionId: string
  from: string
  to: string
  days: string[]
  rows: (TimelineRow & { name: string; restricted: boolean })[]
  /** 這次住院的細菌培養：送檢（開立）與報告時間、結果摘要；點了看藥敏 */
  cultures: { id: string; orderedAt: string; reportedAt: string; specimen: string; summary: string; culture: NonNullable<LabReport['culture']> }[]
  /** 肌酸酐（腎功能）、Vancomycin 谷濃度 */
  labs: { at: string; kind: 'cre' | 'vant'; label: string; value: number; flag: LabFlag }[]
  /** 感染科的建議（發出的時間） */
  advice: { at: string; kindLabel: string; statusLabel: string; note: string; orderText: string }[]
}

export function abxTimeline(admissionId: string): Promise<AbxTimeline> {
  return query(() => {
    requireUser('doctor')
    const a = must(find.admission(admissionId), '住院紀錄')
    const from = (a.admittedAt ?? a.reservedAt ?? today()).slice(0, 10)
    const to = (a.dischargedAt ?? today()).slice(0, 10)
    const days = daysBetween(from, to)
    const os = db.ipdOrders.filter((o) => o.admissionId === a.id && o.category === 'medication' && o.drugId && isAntibiotic(find.drug(o.drugId)))
    const ids = new Set(os.map((o) => o.id))
    const drugOf = new Map(os.map((o) => [o.id, o.drugId!]))
    const rows = timelineRows(
      days,
      // 臨時醫囑只有開立那天；停了、做完的到停止那天
      os.map((o) => ({ drugId: o.drugId!, startAt: o.startAt, ...(o.status !== 'active' ? { stopAt: o.stopAt ?? o.startAt } : o.type === 'stat' ? { stopAt: o.startAt } : {}) })),
      db.mar.filter((m) => ids.has(m.orderId) && m.status === 'given' && m.executedAt).map((m) => ({ drugId: drugOf.get(m.orderId)!, at: m.executedAt! })),
    ).map((r) => {
      const d = find.drug(r.drugId)
      return { ...r, name: d?.generic ?? r.drugId, restricted: !!d?.restrictedAbx }
    })
    const inRange = (at: string) => at.slice(0, 10) >= from && at.slice(0, 10) <= to
    const cultures = db.labReports
      .filter((r) => r.admissionId === a.id && r.culture)
      .sort((x, y) => x.reportedAt.localeCompare(y.reportedAt))
      .map((r) => ({
        id: r.id, orderedAt: r.orderedAt, reportedAt: r.reportedAt, specimen: specimenLabel(r.culture!.specimen),
        summary: r.culture!.isolates.length ? r.culture!.isolates.map((i) => organismName(i.organism)).join('、') : '無菌生長', culture: r.culture!,
      }))
    const labs = db.labReports
      .filter((r) => r.patientId === a.patientId && inRange(r.reportedAt))
      .flatMap((r) => r.values.filter((v) => v.code === 'CRE' || v.code === 'VANT').map((v) => ({ at: r.reportedAt, kind: v.code === 'CRE' ? ('cre' as const) : ('vant' as const), label: v.code === 'CRE' ? '肌酸酐' : '谷濃度', value: Number(v.value), flag: v.flag })))
      .sort((x, y) => x.at.localeCompare(y.at))
    const advice = db.abxInterventions
      .filter((x) => x.admissionId === a.id && x.status !== 'dismissed')
      .sort((x, y) => x.at.localeCompare(y.at))
      .map((x) => ({ at: x.at, kindLabel: ABX_ADVICE_LABEL[x.kind], statusLabel: ABX_INTERVENTION_STATUS[x.status], note: x.note, orderText: db.ipdOrders.find((o) => o.id === x.orderId)?.content ?? '' }))
    return { admissionId: a.id, from, to, days, rows, cultures, labs, advice }
  })
}
