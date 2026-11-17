// 院內感染個案通報：醫師或護理師通報（種類、發生日、症狀、培養；管路相關要選當時在身上、放超過 2 天的那條管路；手術部位選手術）
// → 感染管制（權限「感染管制」，示範 dr11）判定成立或不成立（寫原因）。成立的進病房品質指標（每千管路日感染率）；
// 成立時提醒可以開接觸隔離（不自動開）。規則在 infection-rules
import type { InfectionCase, InfectionKind } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, permissionsOf, query, requirePermission, requireUser } from './http'
import { find, nameOf } from './views'
import { checkInfectionInput, INFECTION_KINDS, infectionLabel, lineDayAt, lineRelated } from './infection-rules'
import { lineKind } from './line-rules'
import { activeIsolations } from './flag-work'

export interface InfectionView extends InfectionCase {
  label: string
  patientName: string
  bedNo: string
  ward: string
  lineText?: string
  surgeryText?: string
  reportedByName: string
  decidedByName?: string
  /** 判定成立、病人目前沒有接觸隔離：提醒 */
  suggestIsolation: boolean
}

const view = (c: InfectionCase): InfectionView => {
  const a = find.admission(c.admissionId)
  const l = c.lineId ? db.lines.find((x) => x.id === c.lineId) : undefined
  const s = c.surgeryId ? db.surgeries.find((x) => x.id === c.surgeryId) : undefined
  const bed = find.bed(a?.bedId ?? '')
  return {
    ...c, label: infectionLabel(c.kind), patientName: nameOf.patient(a?.patientId), bedNo: bed?.bedNo ?? '', ward: bed?.ward ?? '',
    ...(l ? { lineText: `${lineKind(l.kind).label}（${l.site}，${l.insertedAt.slice(5, 10)} 放置，發生時第 ${lineDayAt(l.insertedAt, c.onsetAt)} 天）` } : {}),
    ...(s ? { surgeryText: `${find.procedure(s.procId)?.name ?? '手術'}（${(s.endAt ?? s.schedule?.start ?? '').slice(5, 10)}）` } : {}),
    reportedByName: nameOf.user(c.reportedBy), ...(c.decision ? { decidedByName: nameOf.user(c.decision.by) } : {}),
    suggestIsolation: c.status === 'confirmed' && !!a && !activeIsolations(a.patientId).some((i) => i.kind === 'contact'),
  }
}

export interface PatientInfections {
  admissionId: string
  cases: InfectionView[]
  /** 可以選的管路（這次住院的導尿管、CVC；含已移除的）與手術（做完的） */
  lines: { id: string; kind: string; text: string; insertedAt: string; removedAt?: string }[]
  surgeries: { id: string; text: string }[]
  canReport: boolean
  canDecide: boolean
}

export function patientInfections(admissionId: string): Promise<PatientInfections> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'admin')
    const a = must(find.admission(admissionId), '住院紀錄')
    return {
      admissionId: a.id,
      cases: db.infectionCases.filter((c) => c.admissionId === a.id).sort((x, y) => y.reportedAt.localeCompare(x.reportedAt)).map(view),
      lines: db.lines.filter((l) => l.admissionId === a.id && INFECTION_KINDS.some((k) => k.line === l.kind)).map((l) => ({ id: l.id, kind: l.kind, text: `${lineKind(l.kind).label}（${l.site}，${l.insertedAt.slice(5, 10)} 放置${l.removedAt ? `、${l.removedAt.slice(5, 10)} 移除` : ''}）`, insertedAt: l.insertedAt, ...(l.removedAt ? { removedAt: l.removedAt } : {}) })),
      surgeries: db.surgeries.filter((s) => s.admissionId === a.id && s.status === 'done').map((s) => ({ id: s.id, text: `${find.procedure(s.procId)?.name ?? '手術'}（${(s.endAt ?? '').slice(5, 10)}）` })),
      canReport: (u.role === 'nurse' || u.role === 'doctor') && a.status === 'admitted', canDecide: permissionsOf(u).includes('infection.control'),
    }
  })
}

