// 手術的內部工具（index 不匯出、不會被包成 API）：畫面資料、住院帳單的手術與麻醉費、首頁待辦、出院把關。
// 規則在 surgery-rules（純函式）；API 在 surgery.ts
import type { Admission, Procedure, Surgery } from '@/types'
import { db } from '@/mock/db'
import { addMinutes, ageOf, now } from '@/utils/date'
import { ANESTHESIA_LABEL, CHECK_ITEMS, CHECK_ORDER, emergencyState, overlaps, PREP_ITEMS, prepMissing, SIDE_LABEL, SURGERY_STATUS_LABEL, URGENCY_LABEL } from './surgery-rules'
import { flagsOf, type PatientFlags } from './flag-work'
import { find, nameOf } from './views'
import { BLOOD_PRODUCT_LABEL, requestStatus, BLOOD_STATUS_LABEL } from './blood-rules'
import { preIncisionOf } from './prophylaxis-work'
import { preAnesSummary } from './anesthesia-rules'
import { renalOfPatient } from './renal-work'

export const surgeryOf = (id: string) => db.surgeries.find((s) => s.id === id)

export interface SurgeryView extends Surgery {
  patientName: string
  chartNo: string
  age: string
  gender: string
  bedNo: string
  ward: string
  admitNo: string
  allergies: string[]
  flags: PatientFlags
  doctorName: string
  procName: string
  sideText: string
  anesthesiaText: string
  statusLabel: string
  /** 「OR2 11-17 15:00–16:30」 */
  scheduleText?: string
  scheduleEnd?: string
  prepRows: { key: string; label: string; hint: string; optional: boolean; done: boolean; text?: string }[]
  prepMissing: string[]
  checkRows: { stage: string; title: string; items: string[]; done: boolean; text?: string }[]
  countMismatch: boolean
  recordByName?: string
  /** 預防性抗生素：送到手術室還沒開始＝以現在算的劃刀前時機（提醒）；開始後＝當時記的 */
  abxPre?: { ok: boolean; text: string }
  cancelledByName?: string
  /** 急刀：等級、時效（期限、等了幾分鐘、狀態） */
  urgencyLabel?: string
  emergency?: ReturnType<typeof emergencyState>
  /** 擇期手術被急刀佔了同一間房的時段：要改期（說明） */
  bumpedBy?: string
  /** 麻醉前評估：摘要、誰評的；還沒評估（沒有就不能做麻醉前查核） */
  preAnesText?: string
  preAnesByName?: string
  preAnesMissing: boolean
  /** 評估畫面用：腎功能（CrCl） */
  renalText: string
}
/** 擇期、已排、還沒送：同一間房有急刀時段重疊＝要改期 */
export function bumpedByEmergency(s: Surgery): Surgery | undefined {
  if (s.urgency || s.status !== 'scheduled' || !s.schedule) return undefined
  return db.surgeries.find((x) => x.id !== s.id && x.urgency && x.schedule?.room === s.schedule!.room && x.status !== 'cancelled' && x.status !== 'done' && overlaps(x.schedule.start, x.estMinutes, s.schedule!.start, s.estMinutes))
}

