// 門診加做（醫師、批價櫃台）：今天看過、批價過的門診病人，醫師補開檢驗——掛在今天已收件的同管別檢體上（時限同住院：紅頭紫頭 24 小時、尿液 2 小時），不用再抽。
// 健保的：不用補繳，檢驗科直接做；自費的（自費身分或勾自費）：產生待補收，批價櫃台收完開「補收收據」，檢驗科才能發報告。
// 補收收據 supplementOf 原本的收據，日結照算（收據號同一套）
import type { Charge, PayMethod, Specimen } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, must, mutate, query, requirePermission, requireUser } from './http'
import { find, nameOf } from './views'
import { addonCheck, TUBE_LABEL } from './specimen-rules'
import { checkCash, procPriceOn } from './billing'
import { activeChargeOf, nextReceiptNo } from './money'

const isLab = (procId: string) => !!find.procedure(procId)?.labItems?.length
const tubeOf = (procId: string) => find.procedure(procId)?.tube ?? 'red'

/** 這次門診可以補開檢驗嗎（今天、完成看診、已批價） */
function addonEncounter(encounterId: string) {
  const e = must(db.encounters.find((x) => x.id === encounterId), '病歷')
  const v = must(find.visit(e.visitId), '掛號紀錄')
  if (v.er) fail('急診的檢驗在看診中直接開（醫師存病歷就送出）', 'CONFLICT')
  if (e.status !== 'completed' || (v.status !== 'charged' && v.status !== 'dispensed')) fail('看完診、批價後才是補開；還在看診就直接加在醫令裡', 'CONFLICT')
  if (e.date !== now().slice(0, 10)) fail('只能補開今天的門診（檢體有時限）', 'CONFLICT')
  return { e, v }
}
/** 這位病人今天門診最新一支同管別、已收件、沒退件的檢體 */
const opdSpecimenToday = (patientId: string, tube: string, day: string): Specimen | undefined =>
  db.specimens.filter((s) => !s.admissionId && !s.er && !s.partOf && s.patientId === patientId && s.tube === tube && s.receivedAt && !s.rejected && s.createdAt.startsWith(day))
    .sort((a, b) => (a.collectedAt ?? '').localeCompare(b.collectedAt ?? '')).at(-1)

export interface OpdAddonOption {
  procId: string
  procName: string
  tubeLabel: string
  ok: boolean
  reason?: string
  specimen?: { barcode: string; collectedAt: string; until: string; tests: string[] }
  /** 自費價格（自費身分或勾自費時要補繳的） */
  selfPrice: number
  /** 病人是自費身分（一定要補繳） */
  selfPayVisit: boolean
}

/** 補開前查：有沒有能掛的檢體、自費多少 */
export function opdAddonOption(encounterId: string, procId: string): Promise<OpdAddonOption> {
  return query(() => {
    requireUser('doctor')
    const { e, v } = addonEncounter(encounterId)
    const proc = must(find.procedure(procId), '醫令')
    if (!isLab(procId)) fail('只有檢驗能補開加做', 'BAD_REQUEST')
    const tube = tubeOf(procId)
    const sp = opdSpecimenToday(e.patientId, tube, e.date)
    const chk = addonCheck(sp, tube, now())
    const base = { procId, procName: proc.name, tubeLabel: TUBE_LABEL[tube], selfPrice: procPriceOn(proc, e.date).selfPrice, selfPayVisit: !!find.identity(v.identityCode)?.selfPay }
    if (e.procedures.some((p) => p.procId === procId)) return { ...base, ok: false, reason: '這次門診已經開過這項了' }
    if (!chk.ok) return { ...base, ok: false, reason: chk.reason }
    return { ...base, ok: true, specimen: { barcode: sp!.barcode, collectedAt: sp!.collectedAt!, until: chk.until, tests: (sp!.opdKeys ?? []).map((k) => find.procedure(k.split(':')[2])?.name ?? k) } }
  })
}

