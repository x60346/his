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
import { dayFollowUpDue, dayStage } from './day-rules'
import { biText, expectedInstruments, PACK_SET_LABEL } from './sterile-rules'
import { implantFeeItems, implantRows, isSelfPayImplant } from './implant-work'
import { IMPLANT_FOR } from './implant-rules'
import { implantPreAuthOf } from './preauth-work'
import { preAuthAllows, PREAUTH_STATUS_LABEL } from './preauth-rules'
import { CONSENT_KIND_LABEL, consentMissing, consentSideMismatch } from './consent-rules'
import { delayOverflow, delayTotal, NPO_DELAY_ALERT, pullBackOf } from './or-shift-rules'
import { FROZEN_MINUTES, frozenState, pathCritical, pathStage, PATH_RECEIVE_HOURS, PATH_STAGE_LABEL, specimenText } from './pathology-rules'

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
  /** 被急刀插台順延：每次的經過（主刀、病房已讀）；累計分鐘；原本的開始時間 */
  delayRows: { id: string; text: string; surgeonAck?: string; wardAck?: string }[]
  delayMinutes: number
  originalStart?: string
  /** 還沒讀的：主刀、病房護理站 */
  delayUnread: { surgeon: boolean; ward: boolean }
  /** 順延到超過開放時段、還沒改期也還沒同意加班（標紅） */
  delayOverflow: boolean
  overtimeText?: string
  /** 累計順延 ≥ 2 小時、病人已在禁食：提醒病房評估補點滴 */
  npoLong: boolean
  /** 可以拉回原時間（插台的急刀已取消或改期）：回到幾點、為什麼 */
  pullBack?: { to: string; why: string }
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
  specimenRows: { id: string; text: string; frozen?: { text: string; overdue: boolean; done: boolean } }[]
  /** 冰凍切片等待回報（手術室卡片標示；超過 20 分鐘標紅） */
  frozenWaiting: { label: string; minutes: number; overdue: boolean }[]
  /** 新手術（逐件登記）：手術紀錄的檢體不用另打 */
  specimenStructured: boolean
  pathStageLabel?: string
  pathAckDue: boolean
  /** 收件時少了的 */
  pathMissing?: string
  /** 器械包：這台掃了哪幾包（哪一鍋、生物指示劑）；有用到召回那鍋的；會放植入物（要生物指示劑陰性） */
  packRows: { id: string; no: string; setLabel: string; batchNo: string; biText: string; recalled: boolean }[]
  packRecalled: boolean
  /** 逐件清點的清單（掃過的包合起來）；沒掃包＝空（照舊填總數） */
  instrumentExpected: { name: string; qty: number }[]
  implant: boolean
  /** 植入物：登記了哪些（自費、召回標出來）；會放植入物還沒登記；這個術式有自費品項、病人同意了沒 */
  implantRows: ReturnType<typeof implantRows>
  implantMissing: boolean
  implantRecalled: boolean
  selfPayOption: boolean
  selfPayText?: string
  /** 這個術式會用到、需健保事前審查的植入物：申請了沒、狀態、能不能用 */
  preAuthItems: { procId: string; name: string; preAuth?: { id: string; no: string; statusLabel: string; allows: boolean } }[]
  /** 知情同意書：綁這台的（含撤回的）、還缺哪幾張 */
  consents: { id: string; no: string; kind: string; kindLabel: string; title: string; sideText?: string; signerText: string; signedAt: string; explainedByName: string; revoked?: string }[]
  consentMissing: { kind: string; label: string }[]
}
/** 順延的一行：「11-20 09:10 急刀 OR… 插台：09:00 → 11:00（延後 120 分）」；跨日的寫日期 */
export const delayText = (d: NonNullable<Surgery['delays']>[number]) => d.pullBack
  ? `${d.at.slice(5, 16)} 急刀 ${d.causeNo} 取消或改期，拉回：${d.from.slice(d.from.slice(0, 10) === d.to.slice(0, 10) ? 11 : 5)} → ${d.to.slice(d.from.slice(0, 10) === d.to.slice(0, 10) ? 11 : 5)}（提前 ${-d.minutes} 分）`
  : `${d.at.slice(5, 16)} 急刀 ${d.causeNo} 插台：${d.from.slice(d.from.slice(0, 10) === d.to.slice(0, 10) ? 11 : 5)} → ${d.to.slice(d.from.slice(0, 10) === d.to.slice(0, 10) ? 11 : 5)}（延後 ${d.minutes} 分）`
