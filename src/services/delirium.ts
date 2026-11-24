// 譫妄評估與身體約束：護理師 CAM 評估（65 歲以上、術後 72 小時內每班；陽性主治確認）；
// 身體約束——醫師開醫囑（最長 24 小時、到期續開）或護理師緊急先約束（1 小時內補醫囑），每 2 小時查核，解除寫原因。規則在 delirium-rules
import type { DeliriumAssessment, Restraint } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, addMinutes, now, today } from '@/utils/date'
import { lineDays } from './line-rules'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'
import { careRoleOf, requireCare } from './care-team'
import { camPositive, checkRestraintInput, RESTRAINT_END_REASONS, RESTRAINT_ORDER_HOURS, restraintState, type RestraintState } from './delirium-rules'
import { deliriumStateOf } from './delirium-work'

export interface DeliriumView extends DeliriumAssessment {
  byName: string
  ackByName?: string
}
export interface RestraintView extends Restraint {
  state: RestraintState
  startedByName: string
  orderTexts: string[]
  checkTexts: string[]
  endedByName?: string
}

const dView = (x: DeliriumAssessment): DeliriumView => ({ ...x, byName: nameOf.user(x.by), ...(x.ackBy ? { ackByName: nameOf.user(x.ackBy) } : {}) })
const rView = (r: Restraint, t: string): RestraintView => ({
  ...r, state: restraintState(r, t), startedByName: nameOf.user(r.startedBy),
  orderTexts: r.orders.map((o) => `${o.at.slice(5).replace('-', '/')} ${nameOf.user(o.by)}（到 ${o.until.slice(5).replace('-', '/')}）`),
  checkTexts: r.checks.slice(-6).reverse().map((c) => `${c.at.slice(5).replace('-', '/')} ${nameOf.user(c.by)}：末梢循環${c.circulationOk ? '正常' : '異常'}、皮膚${c.skinOk ? '完整' : '異常'}、${c.stillNeeded ? '仍需約束' : '可以解除'}${c.note ? `（${c.note}）` : ''}`),
  ...(r.endedBy ? { endedByName: nameOf.user(r.endedBy) } : {}),
})

const admittedOf = (id: string) => {
  const a = must(find.admission(id), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return a
}

export interface PatientSafety {
  admissionId: string
  /** 為什麼要每班評譫妄（不用評沒有）；這一班評了沒 */
  target?: string
  /** 加護病房 RASS ≤ −4：這一班先不評 CAM（說明） */
  rassSkip?: string
  thisShift: boolean
  assessments: DeliriumView[]
  active: RestraintView[]
  ended: RestraintView[]
  canAssess: boolean
  /** 醫師：可以確認陽性、開約束醫囑、續開 */
  canOrder: boolean
}

export function patientSafety(admissionId: string): Promise<PatientSafety> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'admin')
    const a = must(find.admission(admissionId), '住院紀錄')
    const t = now()
    const ds = deliriumStateOf(a, t)
    const rs = db.restraints.filter((r) => r.admissionId === a.id)
    const role = u.role === 'doctor' ? careRoleOf(u.doctorId, a) : undefined
    return {
      admissionId: a.id, ...(ds.target ? { target: ds.target } : {}), ...(ds.rassSkip ? { rassSkip: ds.rassSkip } : {}), thisShift: ds.thisShift,
      assessments: db.deliriumAssessments.filter((x) => x.admissionId === a.id).sort((x, y) => y.at.localeCompare(x.at)).slice(0, 12).map(dView),
      active: rs.filter((r) => !r.endedAt).map((r) => rView(r, t)), ended: rs.filter((r) => r.endedAt).sort((x, y) => y.endedAt!.localeCompare(x.endedAt!)).map((r) => rView(r, t)),
      canAssess: u.role === 'nurse' && a.status === 'admitted', canOrder: !!role && role.kind !== 'consult' && a.status === 'admitted',
    }
  })
}