export interface InfectionInput {
  kind: InfectionKind
  lineId?: string
  surgeryId?: string
  onsetAt: string
  symptoms: string
  culture: string
}

/** 通報（醫師、護理師）：管路相關要選管路（種類對、這次住院、發生時放超過 2 天）；手術部位要選做完的手術 */
export function reportInfection(admissionId: string, input: InfectionInput): Promise<InfectionView> {
  return mutate(() => {
    const u = requireUser('nurse', 'doctor')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
    const t = now()
    failFields(checkInfectionInput(input, t))
    if (a.admittedAt && input.onsetAt < a.admittedAt.slice(0, 10)) failField('onsetAt', '發生日期不能早於入院')
    const meta = INFECTION_KINDS.find((k) => k.kind === input.kind)!
    if (meta.line) {
      const l = input.lineId ? db.lines.find((x) => x.id === input.lineId && x.admissionId === a.id) : undefined
      if (!l || l.kind !== meta.line) failField('lineId', `請選這次住院的${lineKind(meta.line).label}`)
      if (!lineRelated(l!.insertedAt, input.onsetAt, l!.removedAt)) failField('lineId', `發生時${lineKind(meta.line).label}放不到 ${2 + 1} 天（或已移除超過一天）：不算管路相關，請改選「其他院內感染」`)
    }
    if (input.kind === 'ssi' && !db.surgeries.some((s) => s.id === input.surgeryId && s.admissionId === a.id && s.status === 'done')) failField('surgeryId', '請選這次住院做完的手術')
    if (input.kind === 'other' && a.admittedAt && input.onsetAt < addDays(a.admittedAt.slice(0, 10), 2)) failField('onsetAt', '入院 48 小時內發生的通常不是院內感染（入院時已在潛伏期）')
    const c: InfectionCase = {
      id: newId('INF'), admissionId: a.id, kind: input.kind, ...(meta.line ? { lineId: input.lineId } : {}), ...(input.kind === 'ssi' ? { surgeryId: input.surgeryId } : {}),
      onsetAt: input.onsetAt, symptoms: input.symptoms.trim(), culture: input.culture.trim(), reportedBy: u.id, reportedAt: t, status: 'reported',
    }
    db.infectionCases.push(c)
    audit('院內感染通報', `${a.admitNo} ${nameOf.patient(a.patientId)}：${meta.label}（${c.onsetAt}）`)
    return view(c)
  })
}

/** 判定（感染管制）：成立或不成立都要寫原因（依據的收案定義、或排除的理由） */
export function decideInfection(id: string, confirm: boolean, reason: string): Promise<InfectionView> {
  return mutate(() => {
    const u = requirePermission('infection.control')
    const c = must(db.infectionCases.find((x) => x.id === id), '感染個案')
    if (c.status !== 'reported') fail('已經判定過了', 'CONFLICT')
    if (!reason?.trim()) failField('reason', confirm ? '請寫成立的依據（例：符合收案定義，尿液培養 E. coli ≥10⁵）' : '請寫不成立的理由（例：入院時已有症狀、污染菌）')
    Object.assign(c, { status: confirm ? 'confirmed' : 'rejected', decision: { by: u.id, at: now(), reason: reason.trim() } })
    audit('院內感染判定', `${nameOf.patient(find.admission(c.admissionId)?.patientId)} ${infectionLabel(c.kind)}：${confirm ? '成立' : '不成立'}（${reason.trim()}）`)
    return view(c)
  })
}

/** 感染管制工作清單：待判定（舊的在前）、最近 30 天判定過的 */
export function listInfectionWork(): Promise<{ pending: InfectionView[]; decided: InfectionView[] }> {
  return query(() => {
    requirePermission('infection.control')
    const since = addDays(now().slice(0, 10), -30)
    return {
      pending: db.infectionCases.filter((c) => c.status === 'reported').sort((x, y) => x.reportedAt.localeCompare(y.reportedAt)).map(view),
      decided: db.infectionCases.filter((c) => c.status !== 'reported' && (c.decision?.at ?? '') >= since).sort((x, y) => y.decision!.at.localeCompare(x.decision!.at)).map(view),
    }
  })
}
