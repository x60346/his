// 日間手術：當天報到、當天回家。做法和急診留觀一樣是「特別的住院」（Admission.day）：
//   醫師申請（建住院預約＋手術）→ 手術室排程 → 當天護理師報到（麻醉前評估 ASA ≤ 3；不排病房床）→ 術前準備、送手術室（照一般手術）
//   → 恢復室第一期（Aldrete，局部麻醉不用）→ 第二期 PADSS ≥ 9、成人陪同、出院衛教 → 回家；不符合 → 醫師轉一般住院（排床）
//   → 隔天護理師電話追蹤。費用走住院帳單（不收病房費），回家後櫃台在住院結帳收。規則在 day-rules
import type { Admission, AnesthesiaType, PadssScore, Surgery, SurgerySide } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { now, parseDate, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser, type Actor } from './http'
import { checkPadss, DAY_ASA_MAX, DAY_STAGE_LABEL, dayDischargeUnmet, dayFollowUpDue, dayStage, padssOf, PADSS_FRESH, PADSS_ITEMS, type DayStage, type PadssKey } from './day-rules'
import { ANESTHESIA_LABEL, checkSurgeryInput, SIDE_LABEL } from './surgery-rules'
import { surgeryOf, surgeryView, type SurgeryView } from './surgery-work'
import { careRoleOf, requireCare } from './care-team'
import { closeOrders, takeBed } from './bed-work'
import { closeLines } from './line-work'
import { closeRestraints } from './delirium-work'
import { closeInfusions } from './infusion-work'
import { openPca } from './pca-work'
import { find, nameOf } from './views'

const mins = (a: string, b: string) => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 60000)
const dayAdmission = (id: string): Admission => {
  const a = must(find.admission(id), '住院紀錄')
  if (!a.day) fail('這不是日間手術')
  return a
}
const surgeryOfDay = (a: Admission): Surgery => must(surgeryOf(a.day!.surgeryId), '手術')
const audText = (a: Admission, s: Surgery) => `${a.admitNo || '（未報到）'} ${nameOf.patient(a.patientId)} ${find.procedure(s.procId)?.name ?? ''}（${SIDE_LABEL[s.side]}）`

// ---------- 醫師：申請、取消、轉住院 ----------

export interface DaySurgeryInput {
  patientId: string
  procId: string
  side: SurgerySide
  anesthesia: AnesthesiaType
  date: string
  estMinutes: number
  diagnosis: string
  note?: string
}

/** 申請日間手術（醫師）：病人不能已經住院或有住院預約；建「日間手術」住院預約（自己的科別、自己主治）＋待排程的手術 */
export function requestDaySurgery(input: DaySurgeryInput): Promise<SurgeryView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const doc = must(find.doctor(u.doctorId ?? ''), '醫師')
    const t = now()
    const e: Record<string, string> = {}
    const p = input.patientId ? find.patient(input.patientId) : undefined
    if (!p) e.patientId = '請選病人'
    else if (p.deceasedAt) e.patientId = '病人已死亡'
    else if (db.admissions.some((a) => a.patientId === p.id && (a.status === 'reserved' || a.status === 'admitted'))) e.patientId = `${p.name} 已有住院預約或正在住院中`
    const est = Number(input.estMinutes)
    Object.assign(e, checkSurgeryInput({ procId: input.procId, side: input.side, anesthesia: input.anesthesia, requestedDate: input.date, estMinutes: est, diagnosis: input.diagnosis }, t.slice(0, 10)))
    if (e.requestedDate) e.date = e.requestedDate
    const proc = input.procId ? find.procedure(input.procId) : undefined
    if (input.procId && (!proc?.surgery || !proc.active)) e.procId = '這不是可以申請的術式'
    failFields(e)
    const a: Admission = {
      id: newId('A'), admitNo: '', patientId: p!.id, deptId: doc.deptId, doctorId: doc.id, preferBedClass: '健保床', reason: '日間手術', diagnosis: input.diagnosis.trim(),
      status: 'reserved', reservedAt: t, expectedDate: input.date, day: { surgeryId: '' },
    }
    const d = t.slice(0, 10)
    const s: Surgery = {
      id: newId('SG'), no: `OR${d.replace(/-/g, '')}${String(nextCounter(`surgery:${d}`)).padStart(3, '0')}`, admissionId: a.id, patientId: p!.id, doctorId: doc.id, procId: proc!.id,
      side: input.side, anesthesia: input.anesthesia, diagnosis: input.diagnosis.trim(), requestedDate: input.date, estMinutes: est, ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      status: 'requested', createdAt: t, prep: {}, checks: {},
    }
    a.day!.surgeryId = s.id
    db.admissions.push(a)
    db.surgeries.push(s)
    audit('申請日間手術', `${p!.name} ${proc!.name}（${SIDE_LABEL[s.side]}），${ANESTHESIA_LABEL[s.anesthesia]}，預計 ${input.date}`)
    return surgeryView(s)
  })
}