/** 還沒讀的順延（主刀、病房）：取消、已經送了的不算 */
export const delayUnread = (s: Surgery, who: 'surgeon' | 'ward') => (s.status === 'requested' || s.status === 'scheduled') && (s.delays ?? []).some((d) => !d[who === 'surgeon' ? 'surgeonAck' : 'wardAck'])

const mins = (a: string, b: string) => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 60000)

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
    delayRows: (s.delays ?? []).map((d) => ({ id: d.id, text: delayText(d), ...(d.surgeonAck ? { surgeonAck: who(d.surgeonAck) } : {}), ...(d.wardAck ? { wardAck: who(d.wardAck) } : {}) })),
    delayMinutes: delayTotal(s), ...(s.delays?.length ? { originalStart: s.delays[0].from } : {}),
    delayUnread: { surgeon: delayUnread(s, 'surgeon'), ward: delayUnread(s, 'ward') },
    delayOverflow: delayOverflow(s), ...(s.overtime ? { overtimeText: `同意加班・${who(s.overtime)}` } : {}),
    npoLong: s.status === 'scheduled' && delayTotal(s) >= NPO_DELAY_ALERT && !!s.prep.npo && !s.prep.npo.notNeeded,
    ...((d) => (d ? { pullBack: { to: d.from, why: `急刀 ${d.causeNo} ${surgeryOf(d.causeId)?.status === 'cancelled' ? '已取消' : '已改期'}` } } : {}))(pullBackOf(s, surgeryOf)),
    ...(s.preAnes ? { preAnesText: preAnesSummary(s.preAnes, s.preAnes.plan ? `${ANESTHESIA_LABEL[s.preAnes.plan]}${s.preAnes.changedFrom ? `（原申請${ANESTHESIA_LABEL[s.preAnes.changedFrom]}：${s.preAnes.planReason}）` : ''}` : undefined), preAnesByName: `${nameOf.user(s.preAnes.by)} ${s.preAnes.at.slice(5)}` } : {}),
    teamRows: TEAM_ORDER.map((r) => ((id) => ({ role: r, label: TEAM_LABEL[r], ...(id ? { userId: id, name: nameOf.user(id) } : {}), shifts: (s.team?.[r] ?? []).map((x) => ({ name: nameOf.user(x.userId), ...(x.from ? { from: x.from } : {}), ...(x.to ? { to: x.to } : {}) })) }))(teamNow(s, r))),
    teamMissing: (s.status === 'scheduled' || s.status === 'sent' ? teamMissing(s, s.status === 'sent' && !s.checks.signIn ? 'signIn' : 'timeOut') : []).map((r) => TEAM_LABEL[r]),
    teamText: [`主刀 ${nameOf.doctor(s.doctorId)}`, ...TEAM_ORDER.filter((r) => s.team?.[r]?.length).map((r) => `${TEAM_LABEL[r].replace('護理師', '')} ${s.team![r]!.map((x) => nameOf.user(x.userId)).join('→')}`)].join('・'),
    ...((due) => ({ postopDue: due, postopLate: due && !!s.endAt && (parseDate(now()).getTime() - parseDate(s.endAt).getTime()) / 3600000 > POSTOP_DUE_HOURS }))(s.status === 'done' && !s.postop && a?.status === 'admitted' && !dayCase(a)),
    ...(s.postop ? { postopText: `${s.postop.at.slice(5)} ${nameOf.user(s.postop.by)}${s.postop.setName ? ` 套用「${s.postop.setName}」${s.postop.orderIds.length} 項` : `：沿用術前醫囑（${s.postop.note ?? ''}）`}${s.postop.npoStopped.length ? '；禁食停止' : ''}${s.postop.npoKept.length ? '；禁食保留' : ''}` } : {}),
    specimenRows: (s.specimens ?? []).map((x) => ({ id: x.id, text: specimenText(x), ...(x.frozen ? { frozen: ((st) => ({ text: x.frozen!.result ? `冰凍 ${st.minutes} 分回報：${x.frozen!.result.text}（接聽 ${nameOf.user(x.frozen!.result.receivedBy)}）` : `冰凍等待回報 ${st.minutes} 分${st.overdue ? `（超過 ${FROZEN_MINUTES} 分）` : ''}`, overdue: st.overdue && !st.done, done: st.done }))(frozenState(x.frozen, now(), mins)) } : {}) })),
    frozenWaiting: (s.specimens ?? []).filter((x) => x.frozen && !x.frozen.result).map((x) => ((st) => ({ label: x.label, minutes: st.minutes, overdue: st.overdue }))(frozenState(x.frozen!, now(), mins))),
    specimenStructured: !!(s.specimens || s.noSpecimen || s.status === 'in-progress'),
    ...((st) => (st ? { pathStageLabel: PATH_STAGE_LABEL[st] } : {}))(pathStage(s.path)),
    pathAckDue: pathCritical(s.path?.report) && !s.path?.ack,
    ...(s.path?.received?.missing?.length ? { pathMissing: `病理收件少了 ${s.path.received.missing.join('、')}：${s.path.received.note ?? ''}` } : {}),
    ...((rows) => ({ packRows: rows, packRecalled: rows.some((r) => r.recalled) }))(db.instrumentPacks.filter((p) => p.used?.surgeryId === s.id).map((p) => ((b) => ({ id: p.id, no: p.no, setLabel: PACK_SET_LABEL[p.set], batchNo: b?.no ?? '', biText: b ? biText(b, now()) : '', recalled: b?.bi?.result === 'positive' }))(db.sterileBatches.find((b) => b.id === p.batchId)))),
    instrumentExpected: expectedInstruments(db.instrumentPacks.filter((p) => p.used?.surgeryId === s.id).map((p) => p.set)),
    implant: !!find.procedure(s.procId)?.surgery?.implant,
    ...((rows) => ({ implantRows: rows, implantRecalled: rows.some((r) => r.recalled), implantMissing: !!find.procedure(s.procId)?.surgery?.implant && !rows.length && ['sent', 'in-progress'].includes(s.status) }))(implantRows(s)),
    selfPayOption: (IMPLANT_FOR[s.procId] ?? []).some((id) => isSelfPayImplant(find.procedure(id))),
    consents: db.consents.filter((c) => c.surgeryId === s.id).map((c) => ({ id: c.id, no: c.no, kind: c.kind, kindLabel: CONSENT_KIND_LABEL[c.kind], title: c.title, signerText: `${c.signer.name}（${c.signer.relation}${c.signer.reason ? `：${c.signer.reason}` : ''}）`, ...(c.side ? { sideText: SIDE_LABEL[c.side] } : {}), signedAt: c.signedAt, explainedByName: nameOf.user(c.explainedBy), ...(c.revoked ? { revoked: `${c.revoked.at.slice(5)} ${nameOf.user(c.revoked.by)}：${c.revoked.reason}` } : {}) })),
    consentMissing: consentMissing(s.anesthesia, db.consents.filter((c) => c.surgeryId === s.id), s.side).map((k) => ((mm) => ({ kind: k, label: mm && k === 'surgery' ? `${CONSENT_KIND_LABEL[k]}（側別不符：同意書是${SIDE_LABEL[mm.side!]}、手術是${SIDE_LABEL[s.side]}，要重簽）` : CONSENT_KIND_LABEL[k] }))(consentSideMismatch(db.consents.filter((c) => c.surgeryId === s.id), s.side))),
    preAuthItems: (IMPLANT_FOR[s.procId] ?? []).filter((id) => find.procedure(id)?.preAuth).map((id) => ((p) => ({ procId: id, name: find.procedure(id)!.name, ...(p ? { preAuth: { id: p.id, no: p.no, statusLabel: PREAUTH_STATUS_LABEL[p.status], allows: preAuthAllows(p) } } : {}) }))(implantPreAuthOf(s.id, id))),
    ...(s.selfPayImplant ? { selfPayText: `病人已同意自費植入物・${who(s.selfPayImplant)}${s.selfPayImplant.note ? `（${s.selfPayImplant.note}）` : ''}` } : {}),
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
export function surgeryFeeItems(admissionId: string): { proc: Procedure; qty: number; date: string; selfPay?: boolean }[] {
  const out: { proc: Procedure; qty: number; date: string; selfPay?: boolean }[] = []
  for (const s of db.surgeries.filter((x) => x.admissionId === admissionId && x.status === 'done')) {
    const proc = find.procedure(s.procId)
    const date = s.endAt ?? s.createdAt
    if (proc) out.push({ proc, qty: 1, date })
    const an = db.procedures.find((p) => p.anesthesiaFee === s.anesthesia)
    if (an) out.push({ proc: an, qty: 1, date })
    out.push(...implantFeeItems(s))
  }
  return out
}