export function surgeryView(s: Surgery): SurgeryView {
  const a = find.admission(s.admissionId)
  const p = find.patient(s.patientId)
  const bed = find.bed(a?.bedId ?? '')
  const who = (x?: { by: string; at: string }) => (x ? `${nameOf.user(x.by)} ${x.at.slice(5)}` : undefined)
  const end = s.schedule ? addMinutes(s.schedule.start, s.estMinutes) : undefined
  const missing = prepMissing(s)
  return {
    ...s,
    patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', gender: p?.gender === 'M' ? '男' : '女',
    age: p ? `${ageOf(p.birthDate, s.createdAt.slice(0, 10))} 歲` : '',
    bedNo: bed?.bedNo ?? '', ward: bed?.ward ?? '', admitNo: a?.admitNo ?? '', allergies: p?.allergies ?? [], flags: flagsOf(s.patientId),
    doctorName: nameOf.doctor(s.doctorId), procName: find.procedure(s.procId)?.name ?? s.procId,
    sideText: SIDE_LABEL[s.side], anesthesiaText: ANESTHESIA_LABEL[s.anesthesia], statusLabel: SURGERY_STATUS_LABEL[s.status],
    ...(s.schedule ? { scheduleText: `${s.schedule.room} ${s.schedule.start.slice(5)}–${end!.slice(11)}`, scheduleEnd: end } : {}),
    ...(s.urgency ? { urgencyLabel: URGENCY_LABEL[s.urgency], emergency: emergencyState(s, now()) } : {}),
    ...((b) => (b ? { bumpedBy: `${b.schedule!.room} 被急刀（${URGENCY_LABEL[b.urgency!]}）${b.no} 佔用（${b.schedule!.start.slice(11)} 起），請改期` } : {}))(bumpedByEmergency(s)),
    ...(s.preAnes ? { preAnesText: preAnesSummary(s.preAnes, s.preAnes.plan ? `${ANESTHESIA_LABEL[s.preAnes.plan]}${s.preAnes.changedFrom ? `（原申請${ANESTHESIA_LABEL[s.preAnes.changedFrom]}：${s.preAnes.planReason}）` : ''}` : undefined), preAnesByName: `${nameOf.user(s.preAnes.by)} ${s.preAnes.at.slice(5)}` } : {}),
    preAnesMissing: !s.preAnes && ['requested', 'scheduled', 'sent'].includes(s.status),
    renalText: renalOfPatient(s.patientId, a?.status === 'admitted' ? a.id : undefined).text || '沒有近期肌酸酐',
    prepRows: PREP_ITEMS.map((x) => {
      const m = s.prep[x.key]
      let text = m ? `${m.notNeeded ? `不需要：${m.notNeeded}` : '已完成'}・${who(m)}` : undefined
      if (m?.refId && x.key === 'blood') {
        const r = db.bloodRequests.find((b) => b.id === m.refId)
        if (r) text = `${r.no} ${BLOOD_PRODUCT_LABEL[r.product]} ${r.units} 單位（${BLOOD_STATUS_LABEL[requestStatus(r)]}）・${who(m)}`
      }
      if (m?.refId && x.key === 'abx') {
        const o = db.ipdOrders.find((b) => b.id === m.refId)
        if (o) text = `${o.content}${o.freq ? ` ${o.freq}` : ''}・${who(m)}`
      }
      return { key: x.key, label: x.label, hint: x.hint, optional: x.optional, done: !!m, ...(text ? { text } : {}) }
    }),
    prepMissing: missing.map((k) => PREP_ITEMS.find((x) => x.key === k)!.label),
    checkRows: CHECK_ORDER.map((st) => ({ stage: st, title: CHECK_ITEMS[st].title, items: CHECK_ITEMS[st].items, done: !!s.checks[st], ...(s.checks[st] ? { text: who(s.checks[st]) } : {}) })),
    countMismatch: !!s.counts?.mismatchReason,
    ...((pre) => (pre ? { abxPre: { ok: pre.ok, text: pre.text } } : {}))(s.status === 'sent' ? preIncisionOf(s) : undefined),
    ...(s.abxTiming ? { abxPre: { ok: s.abxTiming.ok, text: s.abxTiming.ok ? `劃刀前 ${s.abxTiming.minutes} 分鐘給藥` : `時機不符：${s.abxTiming.reason ?? ''}` } } : {}),
    ...(s.record ? { recordByName: nameOf.user(s.record.by) } : {}),
    ...(s.cancelled ? { cancelledByName: nameOf.user(s.cancelled.by) } : {}),
  }
}

/** 住院帳單：做完的手術＝術式＋麻醉費（局部麻醉不另收），依手術結束那天的點數 */
export function surgeryFeeItems(admissionId: string): { proc: Procedure; qty: number; date: string }[] {
  const out: { proc: Procedure; qty: number; date: string }[] = []
  for (const s of db.surgeries.filter((x) => x.admissionId === admissionId && x.status === 'done')) {
    const proc = find.procedure(s.procId)
    const date = s.endAt ?? s.createdAt
    if (proc) out.push({ proc, qty: 1, date })
    const an = db.procedures.find((p) => p.anesthesiaFee === s.anesthesia)
    if (an) out.push({ proc: an, qty: 1, date })
  }
  return out
}

/** 出院前：在手術室（已送、手術中）不能出院 */
export const surgeryOpen = (a: Admission) => db.surgeries.some((s) => s.admissionId === a.id && (s.status === 'sent' || s.status === 'in-progress'))

const live = () => db.surgeries.filter((s) => db.admissions.find((a) => a.id === s.admissionId)?.status === 'admitted')

/** 首頁待辦：待排程（手術排程權限）；今天、明天要開但術前準備還沒完成（護理站）；主刀：手術紀錄待寫、計數不符 */
/** 麻醉前評估待做：還沒評估、要開了的（急刀，或今天明天排的／預計的）；精簡版待補（急刀先做了精簡版） */
export function preAnesCounts(t: string): { due: number; brief: number } {
  const tomorrow = addMinutes(`${t.slice(0, 10)} 00:00`, 24 * 60).slice(0, 10)
  const act = live().filter((s) => ['requested', 'scheduled', 'sent'].includes(s.status))
  return {
    due: act.filter((s) => !s.preAnes && (s.urgency || (s.schedule?.start.slice(0, 10) ?? s.requestedDate) <= tomorrow)).length,
    brief: act.filter((s) => s.preAnes?.brief).length,
  }
}
export function surgeryCounts(t: string, doctorId?: string): { toSchedule: number; prepDue: number; recordDue: number } {
  const today = t.slice(0, 10)
  const tomorrow = addMinutes(`${today} 00:00`, 24 * 60).slice(0, 10)
  return {
    toSchedule: live().filter((s) => s.status === 'requested').length,
    prepDue: live().filter((s) => s.status === 'scheduled' && s.schedule && s.schedule.start.slice(0, 10) <= tomorrow && prepMissing(s).length).length,
    recordDue: doctorId ? db.surgeries.filter((s) => s.status === 'done' && !s.record && s.doctorId === doctorId).length : 0,
  }
}
