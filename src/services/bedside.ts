// 床邊侵入性處置（腰椎穿刺、胸腔穿刺、腹腔穿刺、胸管）：醫師登錄紀錄 → 用掉同意書、自動開已執行的處置醫令（帳單照醫令帶）。
// 規則在 bedside-rules
import type { BedsideKind, BedsideProcedure, IpdOrder, LineDevice } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'
import { latestLabValue } from './blood-work'
import { createOrderInternal } from './ipd'
import { SERUM_PROC, type FluidRead } from './bedside-rules'
import { escalateTo, noteOf, readingAlertKinds, readingAlertPending, readingEscalated, readingOf } from './bedside-work'
import { careRoleOf, requireCare } from './care-team'
import { BEDSIDE_FLUID, BEDSIDE_LABS, SIDE_TEXT, BEDSIDE_CONSENT_WAIVERS, BEDSIDE_KINDS, bedsideKind, bedsideTitle, bleedingRisks, checkBedsideInput, unusedBedsideConsent, type BedsideInput } from './bedside-rules'

export interface BedsideView extends BedsideProcedure {
  title: string
  performedByName: string
  consentNo?: string
  /** 送檢的醫囑內容 */
  labs: string[]
  /** 判讀（可能好幾項：腹水嗜中性球＋SAAG）；報告還沒齊＝readingWaiting 寫還缺什麼 */
  readings: FluidRead[]
  readingWaiting?: string
  /** 帶入病程紀錄的 O、A */
  note: { objective: string; assessment: string }
  /** 有異常判讀、還沒知悉 */
  alertPending: boolean
  /** 報告出來超過 2 小時還沒知悉：已升級（值班醫師或同科醫師） */
  alertEscalated: boolean
  /** 升級給誰（畫面顯示） */
  escalatedToName?: string
  readingAckByName?: string
}

const view = (p: BedsideProcedure): BedsideView => ({
  ...p, title: bedsideTitle(p.kind, p.side), performedByName: nameOf.user(p.performedBy),
  labs: (p.labOrderIds ?? []).map((id) => db.ipdOrders.find((o) => o.id === id)?.content ?? id),
  ...((r) => ({ ...r, note: noteOf(p, r) }))(readingOf(p)),
  alertPending: readingAlertPending(p),
  alertEscalated: readingEscalated(p, now()),
  ...(readingEscalated(p, now()) ? ((to) => ({ escalatedToName: to.kind === 'oncall' ? `值班醫師 ${nameOf.user(to.userId)}` : '同科醫師' }))(escalateTo(p.admissionId, now())) : {}),
  ...(p.readingAck ? { readingAckByName: nameOf.user(p.readingAck.by) } : {}),
  ...((c) => (c ? { consentNo: c.no } : {}))(p.consentId ? db.consents.find((x) => x.id === p.consentId) : undefined),
})

/** 這位病人現在的出血風險（最近的血小板、使用中的抗凝血／抗血小板藥） */
function risksOf(admissionId: string, patientId: string): string[] {
  const drugs = db.ipdOrders
    .filter((o) => o.admissionId === admissionId && o.category === 'medication' && o.status === 'active' && o.drugId)
    .map((o) => find.drug(o.drugId!))
    .filter((d): d is NonNullable<typeof d> => !!d)
  return bleedingRisks(latestLabValue(patientId, 'PLT'), [...new Map(drugs.map((d) => [d.id, { name: d.name, generic: d.generic }])).values()])
}

/** 這次住院的床邊處置（新到舊）、可以用的同意書（種類＋側別）、現在的出血風險 */
export function listBedside(admissionId: string): Promise<{ items: BedsideView[]; consentReady: { kind: BedsideKind; side?: 'left' | 'right' }[]; risks: string[]; admitted: boolean }> {
  return query(() => {
    requireUser('doctor', 'nurse')
    const a = must(find.admission(admissionId), '住院紀錄')
    const ready = BEDSIDE_KINDS.flatMap((m): { kind: BedsideKind; side?: 'left' | 'right' }[] => (m.sided ? (['left', 'right'] as const).map((side) => ({ kind: m.kind, side })) : [{ kind: m.kind }]))
      .filter((x) => unusedBedsideConsent(db.consents, db.bedsideProcedures, a.id, x.kind, x.side))
    return {
      items: db.bedsideProcedures.filter((p) => p.admissionId === a.id).sort((x, y) => y.performedAt.localeCompare(x.performedAt)).map(view),
      consentReady: ready,
      risks: risksOf(a.id, a.patientId),
      admitted: a.status === 'admitted',
    }
  })
}

