// 安寧共同照護：
//   - 主治（本科照護團隊）提出照會（原因）；同一時間一筆
//   - 安寧醫師（權限 palliative，示範 dr01 家醫科）：末期評估（疾病別＋兩位專科醫師確認）＋照護目標 → 收案；或婉拒（寫原因）
//   - 收案後：每週至少訪視一次（五項症狀 0–10、評估與處置、靈性與社會需求；每次帶入一次安寧共照費）、家屬會議（主治也能記）
//   - 收案的病人：NEWS2 高分不自動呼叫快速反應小組（主治首頁仍有 NEWS2 警示）；死亡算「預期死亡」
// 規則在 palliative-rules
import type { IpdOrder, PalliativeCase, SymptomKey } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failFields, must, mutate, permissionsOf, query, requirePermission, requireUser, sessionRole, sessionUser } from './http'
import { find, nameOf } from './views'
import { careRoleOf, requireCare } from './care-team'
import { activeDnr } from './flag-work'
import { dnrText } from './flag-rules'
import { checkFamilyMeeting, checkPalliativeDecision, checkPalliativeRequest, checkPalliativeVisit, SYMPTOMS, visitDueOf } from './palliative-rules'

const admittedOf = (id: string) => {
  const a = must(find.admission(id), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return a
}
const openCaseOf = (admissionId: string) => db.palliativeCases.find((c) => c.admissionId === admissionId && (c.status === 'requested' || c.status === 'enrolled'))
const canPalliative = () => {
  const u = sessionUser()
  const role = sessionRole()
  return !!u && role === 'doctor' && permissionsOf({ ...u, role }).includes('palliative')
}
/** 安寧醫師（要醫師；管理員有權限也只能看） */
function requirePalliativeDoctor() {
  const u = requirePermission('palliative')
  if (u.role !== 'doctor') fail('安寧收案、訪視要由安寧醫師處理', 'FORBIDDEN')
  return u
}

export interface PalliativeView extends PalliativeCase {
  patientName: string
  bedNo: string
  ward: string
  diagnosis: string
  attendingName: string
  requestedByName: string
  decidedByName?: string
  terminalDoctorNames?: string[]
  visitsView: (PalliativeCase['visits'][number] & { byName: string; severe: string[] })[]
  meetingsView: (PalliativeCase['meetings'][number] & { byName: string })[]
  visitDue?: ReturnType<typeof visitDueOf>
  /** 最近一次的症狀 */
  latest?: Record<SymptomKey, number>
}
function view(c: PalliativeCase, t: string): PalliativeView {
  const a = find.admission(c.admissionId)
  const bed = find.bed(a?.bedId ?? '')
  const visits = [...c.visits].sort((x, y) => x.at.localeCompare(y.at))
  return {
    ...c,
    patientName: nameOf.patient(a?.patientId), bedNo: bed?.bedNo ?? '', ward: bed?.ward ?? '', diagnosis: a?.diagnosis ?? '', attendingName: nameOf.doctor(a?.doctorId ?? ''),
    requestedByName: nameOf.user(c.requestedBy),
    ...(c.decidedBy ? { decidedByName: nameOf.user(c.decidedBy) } : {}),
    ...(c.terminal ? { terminalDoctorNames: c.terminal.doctorIds.map((d) => nameOf.doctor(d)) } : {}),
    visitsView: visits.map((v) => ({ ...v, byName: nameOf.user(v.by), severe: SYMPTOMS.filter((s) => v.symptoms[s.key] >= 7).map((s) => s.label) })),
    meetingsView: c.meetings.map((m) => ({ ...m, byName: nameOf.user(m.by) })),
    ...(a?.status === 'admitted' ? { visitDue: visitDueOf(c, t) } : {}),
    ...(visits.length ? { latest: visits[visits.length - 1].symptoms } : {}),
  }
}

export interface PatientPalliative {
  admissionId: string
  current?: PalliativeView
  /** 以前的（婉拒、撤回） */
  past: PalliativeView[]
  dnr?: string
  canRequest: boolean
  /** 安寧醫師：收案／婉拒、訪視 */
  isTeam: boolean
  /** 主治（照護團隊）：撤回、記家屬會議 */
  isCare: boolean
  doctors: { id: string; name: string; deptName: string }[]
}
export function patientPalliative(admissionId: string): Promise<PatientPalliative> {
  return query(() => {
    const u = requireUser()
    const a = must(find.admission(admissionId), '住院紀錄')
    const t = now()
    const cur = openCaseOf(a.id)
    const role = careRoleOf(u.doctorId, a)
    const isCare = sessionRole() === 'doctor' && !!role && role.kind !== 'consult'
    const dnr = activeDnr(a.patientId)
    return {
      admissionId: a.id,
      ...(cur ? { current: view(cur, t) } : {}),
      past: db.palliativeCases.filter((c) => c.admissionId === a.id && c !== cur).map((c) => view(c, t)),
      ...(dnr ? { dnr: dnrText(dnr.withhold).label } : {}),
      canRequest: isCare && a.status === 'admitted' && !cur && !a.death,
      isTeam: canPalliative(),
      isCare,
      doctors: db.doctors.filter((d) => d.active).map((d) => ({ id: d.id, name: d.name, deptName: nameOf.dept(d.deptId) })),
    }
  })
}

export function requestPalliative(admissionId: string, input: { reason: string }): Promise<PalliativeView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = admittedOf(admissionId)
    requireCare(u.doctorId, a, '提出安寧照會', { consult: false })
    if (a.death) fail('病人已宣告死亡', 'CONFLICT')
    if (openCaseOf(a.id)) fail('已經有安寧照會（待收案或收案中）', 'CONFLICT')
    failFields(checkPalliativeRequest(input))
    const t = now()
    const c: PalliativeCase = { id: newId('PAL'), admissionId: a.id, status: 'requested', requestedBy: u.id, requestedAt: t, reason: input.reason.trim(), visits: [], meetings: [] }
    db.palliativeCases.push(c)
    audit('安寧照會', `${a.admitNo} ${nameOf.patient(a.patientId)}：${c.reason}`)
    return view(c, t)
  })
}