/** 取消日間手術（主刀或本科醫師；送手術室前）：手術與住院預約一起取消 */
export function cancelDaySurgery(admissionId: string, reason: string): Promise<void> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = dayAdmission(admissionId)
    const s = surgeryOfDay(a)
    if (u.doctorId !== s.doctorId && find.doctor(u.doctorId ?? '')?.deptId !== a.deptId) fail('主刀或本科醫師才能取消', 'FORBIDDEN')
    if (s.status !== 'requested' && s.status !== 'scheduled') fail(s.status === 'cancelled' ? '已經取消了' : '病人已經送手術室，不能取消', 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫取消原因')
    const t = now()
    Object.assign(s, { status: 'cancelled', cancelled: { by: u.id, at: t, reason: reason.trim() } })
    if (a.status === 'reserved') a.status = 'cancelled'
    else Object.assign(a, { status: 'discharged', dischargedAt: t, dischargeType: '日間手術取消' })
    audit('取消日間手術', `${audText(a, s)}：${reason.trim()}`)
  })
}

/** 轉一般住院（主刀或本科醫師）：手術後達不到回家條件（或手術中決定）；要選病房空床、寫原因。之後照一般住院 */
export function convertDay(admissionId: string, input: { reason: string; bedId: string }): Promise<DayItem> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = dayAdmission(admissionId)
    requireCare(u.doctorId, a, '日間手術轉住院', { consult: false })
    if (a.status !== 'admitted') fail(a.status === 'reserved' ? '還沒報到' : '已經離院', 'CONFLICT')
    if (a.day!.converted) fail('已經轉住院了', 'CONFLICT')
    const e: Record<string, string> = {}
    if (!input.reason?.trim()) e.reason = '請寫轉住院原因（例：疼痛控制不佳、尿滯留、沒有人陪同）'
    if (!input.bedId) e.bedId = '請選病房床位'
    failFields(e)
    const t = now()
    const bed = takeBed(input.bedId, a.id)
    a.bedId = bed.id
    a.bedHistory = [...(a.bedHistory ?? []), { bedId: bed.id, from: t }]
    a.day!.converted = { at: t, by: u.id, reason: input.reason.trim() }
    a.reason = `日間手術轉住院：${input.reason.trim()}`
    audit('日間手術轉住院', `${audText(a, surgeryOfDay(a))} → ${bed.bedNo}：${input.reason.trim()}`)
    return dayItem(a, u, t)
  })
}

// ---------- 護理師：報到、PADSS、回家、電話追蹤 ----------

