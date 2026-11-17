// 病人自控止痛（PCA）：
//   醫師開（住院醫囑「PCA」：藥袋、單次劑量、鎖定時間、每小時上限、基礎速率；要有效的管制藥執照）
//   → 護理師雙人核對架設（第二位護理師帳密；住院藥局扣一袋，進住院帳單與管制藥簿冊）
//   → 每 4 小時紀錄（按壓／給藥次數、累計用量、疼痛、鎮靜、呼吸；鎮靜 ≥3 或呼吸 <10 紅字建議暫停、主治首頁緊急）
//   → 結束（原因）：剩餘量雙人見證銷毀，記進管制藥簿冊的殘餘量。紀錄上的疼痛分數也算疼痛評估（本班已評、≥4 重評）
import type { PcaOrder, PcaRecord } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { find, nameOf, stockLoc } from './views'
import { careRoleOf, requireCare } from './care-team'
import { licenseProblem } from './controlled-rules'
import { checkPcaInput, checkPcaRecord, PCA_END_REASONS, pcaAlert, pcaAlertText, pcaMaxPerHour } from './pca-rules'
import { pcaOpenAlert, pcaRecordState } from './pca-work'
import { postStock } from './stock-ledger'
import { consumeWitness, pcaRef, WITNESS_MIN, witnessFor } from './witness-core'

export interface PcaView extends PcaOrder {
  drugName: string
  volumeMl: number
  orderedByName: string
  setupByName?: string
  setupWitnessName?: string
  endByName?: string
  endWitnessName?: string
  maxPerHour: number
  usedMl: number
  recordDue?: { dueAt: string; status: 'ok' | 'due' | 'overdue' }
  openAlert?: PcaRecord & { text: string }
  recordViews: (PcaRecord & { byName: string; alertText?: string })[]
}

const pView = (p: PcaOrder, t: string): PcaView => {
  const drug = find.drug(p.drugId)
  const oa = pcaOpenAlert(p)
  return {
    ...p, drugName: drug?.name ?? p.drugId, volumeMl: drug?.pca?.volumeMl ?? 100, orderedByName: nameOf.user(p.orderedBy),
    ...(p.setup ? { setupByName: nameOf.user(p.setup.by), setupWitnessName: nameOf.user(p.setup.witnessBy) } : {}),
    ...(p.end ? { endByName: nameOf.user(p.end.by), endWitnessName: nameOf.user(p.end.witnessBy) } : {}),
    maxPerHour: pcaMaxPerHour(p), usedMl: p.records.at(-1)?.usedMl ?? 0,
    ...(p.status === 'running' ? { recordDue: pcaRecordState(p, t) } : {}),
    ...(oa && p.status === 'running' ? { openAlert: { ...oa, text: pcaAlertText(oa) } } : {}),
    recordViews: [...p.records].reverse().map((r) => ({ ...r, byName: nameOf.user(r.by), ...(r.alert ? { alertText: pcaAlertText(r) } : {}) })),
  }
}

const admittedOf = (id: string) => {
  const a = must(find.admission(id), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return a
}

export interface PatientPca {
  admissionId: string
  pcas: PcaView[]
  /** PCA 藥袋（主檔） */
  drugs: { id: string; name: string }[]
  canOrder: boolean
  canNurse: boolean
}

export function patientPca(admissionId: string): Promise<PatientPca> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'admin', 'pharmacist')
    const a = must(find.admission(admissionId), '住院紀錄')
    const t = now()
    const role = u.role === 'doctor' ? careRoleOf(u.doctorId, a) : undefined
    return {
      admissionId: a.id, pcas: db.pcas.filter((p) => p.admissionId === a.id).sort((x, y) => y.orderedAt.localeCompare(x.orderedAt)).map((p) => pView(p, t)),
      drugs: db.drugs.filter((d) => d.pca && d.active).map((d) => ({ id: d.id, name: d.name })),
      canOrder: !!role && role.kind !== 'consult' && a.status === 'admitted', canNurse: u.role === 'nurse' && a.status === 'admitted',
    }
  })
}

export interface PcaInput {
  drugId: string
  bolusMg: number
  lockoutMin: number
  hourLimitMg: number
  basalMgH: number
}

