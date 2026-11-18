// 感染管制統計、群聚、法定傳染病通報（權限 infection.control，示範 dr11；通報病人的主治也可以）：
//   - 指標：最近 30 天各病房的院內感染密度（每千住院人日）、CAUTI／CLABSI／VAP（每千管路日）、合計
//   - 群聚：同病房 14 天內兩例以上同菌種或同感染部位（沒被判定不成立的個案），確認（寫處置）或排除（寫原因）
//   - 法定傳染病：隔離原因或住院診斷符合（開放性肺結核 24 小時、結核病 7 天、流感／新冠併發重症要在加護病房）→ 待通報、
//     時限前 24 小時「快到期」、過了「逾時」；通報產生單號（模擬，不連線疾管署）
// 規則在 ipc-rules
import { db, newId, nextCounter } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { icuWard, wards } from '@/mock/codes'
import { audit, fail, failFields, must, mutate, permissionsOf, query, requirePermission, requireUser, sessionRole, sessionUser } from './http'
import { find, nameOf } from './views'
import { careRoleOf } from './care-team'
import { lineDays } from './line-rules'
import { INFECTION_KINDS, per1000 } from './infection-rules'
import { checkClusterDecision, notifyState } from './ipc-rules'
import { currentClusters, pendingNotifiable, wardOfCase, type NotifiablePending } from './ipc-work'

const canIpc = () => {
  const u = sessionUser()
  const role = sessionRole()
  return !!u && !!role && role !== 'admin' && permissionsOf({ ...u, role }).includes('infection.control')
}

export interface IpcStats {
  from: string
  to: string
  rows: { ward: string; patientDays: number; hai: number; density: number | null; devices: { kind: string; short: string; lineDays: number; cases: number; rate: number | null }[] }[]
  total: IpcStats['rows'][number]
}
/** 各病房與合計的院內感染指標（判定成立、期間內發生） */
export function infectionStats(days = 30): Promise<IpcStats> {
  return query(() => {
    requirePermission('infection.control')
    const to = today()
    const from = addDays(to, -(days - 1))
    const confirmed = db.infectionCases.filter((c) => c.status === 'confirmed' && c.onsetAt >= from && c.onsetAt <= to)
    const devKinds = INFECTION_KINDS.filter((k) => k.line)
    const rowOf = (ward: string | undefined) => {
      const adms = db.admissions.filter((a) => a.admittedAt && a.status !== 'cancelled' && a.status !== 'reserved' && (!ward || (a.bedId ? find.bed(a.bedId)?.ward === ward : false)))
      const ids = new Set(adms.map((a) => a.id))
      const patientDays = adms.reduce((n, a) => n + lineDays({ insertedAt: a.admittedAt!, removedAt: a.dischargedAt }, from, to), 0)
      const cs = confirmed.filter((c) => (ward ? wardOfCase(c) === ward : ids.has(c.admissionId)))
      return {
        ward: ward ?? '全院', patientDays, hai: cs.length, density: per1000(cs.length, patientDays),
        devices: devKinds.map((k) => {
          const ls = db.lines.filter((l) => ids.has(l.admissionId) && l.kind === k.line)
          const ld = ls.reduce((n, l) => n + lineDays(l, from, to), 0)
          const n = cs.filter((c) => c.kind === k.kind).length
          return { kind: k.kind, short: k.short, lineDays: ld, cases: n, rate: per1000(n, ld) }
        }),
      }
    }
    return { from, to, rows: [...wards, icuWard].map(rowOf), total: rowOf(undefined) }
  })
}

export function listClusters(): Promise<{ clusters: (ReturnType<typeof currentClusters>[number] & { cases: { id: string; patientName: string; bedNo: string; onsetAt: string; culture: string; status: string }[]; byName?: string })[]; canDecide: boolean }> {
  return query(() => {
    requirePermission('infection.control')
    return {
      clusters: currentClusters().map((cl) => ({
        ...cl,
        cases: cl.caseIds.map((id) => {
          const c = db.infectionCases.find((x) => x.id === id)!
          const a = find.admission(c.admissionId)
          return { id, patientName: nameOf.patient(a?.patientId), bedNo: find.bed(a?.bedId ?? '')?.bedNo ?? '', onsetAt: c.onsetAt, culture: c.culture, status: c.status }
        }),
        ...(cl.decision ? { byName: nameOf.user(cl.decision.by) } : {}),
      })).sort((x, y) => Number(!!x.decision) - Number(!!y.decision) || y.to.localeCompare(x.to)),
      canDecide: canIpc(),
    }
  })
}