export interface CamInput {
  acute: boolean
  inattention: boolean
  disorganized: boolean
  consciousness: boolean
  note?: string
}

/** CAM 評估（護理師）：陽性列主治首頁 */
export function saveDelirium(admissionId: string, input: CamInput): Promise<DeliriumView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const a = admittedOf(admissionId)
    const x: DeliriumAssessment = {
      id: newId('DL'), admissionId: a.id, at: now(), by: u.id, acute: !!input.acute, inattention: !!input.inattention, disorganized: !!input.disorganized, consciousness: !!input.consciousness,
      positive: camPositive(input), ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    }
    if (x.positive && !x.note) failField('note', 'CAM 陽性：請寫觀察到的表現（例：夜間躁動、拉扯點滴）')
    db.deliriumAssessments.push(x)
    audit('譫妄評估', `${a.admitNo} ${nameOf.patient(a.patientId)}：CAM ${x.positive ? '陽性' : '陰性'}`)
    return dView(x)
  })
}

/** 主治（本科醫師）確認譫妄陽性 */
export function ackDelirium(id: string): Promise<DeliriumView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const x = must(db.deliriumAssessments.find((y) => y.id === id), '譫妄評估')
    const a = must(find.admission(x.admissionId), '住院紀錄')
    requireCare(u.doctorId, a, '確認譫妄評估', { consult: false })
    if (!x.positive) fail('陰性不用確認')
    if (x.ackAt) fail('已經確認過了', 'CONFLICT')
    Object.assign(x, { ackBy: u.id, ackAt: now() })
    audit('譫妄確認', `${a.admitNo} ${nameOf.patient(a.patientId)}`)
    return dView(x)
  })
}

export interface RestraintInput {
  reason: string
  sites: string[]
  method: string
}

/**
 * 開始約束：醫師開醫囑（有效 24 小時）；護理師只能「緊急約束」（1 小時內要醫師補醫囑）。
 * 同一位病人同時只有一筆進行中的約束（要改部位請解除再開）
 */
export function startRestraint(admissionId: string, input: RestraintInput): Promise<RestraintView> {
  return mutate(() => {
    const u = requireUser('nurse', 'doctor')
    const a = admittedOf(admissionId)
    if (u.role === 'doctor') requireCare(u.doctorId, a, '開約束醫囑', { consult: false })
    failFields(checkRestraintInput(input))
    if (db.restraints.some((r) => r.admissionId === a.id && !r.endedAt)) fail('已經在約束中：要改部位或方式請先解除再開', 'CONFLICT')
    const t = now()
    const doctor = u.role === 'doctor'
    const r: Restraint = {
      id: newId('RS'), admissionId: a.id, reason: input.reason.trim(), sites: [...input.sites], method: input.method, startedAt: t, startedBy: u.id, emergency: !doctor,
      orders: doctor ? [{ by: u.id, at: t, until: addMinutes(t, RESTRAINT_ORDER_HOURS * 60) }] : [], checks: [],
    }
    db.restraints.push(r)
    audit(doctor ? '約束醫囑' : '緊急約束', `${a.admitNo} ${nameOf.patient(a.patientId)}：${r.sites.join('、')} ${r.method}（${r.reason}）`)
    return rView(r, t)
  })
}

/** 醫師補醫囑（緊急約束）或續開（到期前後都可以）：有效到現在＋24 小時 */
export function orderRestraint(id: string): Promise<RestraintView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const r = must(db.restraints.find((x) => x.id === id), '約束')
    const a = admittedOf(r.admissionId)
    requireCare(u.doctorId, a, '開約束醫囑', { consult: false })
    if (r.endedAt) fail('已經解除了', 'CONFLICT')
    const t = now()
    r.orders.push({ by: u.id, at: t, until: addMinutes(t, RESTRAINT_ORDER_HOURS * 60) })
    audit(r.orders.length === 1 ? '約束補醫囑' : '約束續開', `${a.admitNo} ${nameOf.patient(a.patientId)}`)
    return rView(r, t)
  })
}