/** 報到（手術當天；護理師）：手術已排程、麻醉前評估做了而且 ASA ≤ 3；產生住院號、印腕帶（手術室辨識用），不排病房床 */
export function checkInDay(admissionId: string): Promise<DayItem> {
  return mutate(() => {
    const u = requireUser('nurse')
    const a = dayAdmission(admissionId)
    if (a.status !== 'reserved') fail('已經報到了', 'CONFLICT')
    const s = surgeryOfDay(a)
    const t = now()
    if (s.status !== 'scheduled') fail(s.status === 'requested' ? '手術室還沒排程' : '手術不是「已排程」', 'CONFLICT')
    if (s.schedule!.start.slice(0, 10) !== t.slice(0, 10)) fail(`手術排在 ${s.schedule!.start.slice(0, 10)}，當天才能報到`, 'CONFLICT')
    if (!s.preAnes) fail('麻醉前評估還沒做：日間手術要先評估（ASA ≤ 3 才能做日間）', 'CONFLICT')
    if (s.preAnes!.asa > DAY_ASA_MAX) fail(`麻醉前評估 ASA ${s.preAnes!.asa}：不適合日間手術，請主刀改成一般住院`, 'CONFLICT')
    Object.assign(a, { status: 'admitted', admittedAt: t, admitNo: `I${t.slice(2, 10).replace(/-/g, '')}${String(nextCounter('admitNo')).padStart(3, '0')}`, wristband: { printedAt: t, printedBy: u.id, reprints: [] } })
    audit('日間手術報到', audText(a, s))
    return dayItem(a, u, t)
  })
}

/** PADSS 評分（護理師）：手術完成後；局部麻醉以外要先從恢復室（Aldrete）轉出 */
export function recordPadss(admissionId: string, input: Partial<Record<PadssKey, number>>): Promise<DayItem> {
  return mutate(() => {
    const u = requireUser('nurse')
    const a = dayAdmission(admissionId)
    const s = surgeryOfDay(a)
    const st = dayStage(a, s)
    if (st === 'pacu') fail('還在恢復室第一期：Aldrete 達標轉出後才評 PADSS', 'CONFLICT')
    if (st !== 'phase2') fail(st === 'out' ? '已經回家了' : st === 'converted' ? '已經轉住院' : '手術完成後才能評 PADSS', 'CONFLICT')
    failFields(checkPadss(input))
    const t = now().slice(0, 16)
    const x: PadssScore = { id: `PD${(a.day!.padss?.length ?? 0) + 1}-${Math.random().toString(36).slice(2, 6)}`, at: t, ...(Object.fromEntries(PADSS_ITEMS.map((it) => [it.key, Number(input[it.key])])) as Record<PadssKey, 0 | 1 | 2>), by: u.id }
    a.day!.padss = [...(a.day!.padss ?? []), x]
    return dayItem(a, u, t)
  })
}

/** 回家（護理師）：最後一次 PADSS ≥ 9 且在 30 分鐘內、成人陪同、出院衛教；醫囑停止、給藥排程收掉。帳單之後在住院結帳收 */
export function dischargeDay(admissionId: string, input: { escort: string; teaching: boolean }): Promise<DayItem> {
  return mutate(() => {
    const u = requireUser('nurse')
    const a = dayAdmission(admissionId)
    const s = surgeryOfDay(a)
    if (dayStage(a, s) !== 'phase2') fail('還不能回家（手術完成、恢復室轉出後才評估）', 'CONFLICT')
    if (openPca(a.id)) fail('PCA 還沒結束：日間手術不能帶 PCA 回家，請醫師改住院或結束 PCA', 'CONFLICT')
    const t = now()
    const latest = [...(a.day!.padss ?? [])].sort((x, y) => x.at.localeCompare(y.at)).at(-1)
    const unmet = dayDischargeUnmet(latest, latest ? mins(latest.at, t.slice(0, 16)) : undefined, input)
    if (unmet.length) fail(`還不能回家：${unmet.join('；')}${latest && padssOf(latest) < 9 ? '。達不到請醫師轉住院' : ''}`, 'CONFLICT')
    closeOrders(a, u.id, t, '日間手術回家時未給藥')
    closeLines(a, u.id, t, '出院（日間手術）')
    closeRestraints(a, u.id, t)
    closeInfusions(a, u.id, t, '日間手術回家')
    a.day!.out = { at: t.slice(0, 16), by: u.id, padss: padssOf(latest!), escort: input.escort.trim() }
    Object.assign(a, { status: 'discharged', dischargedAt: t, dischargeType: '日間手術出院' })
    audit('日間手術回家', `${audText(a, s)}：PADSS ${padssOf(latest!)}、陪同 ${input.escort.trim()}、已衛教`)
    return dayItem(a, u, t)
  })
}