/** 醫師開 PCA：同一位病人同時只能一筆（已開或使用中） */
export function orderPca(admissionId: string, input: PcaInput): Promise<PcaView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = admittedOf(admissionId)
    requireCare(u.doctorId, a, '開 PCA', { consult: false })
    const drug = must(find.drug(input.drugId), '藥品')
    if (!drug.pca || !drug.active) failField('drugId', '請選 PCA 藥袋')
    const doc = find.doctor(u.doctorId ?? '')
    const why = drug.controlled ? licenseProblem(doc?.controlledLicense, now().slice(0, 10)) : undefined
    if (why) failField('drugId', `${doc?.name ?? '醫師'}${why}，不能開立管制藥 PCA`)
    failFields(checkPcaInput(input))
    if (db.pcas.some((p) => p.admissionId === a.id && (p.status === 'ordered' || p.status === 'running'))) fail('已經有一筆 PCA（已開或使用中）：要改設定請先結束再開新的', 'CONFLICT')
    const t = now()
    const p: PcaOrder = { id: newId('PCA'), admissionId: a.id, drugId: drug.id, bolusMg: input.bolusMg, lockoutMin: input.lockoutMin, hourLimitMg: input.hourLimitMg, basalMgH: input.basalMgH, orderedBy: u.id, orderedAt: t, status: 'ordered', records: [] }
    db.pcas.push(p)
    audit('開立 PCA', `${a.admitNo} ${nameOf.patient(a.patientId)}：${drug.name} 單次 ${p.bolusMg} mg、鎖定 ${p.lockoutMin} 分、每小時上限 ${p.hourLimitMg} mg、基礎 ${p.basalMgH} mg/h`)
    return pView(p, t)
  })
}

/** 醫師取消還沒架設的 PCA */
export function cancelPca(id: string, reason: string): Promise<PcaView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const p = must(db.pcas.find((x) => x.id === id), 'PCA')
    requireCare(u.doctorId, admittedOf(p.admissionId), '取消 PCA', { consult: false })
    if (p.status !== 'ordered') fail('已經架設了：請護理師結束並銷毀剩餘量', 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫原因')
    const t = now()
    Object.assign(p, { status: 'cancelled', cancelled: { at: t, by: u.id, reason: reason.trim() } })
    return pView(p, t)
  })
}

const witnessOk = (token: string | undefined, p: PcaOrder, stage: 'setup' | 'end', actorId: string) => {
  const w = witnessFor(token, 'pca', pcaRef(p.id, stage), actorId)
  if (w === null) failField('witness', stage === 'setup' ? '架設 PCA 要另一位護理師核對' : '剩餘量銷毀要另一位護理師見證')
  if (w === 'expired') failField('witness', `核對已超過 ${WITNESS_MIN} 分鐘，請重新核對`)
  return w as Exclude<typeof w, null | 'expired'>
}

/** 架設（護理師＋第二位護理師核對）：住院藥局扣一袋（異動單號帶住院號，進住院帳單、管制藥簿冊） */
export function setupPca(id: string, witness?: string): Promise<PcaView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const p = must(db.pcas.find((x) => x.id === id), 'PCA')
    const a = admittedOf(p.admissionId)
    if (p.status !== 'ordered') fail('這筆 PCA 已經架設或結束了', 'CONFLICT')
    const w = witnessOk(witness, p, 'setup', u.id)
    const loc = stockLoc.ipd()
    const t = now()
    const txn = postStock({ kind: 'out', type: 'dispense', drugId: p.drugId, locationId: loc, qty: 1, ref: `PCA ${a.admitNo}`, patientId: a.patientId, doctorId: find.user(p.orderedBy)?.doctorId, witnessBy: w.witnessId }, u.id, t)
    Object.assign(p, { status: 'running', setup: { at: t, by: u.id, witnessBy: w.witnessId, txnId: txn.id } })
    audit('PCA 架設', `${a.admitNo} ${nameOf.patient(a.patientId)}（核對 ${w.witnessName}）`)
    consumeWitness(witness)
    return pView(p, t)
  })
}