export function cancelPalliative(id: string): Promise<PalliativeView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const c = must(db.palliativeCases.find((x) => x.id === id), '安寧照會')
    if (c.status !== 'requested') fail('已經處理過了（收案後請由安寧醫師結案）', 'CONFLICT')
    requireCare(u.doctorId, admittedOf(c.admissionId), '撤回安寧照會', { consult: false })
    c.status = 'cancelled'
    Object.assign(c, { decidedBy: u.id, decidedAt: now() })
    return view(c, now())
  })
}

/** 收案（末期評估＋照護目標）或婉拒 */
export function decidePalliative(id: string, input: { accept: boolean; disease?: string; doctorIds?: string[]; note?: string; goals?: string; declineReason?: string }): Promise<PalliativeView> {
  return mutate(() => {
    const u = requirePalliativeDoctor()
    const c = must(db.palliativeCases.find((x) => x.id === id), '安寧照會')
    if (c.status !== 'requested') fail('這筆照會已經處理過了', 'CONFLICT')
    const a = admittedOf(c.admissionId)
    failFields(checkPalliativeDecision(input))
    if (input.accept) for (const d of input.doctorIds!) if (!find.doctor(d)) failFields({ doctorIds: '找不到這位醫師' })
    const t = now()
    if (input.accept) {
      Object.assign(c, { status: 'enrolled', decidedBy: u.id, decidedAt: t, terminal: { disease: input.disease!, doctorIds: input.doctorIds!.slice(0, 2), ...(input.note?.trim() ? { note: input.note.trim() } : {}) }, goals: input.goals!.trim() })
    } else Object.assign(c, { status: 'declined', decidedBy: u.id, decidedAt: t, declineReason: input.declineReason!.trim() })
    audit(input.accept ? '安寧收案' : '安寧婉拒', `${nameOf.patient(a.patientId)}${input.accept ? `：${input.disease}` : `：${input.declineReason}`}`)
    return view(c, t)
  })
}

