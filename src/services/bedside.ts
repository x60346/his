// 床邊侵入性處置（腰椎穿刺、胸腔穿刺、腹腔穿刺、胸管）：醫師登錄紀錄 → 用掉同意書、自動開已執行的處置醫令（帳單照醫令帶）。
// 規則在 bedside-rules
import type { BedsideKind, BedsideProcedure, IpdOrder, LineDevice } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'
import { latestLabValue } from './blood-work'
import { createOrderInternal } from './ipd'
import { ascitesPmn, csfRead, lightCriteria, PLEURAL_KINDS, saagRead, SERUM_PAIR_HOURS, SERUM_PROC, type FluidRead } from './bedside-rules'
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
}

const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v))
/** 這筆處置送檢的某項報告的值（code → 數字） */
function reportValues(p: BedsideProcedure, procId: string): Record<string, number | undefined> | undefined {
  const o = (p.labOrderIds ?? []).map((id) => db.ipdOrders.find((x) => x.id === id)).find((x) => x?.procId === procId)
  const r = o ? db.labReports.find((x) => x.orderId === o.id) : undefined
  return r ? Object.fromEntries(r.values.map((v) => [v.code, num(v.value)])) : undefined
}
/** 判讀：胸水（體液生化＋血清：Light's criteria）、腹水（體液常規：嗜中性球；體液生化＋血清：SAAG）、腦脊髓液（體液常規，有生化、血清就加蛋白與血糖比值） */
function readingOf(p: BedsideProcedure): Pick<BedsideView, 'readings' | 'readingWaiting'> {
  const ordered = (procId: string) => (p.labOrderIds ?? []).some((id) => db.ipdOrders.find((x) => x.id === id)?.procId === procId)
  const routine = reportValues(p, 'P072')
  const chem = reportValues(p, 'P073')
  const ms = SERUM_PAIR_HOURS * 3600000
  const at = Date.parse(p.performedAt.replace(' ', 'T'))
  const serumRep = db.labReports.filter((r) => r.patientId === p.patientId && r.procId === SERUM_PROC && Math.abs(Date.parse((db.ipdOrders.find((o) => o.id === r.orderId)?.createdAt ?? r.orderedAt).replace(' ', 'T')) - at) <= ms).sort((x, y) => y.reportedAt.localeCompare(x.reportedAt))[0]
  const serum = serumRep ? Object.fromEntries(serumRep.values.map((v) => [v.code, num(v.value)])) : undefined
  const wait: string[] = []
  const need = (have: unknown, procId: string, label: string) => { if (!have && ordered(procId)) wait.push(label) }
  const out: FluidRead[] = []
  if (PLEURAL_KINDS.includes(p.kind)) {
    if (chem && serum) { const r = lightCriteria({ pro: chem['F-PRO'], ldh: chem['F-LDH'] }, { pro: serum.TP, ldh: serum.LDH }); if (r) out.push(r) }
    need(chem, 'P073', '體液生化'); need(serum, SERUM_PROC, '血清生化')
  } else if (p.kind === 'paracentesis') {
    if (routine) { const r = ascitesPmn(routine['F-WBC'], routine['F-PMN']); if (r) out.push(r) }
    if (chem && serum) { const r = saagRead(serum.ALB, chem['F-ALB']); if (r) out.push(r) }
    need(routine, 'P072', '體液常規'); need(chem, 'P073', '體液生化'); need(serum, SERUM_PROC, '血清生化')
  } else if (p.kind === 'lp') {
    // 腦脊髓液：生化、血清有開就等齊了再判讀（血糖比值是細菌性腦膜炎的重要依據）
    need(routine, 'P072', '體液常規'); need(chem, 'P073', '體液生化'); need(serum, SERUM_PROC, '血清生化')
    if (routine && !wait.length) { const r = csfRead({ wbc: routine['F-WBC'], pmn: routine['F-PMN'], glu: chem?.['F-GLU'], proGdl: chem?.['F-PRO'] }, serum?.GLU); if (r) out.push(r) }
  }
  return { readings: out, ...(wait.length ? { readingWaiting: `等${wait.join('、')}報告` } : {}) }
}

const view = (p: BedsideProcedure): BedsideView => ({
  ...p, title: bedsideTitle(p.kind, p.side), performedByName: nameOf.user(p.performedBy),
  labs: (p.labOrderIds ?? []).map((id) => db.ipdOrders.find((o) => o.id === id)?.content ?? id),
  ...readingOf(p),
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