/** 出院前：在手術室（已送、手術中）不能出院 */
// 日間手術（沒轉住院的）不用病房接回：恢復室轉出就算出來了（接著評 PADSS）
export const surgeryOpen = (a: Admission) => db.surgeries.some((s) => s.admissionId === a.id && (s.status === 'sent' || s.status === 'in-progress' || (s.pacu && !s.pacu.received && !(dayCase(a) && s.pacu.out))))
/** 日間手術、還沒轉住院 */
export const dayCase = (a: Admission | undefined) => !!a?.day && !a.day.converted

const live = () => db.surgeries.filter((s) => db.admissions.find((a) => a.id === s.admissionId)?.status === 'admitted')

/** 首頁待辦：待排程（手術排程權限）；今天、明天要開但術前準備還沒完成（護理站）；主刀：手術紀錄待寫、計數不符 */
/** 恢復室：在恢復室的、停留超過 2 小時的、已轉出待病房接回的 */
export function pacuCounts(t: string): { in: number; long: number; out: number } {
  const xs = live().filter((s) => s.pacu && !s.pacu.received && !(dayCase(find.admission(s.admissionId)) && s.pacu.out))
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
  // 日間手術（沒轉住院）當天回家，不用術後醫囑
  const xs = live().filter((s) => s.status === 'done' && !s.postop && s.doctorId === doctorId && !dayCase(find.admission(s.admissionId)))
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

/** 冰凍切片等待回報（全院）；其中超過 20 分鐘的 */
export function frozenCounts(t: string): { waiting: number; overdue: number } {
  const xs = db.surgeries.flatMap((s) => (s.specimens ?? []).filter((x) => x.frozen && !x.frozen.result).map((x) => frozenState(x.frozen!, t, mins)))
  return { waiting: xs.length, overdue: xs.filter((x) => x.overdue).length }
}

/** 首頁（護理師）：今天的日間手術待報到、待出院評估（第二期）、回家後待電話追蹤 */
export function dayCounts(t: string): { toCheckIn: number; phase2: number; followUp: number } {
  const d = t.slice(0, 10)
  const all = db.admissions.filter((a) => a.day && surgeryOf(a.day.surgeryId))
  const stageOf = (a: Admission) => dayStage(a, surgeryOf(a.day!.surgeryId))
  return {
    toCheckIn: all.filter((a) => stageOf(a) === 'reserved' && surgeryOf(a.day!.surgeryId)!.schedule?.start.slice(0, 10) === d).length,
    phase2: all.filter((a) => stageOf(a) === 'phase2').length,
    followUp: all.filter((a) => dayFollowUpDue(a, d) || (a.day!.followUp && !a.day!.followUp.reached)).length,
  }
}

/** 首頁：順延未讀（主刀＝自己主刀的；護理師＝全院病房的）；順延超過開放時段待處理（排程） */
export function delayCounts(doctorId?: string): { unread: number; overflow: number } {
  const xs = db.surgeries.filter((s) => ((a) => a?.status === 'admitted' || (!!a?.day && a.status === 'reserved'))(find.admission(s.admissionId)))
  return {
    unread: doctorId ? xs.filter((s) => s.doctorId === doctorId && delayUnread(s, 'surgeon')).length : xs.filter((s) => delayUnread(s, 'ward')).length,
    overflow: xs.filter(delayOverflow).length,
  }
}