/** 訪視：症狀評估＋評估與處置（可更新照護目標）；帶入一次安寧共照費 */
export function addPalliativeVisit(id: string, input: { symptoms: Record<SymptomKey, number>; note: string; spiritual?: string; social?: string; goals?: string }): Promise<PalliativeView> {
  return mutate(() => {
    const u = requirePalliativeDoctor()
    const c = must(db.palliativeCases.find((x) => x.id === id), '安寧照會')
    if (c.status !== 'enrolled') fail('還沒收案', 'CONFLICT')
    const a = admittedOf(c.admissionId)
    failFields(checkPalliativeVisit(input))
    const t = now()
    const o: IpdOrder = { id: newId('IO'), admissionId: a.id, type: 'stat', category: 'procedure', procId: 'P056', content: '安寧共同照護費', startAt: t, stopAt: t, status: 'done', doctorId: u.doctorId!, createdAt: t, ackAt: t, ackBy: u.id }
    db.ipdOrders.push(o)
    c.visits.push({
      id: newId('PV'), at: t, by: u.id, symptoms: Object.fromEntries(SYMPTOMS.map((s) => [s.key, input.symptoms[s.key]])) as Record<SymptomKey, number>, note: input.note.trim(),
      ...(input.spiritual?.trim() ? { spiritual: input.spiritual.trim() } : {}), ...(input.social?.trim() ? { social: input.social.trim() } : {}), orderId: o.id,
    })
    if (input.goals?.trim()) c.goals = input.goals.trim()
    audit('安寧訪視', `${nameOf.patient(a.patientId)}：${SYMPTOMS.map((s) => `${s.label} ${input.symptoms[s.key]}`).join('、')}`)
    return view(c, t)
  })
}

/** 家屬會議：安寧醫師或主治都能記 */
export function addFamilyMeeting(id: string, input: { date: string; participants: string; conclusion: string }): Promise<PalliativeView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const c = must(db.palliativeCases.find((x) => x.id === id), '安寧照會')
    if (c.status !== 'enrolled') fail('還沒收案', 'CONFLICT')
    const a = admittedOf(c.admissionId)
    const role = careRoleOf(u.doctorId, a)
    if (!canPalliative() && (!role || role.kind === 'consult')) fail('家屬會議由安寧醫師或主治記錄', 'FORBIDDEN')
    failFields(checkFamilyMeeting(input, today()))
    const t = now()
    c.meetings.push({ id: newId('FM'), date: input.date, participants: input.participants.trim(), conclusion: input.conclusion.trim(), by: u.id, at: t })
    audit('家屬會議', `${nameOf.patient(a.patientId)}：${input.conclusion.trim()}`)
    return view(c, t)
  })
}

export interface PalliativeWork {
  requested: PalliativeView[]
  enrolled: PalliativeView[]
  canAct: boolean
  stats: { enrolled: number; visits30: number; meetings30: number }
}
/** 安寧頁：待收案、收案中（訪視到期的在前）、30 天的訪視與家屬會議次數 */
export function listPalliative(): Promise<PalliativeWork> {
  return query(() => {
    requirePermission('palliative')
    const t = now()
    const live = db.palliativeCases.filter((c) => find.admission(c.admissionId)?.status === 'admitted')
    const rank = { overdue: 0, due: 1, ok: 2 } as const
    const enrolled = live.filter((c) => c.status === 'enrolled').map((c) => view(c, t)).sort((x, y) => rank[x.visitDue?.status ?? 'ok'] - rank[y.visitDue?.status ?? 'ok'] || x.bedNo.localeCompare(y.bedNo))
    const from = addDays(today(), -30)
    return {
      requested: live.filter((c) => c.status === 'requested').sort((x, y) => x.requestedAt.localeCompare(y.requestedAt)).map((c) => view(c, t)),
      enrolled,
      canAct: canPalliative(),
      stats: {
        enrolled: enrolled.length,
        visits30: db.palliativeCases.reduce((n, c) => n + c.visits.filter((v) => v.at.slice(0, 10) >= from).length, 0),
        meetings30: db.palliativeCases.reduce((n, c) => n + c.meetings.filter((m) => m.date >= from).length, 0),
      },
    }
  })
}