export interface PcaRecordInput {
  demands: number
  delivered: number
  usedMl: number
  pain: number
  sedation: 1 | 2 | 3 | 4
  resp: number
  note?: string
}

/** 每 4 小時紀錄（護理師）：鎮靜 ≥3 或呼吸 <10 回 warning（建議暫停、通知醫師），照樣存 */
export function recordPca(id: string, input: PcaRecordInput): Promise<{ pca: PcaView; warning?: string }> {
  return mutate(() => {
    const u = requireUser('nurse')
    const p = must(db.pcas.find((x) => x.id === id), 'PCA')
    admittedOf(p.admissionId)
    if (p.status !== 'running') fail('這筆 PCA 沒有在使用中', 'CONFLICT')
    const vol = find.drug(p.drugId)?.pca?.volumeMl ?? 100
    failFields(checkPcaRecord(input, p.records.at(-1)?.usedMl ?? 0, vol))
    const alert = pcaAlert(input)
    if (alert && !input.note?.trim()) failField('note', '有警示：請寫處置（例：暫停 PCA、給氧、通知醫師）')
    const t = now()
    const r: PcaRecord = { at: t, by: u.id, demands: input.demands, delivered: input.delivered, usedMl: input.usedMl, pain: input.pain, sedation: input.sedation, resp: input.resp, ...(input.note?.trim() ? { note: input.note.trim() } : {}), alert }
    p.records.push(r)
    audit('PCA 紀錄', `${nameOf.patient(find.admission(p.admissionId)?.patientId)}：按 ${r.demands} 次給 ${r.delivered} 次、累計 ${r.usedMl} ml、疼痛 ${r.pain}、鎮靜 ${r.sedation}、呼吸 ${r.resp}${alert ? '（警示）' : ''}`)
    return { pca: pView(p, t), ...(alert ? { warning: `${pcaAlertText(r)}：建議暫停 PCA 並通知醫師（主治首頁會出現）` } : {}) }
  })
}

/** 醫師處理警示（寫處置：調低劑量、停止、觀察） */
export function ackPcaAlert(id: string, note: string): Promise<PcaView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const p = must(db.pcas.find((x) => x.id === id), 'PCA')
    requireCare(u.doctorId, admittedOf(p.admissionId), '處理 PCA 警示', { consult: false })
    if (!pcaOpenAlert(p)) fail('沒有待處理的警示', 'CONFLICT')
    if (!note?.trim()) failField('note', '請寫處置（例：停止基礎速率、給 Naloxone、改口服）')
    const t = now()
    p.alertAck = { at: t, by: u.id, note: note.trim() }
    audit('PCA 警示處理', `${nameOf.patient(find.admission(p.admissionId)?.patientId)}：${note.trim()}`)
    return pView(p, t)
  })
}

/** 結束（護理師＋第二位護理師見證剩餘量銷毀）：剩餘 ml 依機器（一袋減累計用量，可修正） */
export function endPca(id: string, input: { reason: string; residualMl: number; witness?: string }): Promise<PcaView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const p = must(db.pcas.find((x) => x.id === id), 'PCA')
    if (p.status !== 'running') fail('這筆 PCA 沒有在使用中', 'CONFLICT')
    if (!PCA_END_REASONS.includes(input.reason) && !input.reason?.startsWith('其他')) failField('reason', '請選結束原因')
    const vol = find.drug(p.drugId)?.pca?.volumeMl ?? 100
    if (typeof input.residualMl !== 'number' || Number.isNaN(input.residualMl) || input.residualMl < 0 || input.residualMl > vol) failField('residualMl', `剩餘量 0–${vol} ml`)
    const w = witnessOk(input.witness, p, 'end', u.id)
    const t = now()
    Object.assign(p, { status: 'ended', end: { at: t, by: u.id, witnessBy: w.witnessId, reason: input.reason, residualMl: input.residualMl } })
    audit('PCA 結束', `${nameOf.patient(find.admission(p.admissionId)?.patientId)}：${input.reason}，剩餘 ${input.residualMl} ml 銷毀（見證 ${w.witnessName}）`)
    consumeWitness(input.witness)
    return pView(p, t)
  })
}