/** 隔天電話追蹤（護理師）：有沒有聯絡上、有沒有問題（有問題要寫）；沒聯絡上也記（之後可以再打） */
export function recordDayFollowUp(admissionId: string, input: { reached: boolean; ok?: boolean; note?: string }): Promise<DayItem> {
  return mutate(() => {
    const u = requireUser('nurse')
    const a = dayAdmission(admissionId)
    if (!a.day!.out) fail('還沒回家', 'CONFLICT')
    if (a.day!.followUp?.reached) fail('已經追蹤過了', 'CONFLICT')
    const note = input.note?.trim()
    if (input.reached && typeof input.ok !== 'boolean') failField('ok', '請選有沒有問題')
    if ((!input.reached || input.ok === false) && !note) failField('note', input.reached ? '有問題：請寫狀況與處理（例：傷口滲血，請回門診換藥）' : '沒聯絡上：請寫打了幾次、之後怎麼處理')
    const t = now().slice(0, 16)
    a.day!.followUp = { at: t, by: u.id, reached: !!input.reached, ok: input.reached ? !!input.ok : false, ...(note ? { note } : {}) }
    audit('日間手術電話追蹤', `${audText(a, surgeryOfDay(a))}：${input.reached ? (input.ok ? '沒有問題' : `有問題：${note}`) : `沒聯絡上：${note}`}`)
    return dayItem(a, u, t)
  })
}

// ---------- 看板 ----------

export interface DayItem {
  admissionId: string
  admitNo: string
  surgery: SurgeryView
  stage: DayStage
  stageLabel: string
  /** 麻醉前評估的 ASA；超過 3 不能日間 */
  asa?: number
  asaTooHigh: boolean
  padss: (PadssScore & { total: number; byName: string })[]
  latest?: PadssScore & { total: number; byName: string }
  /** PADSS 還差什麼（不含陪同、衛教——那是回家時填） */
  padssUnmet: string[]
  outText?: string
  convertedText?: string
  followUpText?: string
  followUpDue: boolean
  canCheckIn: boolean
  canScore: boolean
  canDischarge: boolean
  canConvert: boolean
  canCancel: boolean
  canFollowUp: boolean
}

