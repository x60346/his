// 傷口與壓傷照護：護理師登錄傷口（種類、部位、發現時間、第一次的大小與敷料；壓傷要分級）→ 每次換藥記敷料、滲液、大小
// （面積趨勢；連續 2 週沒變小提醒主治）→ 癒合結案。入院 24 小時後才發現的壓傷算院內壓傷（品質指標每千住院人日），
// 登錄後提醒寫一筆壓傷評估「病情變化加評」。規則在 wound-rules
import type { Wound, WoundCare } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'
import { areaOf, checkWoundCare, hospitalAcquired, stageLabel, stalled, WOUND_KINDS, woundKindLabel } from './wound-rules'
import { needsRiskChange } from './wound-work'
import { lineDays } from './line-rules'
import { per1000 } from './infection-rules'

export interface WoundView extends Wound {
  label: string
  recordedByName: string
  closedByName?: string
  stageText?: string
  latest: WoundCare & { area: number; byName: string }
  careViews: (WoundCare & { area: number; byName: string })[]
  stall?: { from: { at: string; area: number }; to: { at: string; area: number } }
}

const wView = (w: Wound, t: string): WoundView => {
  const careViews = [...w.cares].sort((a, b) => b.at.localeCompare(a.at)).map((c) => ({ ...c, area: areaOf(c), byName: nameOf.user(c.by) }))
  const st = [...w.cares].reverse().find((c) => c.stage)?.stage
  const s = w.closedAt ? undefined : stalled(w.cares, t)
  return {
    ...w, label: woundKindLabel(w.kind), recordedByName: nameOf.user(w.recordedBy), ...(w.closedBy ? { closedByName: nameOf.user(w.closedBy) } : {}),
    ...(st ? { stageText: stageLabel(st) } : {}), latest: careViews[0], careViews, ...(s ? { stall: s } : {}),
  }
}

export interface PatientWounds {
  admissionId: string
  open: WoundView[]
  closed: WoundView[]
  /** 院內壓傷登錄後還沒做壓傷「病情變化加評」 */
  riskChangeDue?: string
  canNurse: boolean
}

export function patientWounds(admissionId: string): Promise<PatientWounds> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'admin')
    const a = must(find.admission(admissionId), '住院紀錄')
    const t = now()
    const ws = db.wounds.filter((w) => w.admissionId === a.id)
    const rc = a.status === 'admitted' ? needsRiskChange(a) : undefined
    return {
      admissionId: a.id, open: ws.filter((w) => !w.closedAt).map((w) => wView(w, t)), closed: ws.filter((w) => w.closedAt).map((w) => wView(w, t)),
      ...(rc ? { riskChangeDue: `院內壓傷（${rc.site}）：請到「風險評估」做壓傷評估，勾「病情變化加評」` } : {}),
      canNurse: u.role === 'nurse' && a.status === 'admitted',
    }
  })
}

export type CareInput = Omit<WoundCare, 'at' | 'by'>