/** 查核（護理師，每 2 小時） */
export function checkRestraint(id: string, input: { circulationOk: boolean; skinOk: boolean; stillNeeded: boolean; note?: string }): Promise<RestraintView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const r = must(db.restraints.find((x) => x.id === id), '約束')
    admittedOf(r.admissionId)
    if (r.endedAt) fail('已經解除了', 'CONFLICT')
    if ((!input.circulationOk || !input.skinOk) && !input.note?.trim()) failField('note', '末梢循環或皮膚異常：請寫處置（例：放鬆約束、通知醫師）')
    const t = now()
    r.checks.push({ at: t, by: u.id, circulationOk: !!input.circulationOk, skinOk: !!input.skinOk, stillNeeded: !!input.stillNeeded, ...(input.note?.trim() ? { note: input.note.trim() } : {}) })
    audit('約束查核', `${nameOf.patient(find.admission(r.admissionId)?.patientId)}：${input.stillNeeded ? '仍需約束' : '可以解除'}`)
    return rView(r, t)
  })
}

/** 解除（護理師或醫師）：原因必填 */
export function endRestraint(id: string, reason: string, note = ''): Promise<RestraintView> {
  return mutate(() => {
    const u = requireUser('nurse', 'doctor')
    const r = must(db.restraints.find((x) => x.id === id), '約束')
    if (r.endedAt) fail('已經解除了', 'CONFLICT')
    if (!RESTRAINT_END_REASONS.includes(reason)) failField('reason', '請選解除原因')
    if (reason === '其他' && !note.trim()) failField('note', '請寫說明')
    const t = now()
    Object.assign(r, { endedAt: t, endedBy: u.id, endReason: reason === '其他' ? `其他：${note.trim()}` : note.trim() ? `${reason}（${note.trim()}）` : reason })
    audit('解除約束', `${nameOf.patient(find.admission(r.admissionId)?.patientId)}：${r.endReason}`)
    return rView(r, t)
  })
}

export interface WardSafetyStats {
  from: string
  to: string
  /** 約束：次數、約束日數（開始與解除當天都算）、目前約束中；緊急約束幾次 */
  restraints: number
  restraintDays: number
  restraintActive: number
  emergency: number
  /** 譫妄：評估人次、陽性人次、陽性率 */
  camCount: number
  camPositive: number
  camRate: number | null
}

/** 病房品質指標（最近 days 天）：約束與譫妄（依病人目前住的病房統計，和管路日一樣） */
export function wardSafetyStats(ward: string, days = 30): Promise<WardSafetyStats> {
  return query(() => {
    requireUser('nurse', 'doctor', 'admin')
    const to = today()
    const from = addDays(to, -(days - 1))
    const ids = new Set(db.admissions.filter((a) => a.bedId && find.bed(a.bedId)?.ward === ward).map((a) => a.id))
    const rs = db.restraints.filter((r) => ids.has(r.admissionId) && r.startedAt.slice(0, 10) <= to && (!r.endedAt || r.endedAt.slice(0, 10) >= from))
    const cams = db.deliriumAssessments.filter((x) => ids.has(x.admissionId) && x.at.slice(0, 10) >= from && x.at.slice(0, 10) <= to)
    const pos = cams.filter((x) => x.positive).length
    return {
      from, to, restraints: rs.length, restraintDays: rs.reduce((n, r) => n + lineDays({ insertedAt: r.startedAt, removedAt: r.endedAt }, from, to), 0),
      restraintActive: rs.filter((r) => !r.endedAt).length, emergency: rs.filter((r) => r.emergency).length,
      camCount: cams.length, camPositive: pos, camRate: cams.length ? Math.round((pos / cams.length) * 1000) / 1000 : null,
    }
  })
}