/** 補開（看診醫師）：掛在今天的檢體上；自費的產生待補收 */
export function addOpdLab(encounterId: string, procId: string, opts: { selfPay?: boolean } = {}): Promise<{ procName: string; barcode: string; due: number }> {
  return mutate(() => {
    const u = requirePermission('order.write')
    const { e, v } = addonEncounter(encounterId)
    if (u.doctorId !== e.doctorId) fail('只有這次看診的醫師能補開', 'FORBIDDEN')
    const proc = must(find.procedure(procId), '醫令')
    if (!isLab(procId)) fail('只有檢驗能補開加做', 'BAD_REQUEST')
    if (e.procedures.some((p) => p.procId === procId)) fail('這次門診已經開過這項了', 'CONFLICT')
    const tube = tubeOf(procId)
    const sp = opdSpecimenToday(e.patientId, tube, e.date)
    const t = now()
    const chk = addonCheck(sp, tube, t)
    if (!chk.ok) fail(`${chk.reason}：請另外看診開立、重新採檢`, 'CONFLICT')
    const selfPay = !!opts.selfPay || !!find.identity(v.identityCode)?.selfPay
    const price = procPriceOn(proc, e.date)
    const amount = selfPay || price.points === 0 ? price.selfPrice : 0
    e.procedures.push({ procId, qty: 1, selfPay: selfPay || price.points === 0, addon: { specimenId: sp!.id, at: t, by: u.id, selfPay: amount > 0, amount } })
    // 健保給付的加做：病人不用付，但要開一張 0 元補收收據帶健保點數，申報才會算到（申報只看收據）
    if (!amount) {
      const main = activeChargeOf(v.id)
      const c: Charge = {
        id: newId('C'), visitId: v.id, patientId: e.patientId, ...(main ? { supplementOf: main.id } : {}),
        lines: [{ kind: 'procedure', name: `${proc.name}（加做）`, qty: 1, unitPrice: price.points, amount: price.points, patientPay: false }],
        nhiPoints: price.points, patientTotal: 0, payMethod: 'cash', received: 0, change: 0,
        receiptNo: nextReceiptNo(t.slice(0, 10)), cashierId: u.id, paidAt: t, voided: false,
      }
      db.charges.push(c)
      e.procedures.at(-1)!.addon!.chargeId = c.id
    }
    ;(sp!.opdKeys ??= []).push(`E:${e.id}:${procId}`)
    audit('門診加做', `${nameOf.patient(e.patientId)} ${proc.name}（加做：條碼 ${sp!.barcode}${amount ? `；自費 ${amount} 元待補繳` : '；健保不用補繳'}）`)
    return { procName: proc.name, barcode: sp!.barcode, due: amount }
  })
}

export interface AddonDue {
  encounterId: string
  visitId: string
  patientId: string
  patientName: string
  chartNo: string
  procId: string
  procName: string
  amount: number
  at: string
  doctorName: string
}
/** 批價櫃台：門診加做待補收（自費、還沒繳的） */
export function listAddonDue(): Promise<AddonDue[]> {
  return query(() => {
    requireUser('clerk', 'admin')
    const out: AddonDue[] = []
    for (const e of db.encounters) for (const p of e.procedures) {
      if (!p.addon?.selfPay || p.addon.chargeId) continue
      const pt = find.patient(e.patientId)
      out.push({ encounterId: e.id, visitId: e.visitId, patientId: e.patientId, patientName: pt?.name ?? '', chartNo: pt?.chartNo ?? '', procId: p.procId, procName: find.procedure(p.procId)?.name ?? p.procId, amount: p.addon.amount, at: p.addon.at, doctorName: nameOf.doctor(e.doctorId) })
    }
    return out.sort((a, b) => a.at.localeCompare(b.at))
  })
}

/** 補收（批價櫃台）：開補收收據（supplementOf 原本的收據），檢驗科就能發報告 */
export function payAddon(encounterId: string, procId: string, input: { payMethod: PayMethod; received?: number }): Promise<Charge> {
  return mutate(() => {
    const cashier = requirePermission('charge.pay')
    const e = must(db.encounters.find((x) => x.id === encounterId), '病歷')
    const p = e.procedures.find((x) => x.procId === procId && x.addon)
    if (!p?.addon) fail('找不到這筆門診加做', 'NOT_FOUND')
    if (!p!.addon!.selfPay) fail('健保給付的加做不用補繳', 'CONFLICT')
    if (p!.addon!.chargeId) fail('已經補繳過了', 'CONFLICT')
    const due = p!.addon!.amount
    const received = input.payMethod === 'cash' ? Number(input.received) : due
    if (input.payMethod === 'cash') {
      const problem = checkCash(due, received, false)
      if (problem) failField('received', problem)
    }
    const v = must(find.visit(e.visitId), '掛號紀錄')
    const main = activeChargeOf(v.id)
    const proc = must(find.procedure(procId), '醫令')
    const c: Charge = {
      id: newId('C'), visitId: v.id, patientId: e.patientId, ...(main ? { supplementOf: main.id } : {}),
      lines: [{ kind: 'self', name: `${proc.name}（加做，自費）`, qty: 1, unitPrice: due, amount: due, patientPay: true }],
      nhiPoints: 0, patientTotal: due, payMethod: input.payMethod, received, change: received - due,
      receiptNo: nextReceiptNo(now().slice(0, 10)), cashierId: cashier.id, paidAt: now(), voided: false,
    }
    db.charges.push(c)
    p!.addon!.chargeId = c.id
    audit('門診加做補收', `${c.receiptNo} ${nameOf.patient(e.patientId)} ${proc.name} ${due} 元${main ? `（補 ${main.receiptNo}）` : ''}`)
    return c
  })
}
