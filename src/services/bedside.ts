// 床邊侵入性處置（腰椎穿刺、胸腔穿刺、腹腔穿刺、胸管）：醫師登錄紀錄 → 用掉同意書、自動開已執行的處置醫令（帳單照醫令帶）。
// 規則在 bedside-rules
import type { BedsideKind, BedsideProcedure, IpdOrder } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'
import { latestLabValue } from './blood-work'
import { BEDSIDE_CONSENT_WAIVERS, BEDSIDE_KINDS, bedsideKind, bedsideTitle, bleedingRisks, checkBedsideInput, unusedBedsideConsent, type BedsideInput } from './bedside-rules'

export interface BedsideView extends BedsideProcedure {
  title: string
  performedByName: string
  consentNo?: string
}
const view = (p: BedsideProcedure): BedsideView => ({
  ...p, title: bedsideTitle(p.kind, p.side), performedByName: nameOf.user(p.performedBy),
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
    db.bedsideProcedures.push(p)
    audit('床邊處置', `${a.admitNo} ${nameOf.patient(a.patientId)}：${title} ${p.performedAt}（${u.name}）${'consentId' in consent ? `；同意書 ${db.consents.find((c) => c.id === consent.consentId)?.no}` : `；無同意書：${consent.consentWaiver}`}${risks.length ? `；出血風險：${risks.join('、')}` : ''}`)
    return view(p)
  })
}