/**
 * 登錄處置（醫師）：處置前暫停確認、欄位齊全、有出血風險要寫評估；
 * 要有這次住院、這種處置（同側）還沒用掉的同意書，緊急選原因。存檔時開一筆已執行的處置醫令
 */
export function recordBedside(input: BedsideInput & { admissionId: string; consentWaiver?: string }): Promise<BedsideView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = must(find.admission(input.admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
    const t = now()
    const risks = risksOf(a.id, a.patientId)
    failFields(checkBedsideInput(input, t, risks))
    const m = bedsideKind(input.kind as BedsideKind)
    const side = m.sided ? (input.side as 'left' | 'right') : undefined
    if (a.admittedAt && input.performedAt! < a.admittedAt.slice(0, 16)) failField('performedAt', '執行時間早於入院')
    let consent: { consentId: string } | { consentWaiver: string }
    if (input.consentWaiver) {
      if (!BEDSIDE_CONSENT_WAIVERS.includes(input.consentWaiver)) failField('consentWaiver', '請選沒有同意書的原因')
      consent = { consentWaiver: input.consentWaiver }
    } else {
      const c = unusedBedsideConsent(db.consents, db.bedsideProcedures, a.id, m.kind, side)
      if (!c) fail(`${bedsideTitle(m.kind, side)}要先有侵入性處置同意書（${m.sided ? '側別要一致；' : ''}醫師在病患資料「同意書」記錄）；緊急的請選原因`, 'CONFLICT')
      consent = { consentId: c!.id }
    }
    // 胸管：同一側已經有一條在身上就不能再放（要先移除）
    const chestSite = m.kind === 'chestTube' ? `${SIDE_TEXT[side!]}胸` : ''
    if (chestSite && db.lines.some((l) => l.admissionId === a.id && l.kind === 'chest' && !l.removedAt && l.site === chestSite)) fail(`${chestSite}已經有一條胸管：要換新的請先在「管路」移除舊的`, 'CONFLICT')
    const id = newId('BP')
    const title = bedsideTitle(m.kind, side)
    const o: IpdOrder = { id: newId('IO'), admissionId: a.id, type: 'stat', category: 'procedure', procId: m.procId, content: `${title}（床邊處置）`, startAt: input.performedAt!, stopAt: input.performedAt!, status: 'done', doctorId: u.doctorId ?? '', createdAt: t, ackAt: t, ackBy: u.id, bedsideId: id }
    db.ipdOrders.push(o)
    const p: BedsideProcedure = {
      id, admissionId: a.id, patientId: a.patientId, kind: m.kind, ...(side ? { side } : {}), indication: input.indication!.trim(), timeOutAt: t,
      ...(risks.length ? { bleedingRisks: risks, bleedingNote: input.bleedingNote!.trim() } : {}),
      performedAt: input.performedAt!, performedBy: u.id, appearance: input.appearance!.trim(),
      ...(m.volume ? { volumeMl: Number(input.volumeMl) } : {}),
      ...(m.volume && m.maxVolumeMl && Number(input.volumeMl) > m.maxVolumeMl ? { volumeNote: input.volumeNote!.trim() } : {}),
      ...(m.pressure && input.openingPressure !== '' && input.openingPressure !== undefined ? { openingPressure: Number(input.openingPressure) } : {}),
      complication: input.complication!.trim(), ...consent, orderId: o.id, recordedAt: t,
    }
    // 送檢：開臨時檢驗醫囑（寫明是哪一種體液），護理師貼條碼送檢
    const labs = [...new Set(input.labs ?? [])].sort((x, y) => BEDSIDE_LABS.findIndex((l) => l.procId === x) - BEDSIDE_LABS.findIndex((l) => l.procId === y))
    // 胸水送體液生化：同時抽血清總蛋白、LDH（Light's criteria 判讀用）
    if (labs.includes('P073')) labs.push(SERUM_PROC)
    if (labs.length) p.labOrderIds = labs.map((procId) => procId === SERUM_PROC ? createOrderInternal(u, a.id, { admissionId: a.id, type: 'stat', category: 'procedure', procId, content: `${find.procedure(procId)!.name}（${BEDSIDE_FLUID[m.kind]}判讀・床邊${m.label}）` }, t).id : createOrderInternal(u, a.id, { admissionId: a.id, type: 'stat', category: 'procedure', procId, content: `${find.procedure(procId)!.name.replace(/（[^）]*）$/, '')}（${BEDSIDE_FLUID[m.kind]}・床邊${m.label}）` }, t).id)
    // 胸管：建一條管路（之後護理師在「管路」記引流量、漏氣，移除也在那裡）；放好時的引流算第一筆
    if (m.kind === 'chestTube') {
      const l: LineDevice = { id: newId('LN'), admissionId: a.id, kind: 'chest', site: chestSite, size: input.tubeSize!.trim(), insertedAt: p.performedAt, placedBy: u.name, recordedBy: u.id, recordedAt: t, bedsideId: id, drainage: [{ at: p.performedAt, by: u.id, ml: p.volumeMl ?? 0, appearance: p.appearance, airLeak: !!input.airLeak }] }
      db.lines.push(l)
      Object.assign(p, { tubeSize: l.size, airLeak: !!input.airLeak, lineId: l.id })
    }
    db.bedsideProcedures.push(p)
    audit('床邊處置', `${a.admitNo} ${nameOf.patient(a.patientId)}：${title} ${p.performedAt}（${u.name}）${'consentId' in consent ? `；同意書 ${db.consents.find((c) => c.id === consent.consentId)?.no}` : `；無同意書：${consent.consentWaiver}`}${risks.length ? `；出血風險：${risks.join('、')}` : ''}${labs.length ? `；送檢 ${labs.length} 項` : ''}`)
    return view(p)
  })
}

