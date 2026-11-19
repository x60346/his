// 手術的內部工具（index 不匯出、不會被包成 API）：畫面資料、住院帳單的手術與麻醉費、首頁待辦、出院把關。
// 規則在 surgery-rules（純函式）；API 在 surgery.ts
import type { Admission, Procedure, Surgery } from '@/types'
import { db } from '@/mock/db'
import { addMinutes, ageOf, now, parseDate } from '@/utils/date'
import { ANESTHESIA_LABEL, CHECK_ITEMS, CHECK_ORDER, emergencyState, overlaps, PREP_ITEMS, prepMissing, SIDE_LABEL, SURGERY_STATUS_LABEL, POSTOP_DUE_HOURS, TEAM_LABEL, TEAM_ORDER, teamMissing, teamNow, URGENCY_LABEL } from './surgery-rules'
import { flagsOf, type PatientFlags } from './flag-work'
import { find, nameOf } from './views'
import { BLOOD_PRODUCT_LABEL, requestStatus, BLOOD_STATUS_LABEL } from './blood-rules'
import { preIncisionOf } from './prophylaxis-work'
import { PACU_LONG_MINUTES, preAnesSummary } from './anesthesia-rules'
import { renalOfPatient } from './renal-work'
import { pathCritical, pathStage, PATH_RECEIVE_HOURS, PATH_STAGE_LABEL, specimenText } from './pathology-rules'

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
  /** 手術團隊：每個角色現在的人與交班經過 */
  teamRows: { role: string; label: string; userId?: string; name?: string; shifts: { name: string; from?: string; to?: string }[] }[]
  /** 下一關（麻醉前查核、劃刀前暫停確認）前團隊還缺的角色；已排程的以劃刀前暫停確認算 */
  teamMissing: string[]
  /** 一行的團隊摘要（手術紀錄、交班）：「主刀 X・助手 Y・麻醉 Z・刷手 A・流動 B」 */
  teamText: string
  /** 術後醫囑：還沒開（手術完成、住院中）；完成超過 4 小時還沒開 */
  postopDue: boolean
  postopLate: boolean
  postopText?: string
  /** 檢體：逐件登記（新手術）；病理階段、要主刀確認（惡性或不符、還沒確認） */
  specimenRows: { id: string; text: string }[]
  /** 新手術（逐件登記）：手術紀錄的檢體不用另打 */
  specimenStructured: boolean
  pathStageLabel?: string
  pathAckDue: boolean
  /** 收件時少了的 */
  pathMissing?: string
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
    teamRows: TEAM_ORDER.map((r) => ((id) => ({ role: r, label: TEAM_LABEL[r], ...(id ? { userId: id, name: nameOf.user(id) } : {}), shifts: (s.team?.[r] ?? []).map((x) => ({ name: nameOf.user(x.userId), ...(x.from ? { from: x.from } : {}), ...(x.to ? { to: x.to } : {}) })) }))(teamNow(s, r))),
    teamMissing: (s.status === 'scheduled' || s.status === 'sent' ? teamMissing(s, s.status === 'sent' && !s.checks.signIn ? 'signIn' : 'timeOut') : []).map((r) => TEAM_LABEL[r]),
    teamText: [`主刀 ${nameOf.doctor(s.doctorId)}`, ...TEAM_ORDER.filter((r) => s.team?.[r]?.length).map((r) => `${TEAM_LABEL[r].replace('護理師', '')} ${s.team![r]!.map((x) => nameOf.user(x.userId)).join('→')}`)].join('・'),
    ...((due) => ({ postopDue: due, postopLate: due && !!s.endAt && (parseDate(now()).getTime() - parseDate(s.endAt).getTime()) / 3600000 > POSTOP_DUE_HOURS }))(s.status === 'done' && !s.postop && a?.status === 'admitted'),
    ...(s.postop ? { postopText: `${s.postop.at.slice(5)} ${nameOf.user(s.postop.by)}${s.postop.setName ? ` 套用「${s.postop.setName}」${s.postop.orderIds.length} 項` : `：沿用術前醫囑（${s.postop.note ?? ''}）`}${s.postop.npoStopped.length ? '；禁食停止' : ''}${s.postop.npoKept.length ? '；禁食保留' : ''}` } : {}),
    specimenRows: (s.specimens ?? []).map((x) => ({ id: x.id, text: specimenText(x) })),
    specimenStructured: !!(s.specimens || s.noSpecimen || s.status === 'in-progress'),
    ...((st) => (st ? { pathStageLabel: PATH_STAGE_LABEL[st] } : {}))(pathStage(s.path)),
    pathAckDue: pathCritical(s.path?.report) && !s.path?.ack,
    ...(s.path?.received?.missing?.length ? { pathMissing: `病理收件少了 ${s.path.received.missing.join('、')}：${s.path.received.note ?? ''}` } : {}),
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
export const surgeryOpen = (a: Admission) => db.surgeries.some((s) => s.admissionId === a.id && (s.status === 'sent' || s.status === 'in-progress' || (s.pacu && !s.pacu.received)))

