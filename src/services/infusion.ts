// 點滴（護理站）：點滴醫囑（醫師開：每瓶容量、流速、加藥）→ 護理師「接上」（勾留置針通暢；病人要有周邊留置針或 CVC；扣一瓶＋加藥）
// → 依流速算預計滴完時間，快到列本班待辦 →「換瓶」（這瓶結束、接下一瓶）或「停止」；可以「調流速」（原因留紀錄、重算換瓶時間）。
// 輸入量依流速與時間算，結束時可修正為實際量；今日輸入量（nursing.ioToday）一起算。規則在 infusion-rules
import type { InfusionRun, IpdOrder } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, must, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'
import { changeState, expectedEnd, hoursPerBag, infusedMl } from './infusion-rules'
import { infusionOrders, runningRun } from './infusion-work'
import { activeLines } from './line-work'
import { wardStockOut } from './stock-ledger'
import { vasoDose, vasoRateProblem } from './vaso-rules'

export interface InfusionView {
  order: IpdOrder & { doctorName: string }
  /** 升壓劑：單位、目前流速換算的劑量（沒在滴用醫囑流速）、上限、目標 */
  vaso?: { unit: string; dose: number; max: number; target: string; weightKg: number; perMl: number }
  hoursPerBag: number
  running?: InfusionRun & { infused: number; endAt: string; state: 'ok' | 'due' | 'overdue'; startByName: string; changes: string[] }
  /** 這張醫囑之前滴過的瓶（新的在前） */
  history: { bagNo: number; startAt: string; endAt: string; reason: string; infused: number; byName: string }[]
}

const viewOf = (o: IpdOrder, t: string): InfusionView => {
  const vol = o.infusion!.volumeMl
  const r = runningRun(o.id)
  const vd = o.infusion!.vaso ? find.drug(o.drugId ?? '')?.vaso : undefined
  return {
    order: { ...o, doctorName: nameOf.doctor(o.doctorId) }, hoursPerBag: hoursPerBag(vol, o.infusion!.rateMlH),
    ...(vd && o.infusion!.vaso ? { vaso: { unit: vd.unit, dose: vasoDose(vd, r?.rateMlH ?? o.infusion!.rateMlH, o.infusion!.vaso.weightKg), max: o.infusion!.vaso.max, target: o.infusion!.vaso.target, weightKg: o.infusion!.vaso.weightKg, perMl: vd.perMl } } : {}),
    ...(r ? (() => {
      const end = expectedEnd(r, vol)
      return { running: { ...r, infused: infusedMl(r, vol, t), endAt: end, state: changeState(end, t), startByName: nameOf.user(r.startBy), changes: r.rateChanges.map((c) => `${c.at.slice(5)} ${nameOf.user(c.by)}：${c.from} → ${c.to} ml/h（${c.reason}）`) } }
    })() : {}),
    history: db.infusions.filter((x) => x.orderId === o.id && x.endAt).sort((a, b) => b.bagNo - a.bagNo).map((x) => ({ bagNo: x.bagNo, startAt: x.startAt, endAt: x.endAt!, reason: x.endReason ?? '', infused: infusedMl(x, vol, t), byName: nameOf.user(x.endBy) })),
  }
}

export interface PatientInfusions {
  admissionId: string
  items: InfusionView[]
  /** 已停止的醫囑但還在滴的（要停止） */
  orphans: InfusionView[]
  canNurse: boolean
  /** 有沒有周邊留置針或 CVC（接上要用） */
  hasIvLine: boolean
}

export function patientInfusions(admissionId: string): Promise<PatientInfusions> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'admin')
    const a = must(find.admission(admissionId), '住院紀錄')
    const t = now()
    const orphanIds = new Set(db.infusions.filter((r) => r.admissionId === a.id && !r.endAt).map((r) => r.orderId))
    return {
      admissionId: a.id, items: infusionOrders(a.id).map((o) => viewOf(o, t)),
      orphans: db.ipdOrders.filter((o) => orphanIds.has(o.id) && o.status !== 'active').map((o) => viewOf(o, t)),
      canNurse: u.role === 'nurse' && a.status === 'admitted', hasIvLine: activeLines(a.id).some((l) => l.kind === 'pivc' || l.kind === 'cvc'),
    }
  })
}

/** 結束正在滴的這瓶（換瓶、停止共用）：實際量可修正（沒填用流速算） */
function finish(r: InfusionRun, by: string, t: string, reason: string, actual?: number) {
  const vol = db.ipdOrders.find((o) => o.id === r.orderId)?.infusion?.volumeMl ?? 500
  if (actual !== undefined && actual !== null && !(Number.isInteger(actual) && actual >= 0 && actual <= vol)) failField('infusedMl', `實際輸入量 0–${vol} ml`)
  Object.assign(r, { endAt: t, endBy: by, endReason: reason, ...(actual !== undefined && actual !== null ? { infusedMl: actual } : {}) })
}