function dayItem(a: Admission, u: Actor, t: string): DayItem {
  const s = surgeryOfDay(a)
  const st = dayStage(a, s)
  const padss = [...(a.day!.padss ?? [])].sort((x, y) => x.at.localeCompare(y.at)).map((x) => ({ ...x, total: padssOf(x), byName: nameOf.user(x.by) }))
  const latest = padss.at(-1)
  const nurse = u.role === 'nurse'
  const team = u.role === 'doctor' && (u.doctorId === s.doctorId || (!!u.doctorId && careRoleOf(u.doctorId, a)?.kind === 'team'))
  const fu = a.day!.followUp
  return {
    admissionId: a.id, admitNo: a.admitNo, surgery: surgeryView(s), stage: st, stageLabel: DAY_STAGE_LABEL[st],
    ...(s.preAnes ? { asa: s.preAnes.asa } : {}), asaTooHigh: !!s.preAnes && s.preAnes.asa > DAY_ASA_MAX,
    padss, ...(latest ? { latest } : {}),
    padssUnmet: st === 'phase2' ? dayDischargeUnmet(latest, latest ? mins(latest.at, t.slice(0, 16)) : undefined, { escort: 'x', teaching: true }) : [],
    ...(a.day!.out ? { outText: `${a.day!.out.at.slice(5).replace('-', '/')} 回家・PADSS ${a.day!.out.padss}・陪同 ${a.day!.out.escort}・${nameOf.user(a.day!.out.by)}` } : {}),
    ...(a.day!.converted ? { convertedText: `${a.day!.converted.at.slice(5).replace('-', '/')} 轉住院（${find.bed(a.bedId ?? '')?.bedNo ?? ''}）：${a.day!.converted.reason}・${nameOf.user(a.day!.converted.by)}` } : {}),
    ...(fu ? { followUpText: `${fu.at.slice(5).replace('-', '/')} 電話追蹤：${fu.reached ? (fu.ok ? '沒有問題' : `有問題：${fu.note}`) : `沒聯絡上：${fu.note}`}・${nameOf.user(fu.by)}` } : {}),
    followUpDue: dayFollowUpDue(a, t.slice(0, 10)) || (!!fu && !fu.reached),
    canCheckIn: nurse && st === 'reserved' && s.status === 'scheduled' && s.schedule!.start.slice(0, 10) === t.slice(0, 10),
    canScore: nurse && st === 'phase2',
    canDischarge: nurse && st === 'phase2',
    canConvert: team && a.status === 'admitted' && !a.day!.out && !a.day!.converted,
    canCancel: team && (s.status === 'requested' || s.status === 'scheduled'),
    canFollowUp: nurse && !!a.day!.out && !fu?.reached,
  }
}

export interface DayBoard {
  date: string
  /** 這天的日間手術（排程或預計在這天的；還在院內的不分日期都列） */
  items: DayItem[]
  /** 回家後待電話追蹤（不分日期） */
  followUps: DayItem[]
  canRequest: boolean
  padssFresh: number
}
export function dayBoard(date: string): Promise<DayBoard> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'admin')
    const t = now()
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date : today()
    const all = db.admissions.filter((a) => a.day && surgeryOf(a.day.surgeryId))
    const onDay = (a: Admission) => {
      const s = surgeryOf(a.day!.surgeryId)!
      return (s.schedule?.start.slice(0, 10) ?? s.requestedDate) === d || (a.status === 'admitted' && !a.day!.converted && d === t.slice(0, 10))
    }
    const order: DayStage[] = ['phase2', 'pacu', 'inOr', 'checkedIn', 'reserved', 'out', 'converted', 'cancelled']
    const items = all.filter(onDay).map((a) => dayItem(a, u, t)).sort((x, y) => order.indexOf(x.stage) - order.indexOf(y.stage) || (x.surgery.schedule?.start ?? '').localeCompare(y.surgery.schedule?.start ?? ''))
    return {
      date: d, items, followUps: all.filter((a) => a.day!.out && (dayFollowUpDue(a, t.slice(0, 10)) || (a.day!.followUp && !a.day!.followUp.reached))).map((a) => dayItem(a, u, t)),
      canRequest: u.role === 'doctor', padssFresh: PADSS_FRESH,
    }
  })
}

/** 申請日間手術用：找病人（病歷號或姓名） */
export function dayPatientSearch(keyword: string): Promise<{ id: string; name: string; chartNo: string; busy: boolean }[]> {
  return query(() => {
    requireUser('doctor')
    const k = keyword?.trim()
    if (!k) return []
    return db.patients.filter((p) => !p.deceasedAt && (p.chartNo.includes(k) || p.name.includes(k))).slice(0, 10)
      .map((p) => ({ id: p.id, name: p.name, chartNo: p.chartNo, busy: db.admissions.some((a) => a.patientId === p.id && (a.status === 'reserved' || a.status === 'admitted')) }))
  })
}