/** 異常判讀已知悉（醫師）：記下當時的異常判讀；之後報告更正、判讀變了會再提醒 */
export function ackReading(id: string): Promise<BedsideView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const p = must(db.bedsideProcedures.find((x) => x.id === id), '床邊處置')
    // 主治或同科醫師（照護團隊）；會診醫師不能
    requireCare(u.doctorId, must(find.admission(p.admissionId), '住院紀錄'), '確認床邊處置判讀', { consult: false })
    const kinds = readingAlertKinds(p)
    if (!kinds) fail('這筆沒有要確認的異常判讀', 'CONFLICT')
    if (p.readingAck?.kinds === kinds) fail('已經知悉了', 'CONFLICT')
    p.readingAck = { kinds, at: now(), by: u.id }
    audit('床邊處置判讀知悉', `${nameOf.patient(p.patientId)} ${bedsideTitle(p.kind, p.side)}：${readingOf(p).readings.filter((r) => r.alert).map((r) => r.label).join('、')}`)
    return view(p)
  })
}

/** 首頁：我主治的住院病人有異常判讀還沒知悉；同科（照護團隊、不是主治）的病人超過 2 小時沒知悉的也列（escalated） */
export function myBedsideAlerts(): Promise<{ id: string; admissionId: string; patientName: string; title: string; labels: string[]; escalated: boolean }[]> {
  return query(() => {
    const u = requireUser('doctor')
    const t = now()
    return db.bedsideProcedures.filter((p) => {
      const a = db.admissions.find((x) => x.id === p.admissionId && x.status === 'admitted')
      if (!a || !readingAlertPending(p)) return false
      if (a.doctorId === u.doctorId) return true
      if (!readingEscalated(p, t)) return false
      const to = escalateTo(a.id, t)
      return to.kind === 'oncall' ? to.userId === u.id : careRoleOf(u.doctorId, a)?.kind === 'team'
    }).map((p) => ({ id: p.id, admissionId: p.admissionId, patientName: nameOf.patient(p.patientId), title: bedsideTitle(p.kind, p.side), labels: readingOf(p).readings.filter((r) => r.alert).map((r) => r.label), escalated: db.admissions.find((a) => a.id === p.admissionId)!.doctorId !== u.doctorId }))
  })
}