export function decideCluster(key: string, input: { confirm: boolean; note: string }): Promise<{ ok: true }> {
  return mutate(() => {
    const u = requirePermission('infection.control')
    if (u.role === 'admin') fail('群聚判定要由感染管制醫師或護理師處理', 'FORBIDDEN')
    const cl = currentClusters().find((c) => c.key === key)
    if (!cl) fail('找不到這個群聚（個案可能已判定不成立）', 'CONFLICT')
    if (cl!.decision) fail('這個群聚已經判定過了', 'CONFLICT')
    failFields(checkClusterDecision(input))
    db.clusterDecisions.push({ key, status: input.confirm ? 'confirmed' : 'excluded', note: input.note.trim(), by: u.id, at: now() })
    audit(input.confirm ? '確認群聚' : '排除群聚', `${cl!.ward} ${cl!.label}（${cl!.caseIds.length} 例）：${input.note.trim()}`)
    return { ok: true as const }
  })
}

export interface NotifiableView extends NotifiablePending {
  patientName: string
  bedNo: string
  ward: string
  state: 'ok' | 'soon' | 'overdue'
}
const pendingView = (p: NotifiablePending, t: string): NotifiableView => {
  const a = find.admission(p.admissionId)
  const bed = find.bed(a?.bedId ?? '')
  return { ...p, patientName: nameOf.patient(p.patientId), bedNo: bed?.bedNo ?? '', ward: bed?.ward ?? '', state: notifyState(p.dueAt, t) }
}
/** 感染管制頁：全院待通報（逾時、快到期在前）、最近 30 天通報過的 */
export function listNotifiable(): Promise<{ pending: NotifiableView[]; reported: (import('@/types').NotifiableReport & { patientName: string; reportedByName: string; late: boolean })[] }> {
  return query(() => {
    requirePermission('infection.control')
    const t = now()
    const rank = { overdue: 0, soon: 1, ok: 2 }
    return {
      pending: db.admissions.flatMap(pendingNotifiable).map((p) => pendingView(p, t)).sort((x, y) => rank[x.state] - rank[y.state] || x.dueAt.localeCompare(y.dueAt)),
      reported: db.notifiableReports.filter((r) => r.reportedAt >= addDays(today(), -30)).sort((x, y) => y.reportedAt.localeCompare(x.reportedAt)).map((r) => ({ ...r, patientName: nameOf.patient(r.patientId), reportedByName: nameOf.user(r.reportedBy), late: r.reportedAt > r.dueAt })),
    }
  })
}
/** 病人的待通報（隔離分頁） */
export function patientNotifiable(patientId: string): Promise<{ patientId: string; pending: NotifiableView[]; reported: import('@/types').NotifiableReport[]; canReport: boolean }> {
  return query(() => {
    const u = requireUser()
    const t = now()
    const a = db.admissions.find((x) => x.patientId === patientId && x.status === 'admitted')
    const role = a ? careRoleOf(u.doctorId, a) : null
    return {
      patientId,
      pending: a ? pendingNotifiable(a).map((p) => pendingView(p, t)) : [],
      reported: db.notifiableReports.filter((r) => r.patientId === patientId).sort((x, y) => y.reportedAt.localeCompare(x.reportedAt)),
      canReport: sessionRole() === 'doctor' && (canIpc() || (!!role && role.kind !== 'consult')),
    }
  })
}

/** 通報（主治、照護團隊醫師或感染管制）：產生通報單號（模擬） */
export function reportNotifiable(patientId: string, disease: string, input: { note?: string } = {}): Promise<import('@/types').NotifiableReport> {
  return mutate(() => {
    const u = requireUser('doctor', 'nurse')
    const a = must(db.admissions.find((x) => x.patientId === patientId && x.status === 'admitted'), '住院中的病人')
    const role = careRoleOf(u.doctorId, a)
    if (!canIpc() && (u.role !== 'doctor' || !role || role.kind === 'consult')) fail('法定傳染病通報由主治（照護團隊）或感染管制處理', 'FORBIDDEN')
    const p = pendingNotifiable(a).find((x) => x.disease === disease)
    if (!p) fail('這位病人沒有待通報的這項疾病（可能已經通報過了）', 'CONFLICT')
    const t = now()
    const cdcNo = `CDC${t.slice(0, 10).replace(/-/g, '')}${String(nextCounter(`cdc:${t.slice(0, 10)}`)).padStart(4, '0')}`
    const r = { id: newId('NR'), patientId, admissionId: a.id, disease: p!.disease, label: p!.label, triggeredAt: p!.triggeredAt, dueAt: p!.dueAt, reportedAt: t, reportedBy: u.id, cdcNo, ...(input.note?.trim() ? { note: input.note.trim() } : {}) }
    db.notifiableReports.push(r)
    audit('法定傳染病通報', `${nameOf.patient(patientId)}：${p!.label}（${cdcNo}）${t > p!.dueAt ? '（逾時）' : ''}`)
    return r
  })
}