/** 登錄傷口：發現時間不能早於入院前 30 天、不能晚於現在；第一筆評估（大小、敷料、壓傷分級） */
export function addWound(admissionId: string, input: { kind: Wound['kind']; site: string; foundAt: string } & CareInput): Promise<{ wound: WoundView; riskReminder?: string }> {
  return mutate(() => {
    const u = requireUser('nurse')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
    const t = now()
    const f: Record<string, string> = {}
    if (!WOUND_KINDS.some((k) => k.kind === input.kind)) f.kind = '請選種類'
    if (!input.site?.trim()) f.site = '請寫部位'
    if (!input.foundAt || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(input.foundAt) || input.foundAt > t) f.foundAt = '請填發現時間（不能晚於現在）'
    Object.assign(f, checkWoundCare(input, input.kind))
    failFields(f)
    const admitted = a.admittedAt ?? a.reservedAt
    if (input.foundAt < addDays(admitted.slice(0, 10), -30)) failField('foundAt', '發現時間太早')
    const care: WoundCare = { at: input.foundAt, by: u.id, dressing: input.dressing.trim(), exudate: input.exudate, lengthCm: input.lengthCm, widthCm: input.widthCm, depthCm: input.depthCm, ...(input.kind === 'pressure' ? { stage: input.stage } : {}), ...(input.note?.trim() ? { note: input.note.trim() } : {}) }
    const w: Wound = { id: newId('WD'), admissionId: a.id, kind: input.kind, site: input.site.trim(), foundAt: input.foundAt, hospitalAcquired: hospitalAcquired(input.kind, input.foundAt, admitted), recordedBy: u.id, cares: [care] }
    db.wounds.push(w)
    audit('傷口登錄', `${a.admitNo} ${nameOf.patient(a.patientId)}：${woundKindLabel(w.kind)} ${w.site}${care.stage ? ` ${stageLabel(care.stage)}` : ''}${w.hospitalAcquired ? '（院內壓傷）' : ''}`)
    return { wound: wView(w, t), ...(w.hospitalAcquired ? { riskReminder: '院內壓傷：請到「風險評估」做壓傷評估，勾「病情變化加評」' } : {}) }
  })
}

/** 換藥（記大小；壓傷可以改分級） */
export function recordCare(woundId: string, input: CareInput): Promise<WoundView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const w = must(db.wounds.find((x) => x.id === woundId), '傷口')
    const a = must(find.admission(w.admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
    if (w.closedAt) fail('已經結案了', 'CONFLICT')
    failFields(checkWoundCare(input, w.kind))
    const t = now()
    w.cares.push({ at: t, by: u.id, dressing: input.dressing.trim(), exudate: input.exudate, lengthCm: input.lengthCm, widthCm: input.widthCm, depthCm: input.depthCm, ...(w.kind === 'pressure' ? { stage: input.stage } : {}), ...(input.note?.trim() ? { note: input.note.trim() } : {}) })
    audit('換藥', `${nameOf.patient(a.patientId)} ${w.site}：${input.lengthCm}×${input.widthCm}×${input.depthCm} cm`)
    return wView(w, t)
  })
}

/** 結案（癒合、轉院、其他） */
export function closeWound(woundId: string, reason: string): Promise<WoundView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const w = must(db.wounds.find((x) => x.id === woundId), '傷口')
    if (w.closedAt) fail('已經結案了', 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫原因（例：已癒合、上皮化完整）')
    const t = now()
    Object.assign(w, { closedAt: t, closedBy: u.id, closeReason: reason.trim() })
    audit('傷口結案', `${nameOf.patient(find.admission(w.admissionId)?.patientId)} ${w.site}：${reason.trim()}`)
    return wView(w, t)
  })
}

/** 病房院內壓傷（最近 days 天發現的；每千住院人日） */
export function wardPressureStats(ward: string, days = 30): Promise<{ from: string; to: string; patientDays: number; hapi: number; rate: number | null; open: number }> {
  return query(() => {
    requireUser('nurse', 'doctor', 'admin')
    const to = today()
    const from = addDays(to, -(days - 1))
    const adms = db.admissions.filter((a) => a.bedId && find.bed(a.bedId)?.ward === ward && a.admittedAt && a.status !== 'cancelled')
    const ids = new Set(adms.map((a) => a.id))
    const patientDays = adms.reduce((n, a) => n + lineDays({ insertedAt: a.admittedAt!, removedAt: a.dischargedAt }, from, to), 0)
    const ws = db.wounds.filter((w) => ids.has(w.admissionId) && w.kind === 'pressure')
    const hapi = ws.filter((w) => w.hospitalAcquired && w.foundAt.slice(0, 10) >= from && w.foundAt.slice(0, 10) <= to).length
    return { from, to, patientDays, hapi, rate: per1000(hapi, patientDays), open: ws.filter((w) => !w.closedAt).length }
  })
}