/** 接上一瓶：扣一瓶與加藥（病房常備不夠就藥局直送，異動單號帶住院號進帳單） */
function startBag(o: IpdOrder, by: string, t: string): InfusionRun {
  const a = must(find.admission(o.admissionId), '住院紀錄')
  const bagNo = db.infusions.filter((r) => r.orderId === o.id).length + 1
  const txnIds: string[] = []
  const main = wardStockOut(o, a.admitNo, by)
  if (main) txnIds.push(main.txn.id)
  for (const add of o.infusion!.additives ?? []) {
    const x = wardStockOut({ ...o, drugId: add.drugId, dose: add.dose }, a.admitNo, by)
    if (x) txnIds.push(x.txn.id)
  }
  const r: InfusionRun = { id: newId('INFU'), orderId: o.id, admissionId: o.admissionId, bagNo, startAt: t, startBy: by, rateMlH: o.infusion!.rateMlH, rateChanges: [], txnIds }
  db.infusions.push(r)
  return r
}

const activeInfusionOrder = (orderId: string) => {
  const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
  if (!o.infusion) fail('這不是點滴醫囑')
  if (o.status !== 'active') fail('醫囑已停止：不能再接新的一瓶', 'CONFLICT')
  const a = must(find.admission(o.admissionId), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return o
}

/** 接上第一瓶：要有周邊留置針或 CVC，勾確認通暢 */
export function startInfusion(orderId: string, input: { patency: boolean }): Promise<InfusionView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const o = activeInfusionOrder(orderId)
    if (runningRun(o.id)) fail('已經在滴了：要接下一瓶請按「換瓶」', 'CONFLICT')
    if (!activeLines(o.admissionId).some((l) => l.kind === 'pivc' || l.kind === 'cvc')) fail('病人沒有周邊留置針或 CVC：請先放置並在「管路」登錄', 'CONFLICT')
    if (o.infusion!.vaso && !activeLines(o.admissionId).some((l) => l.kind === 'cvc')) fail('升壓劑要接中心靜脈導管（CVC）：病人沒有 CVC', 'CONFLICT')
    if (!input.patency) failField('patency', '請確認留置針通暢（回血、沒有腫脹、推注沒有阻力）')
    const t = now()
    const r = startBag(o, u.id, t)
    audit('點滴接上', `${nameOf.patient(find.admission(o.admissionId)?.patientId)}：${o.content}（第 ${r.bagNo} 瓶）`)
    return viewOf(o, t)
  })
}

/** 換瓶：這瓶結束（實際量可修正）＋接下一瓶 */
export function changeBag(orderId: string, input: { patency: boolean; infusedMl?: number }): Promise<InfusionView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const o = activeInfusionOrder(orderId)
    const r = runningRun(o.id)
    if (!r) fail('沒有正在滴的：請按「接上」', 'CONFLICT')
    if (!input.patency) failField('patency', '請確認留置針通暢')
    const t = now()
    finish(r!, u.id, t, '換瓶', input.infusedMl)
    const n = startBag(o, u.id, t)
    // 新的一瓶沿用上一瓶最後的流速（護理師調過的，醫囑沒改）
    if (r!.rateMlH !== o.infusion!.rateMlH) n.rateMlH = r!.rateMlH
    audit('點滴換瓶', `${nameOf.patient(find.admission(o.admissionId)?.patientId)}：${o.content}（第 ${n.bagNo} 瓶）`)
    return viewOf(o, t)
  })
}

/** 停止（醫囑停了、病人不需要、管路問題）：原因必填 */
export function stopInfusion(orderId: string, input: { reason: string; infusedMl?: number }): Promise<{ ok: true }> {
  return mutate(() => {
    const u = requireUser('nurse')
    const r = must(db.infusions.find((x) => x.orderId === orderId && !x.endAt), '正在滴的點滴')
    if (!input.reason?.trim()) failField('reason', '請寫停止原因')
    finish(r, u.id, now(), input.reason.trim(), input.infusedMl)
    audit('點滴停止', `${nameOf.patient(find.admission(r.admissionId)?.patientId)}：${input.reason.trim()}`)
    return { ok: true as const }
  })
}

/** 調流速（護理師，要原因）：之後依新流速算；醫師要改醫囑流速請開新醫囑 */
export function adjustRate(orderId: string, input: { rateMlH: number; reason: string }): Promise<InfusionView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const o = activeInfusionOrder(orderId)
    const r = runningRun(o.id)
    if (!r) fail('沒有正在滴的', 'CONFLICT')
    // 升壓劑：換算的劑量要在醫囑上限內、不低於最低劑量（流速可以很慢）；一般點滴 5–500 ml/h
    const vd = o.infusion!.vaso ? find.drug(o.drugId ?? '')?.vaso : undefined
    if (vd) {
      const p = typeof input.rateMlH === 'number' ? vasoRateProblem(vd, o.infusion!.vaso!, input.rateMlH) : '請填流速'
      if (p) failField('rateMlH', p)
    } else if (!(typeof input.rateMlH === 'number' && input.rateMlH >= 5 && input.rateMlH <= 500)) failField('rateMlH', '流速 5–500 ml/小時')
    if (input.rateMlH === r!.rateMlH) failField('rateMlH', '流速沒有變')
    if (!input.reason?.trim()) failField('reason', '請寫調整原因')
    const t = now()
    r!.rateChanges.push({ at: t, by: u.id, from: r!.rateMlH, to: input.rateMlH, reason: input.reason.trim() })
    r!.rateMlH = input.rateMlH
    audit('點滴調流速', `${nameOf.patient(find.admission(o.admissionId)?.patientId)}：${r!.rateChanges.at(-1)!.from} → ${input.rateMlH} ml/h（${input.reason.trim()}）`)
    return viewOf(o, t)
  })
}