const live = () => db.surgeries.filter((s) => db.admissions.find((a) => a.id === s.admissionId)?.status === 'admitted')

/** 首頁待辦：待排程（手術排程權限）；今天、明天要開但術前準備還沒完成（護理站）；主刀：手術紀錄待寫、計數不符 */
/** 恢復室：在恢復室的、停留超過 2 小時的、已轉出待病房接回的 */
export function pacuCounts(t: string): { in: number; long: number; out: number } {
  const xs = live().filter((s) => s.pacu && !s.pacu.received)
  const inn = xs.filter((s) => !s.pacu!.out)
  return { in: inn.length, long: inn.filter((s) => (parseDate(t).getTime() - parseDate(s.pacu!.inAt).getTime()) / 60000 > PACU_LONG_MINUTES).length, out: xs.length - inn.length }
}
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

/** 主刀首頁：術後醫囑待開（手術完成、住院中、還沒開）；完成超過 4 小時還沒開 */
export function postopCounts(t: string, doctorId: string): { due: number; late: number } {
  const xs = live().filter((s) => s.status === 'done' && !s.postop && s.doctorId === doctorId)
  return { due: xs.length, late: xs.filter((s) => s.endAt && (parseDate(t).getTime() - parseDate(s.endAt).getTime()) / 3600000 > POSTOP_DUE_HOURS).length }
}

/** 病理：主刀待確認（惡性或不符）；病理端待收件、逾時、待發報告 */
export function pathCounts(t: string, doctorId?: string): { ackDue: number; toReceive: number; overdue: number; toReport: number } {
  const xs = db.surgeries.filter((s) => s.path)
  const mins = (a: string) => (parseDate(t).getTime() - parseDate(a).getTime()) / 60000
  return {
    ackDue: doctorId ? xs.filter((s) => s.doctorId === doctorId && pathCritical(s.path!.report) && !s.path!.ack).length : 0,
    toReceive: xs.filter((s) => !s.path!.received).length,
    overdue: xs.filter((s) => !s.path!.received && mins(s.path!.sentAt) > PATH_RECEIVE_HOURS * 60).length,
    toReport: xs.filter((s) => s.path!.received && !s.path!.report).length,
  }
}

/**
 * 人員衝突：這個人同一時段已經是別台（還沒結束的）團隊現在的成員。
 * 時段＝排程開始到預估結束；手術中超過預估的算到現在＋15 分鐘。from＝這台從什麼時候開始要這個人（交班時間）
 */
export function teamClash(s: Surgery, userId: string, t: string, from?: string): Surgery | undefined {
  if (!s.schedule) return undefined
  const win = (x: Surgery, f?: string): [string, number] => {
    const st = f && f > x.schedule!.start ? f : x.schedule!.start
    let end = addMinutes(x.schedule!.start, x.estMinutes)
    if (x.status === 'in-progress' && end < addMinutes(t.slice(0, 16), 15)) end = addMinutes(t.slice(0, 16), 15)
    return [st, Math.max(1, Math.round((parseDate(end).getTime() - parseDate(st).getTime()) / 60000))]
  }
  const [a, am] = win(s, from)
  return db.surgeries.find((x) => x.id !== s.id && x.schedule && ['scheduled', 'sent', 'in-progress'].includes(x.status) && TEAM_ORDER.some((r) => teamNow(x, r) === userId) && ((w) => overlaps(a, am, w[0], w[1]))(win(x)))
}
