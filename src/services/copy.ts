// 病歷影本申請：櫃台核對申請人（本人或代理人）、選範圍（門診病歷、出院病摘、檢驗、影像報告）→ 當場收費（開收據、進日結）
// → 列印（每頁標「影本」與申請單號；補印也記下）。當天可作廢（收據一起作廢）。規則在 copy-rules（純函式）
import type { Charge, ChargeLine, CopyItemKind, PayMethod, RecordCopyRequest, VitalSigns } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requirePermission } from './http'
import { checkCash, procPriceOn } from './billing'
import { nextReceiptNo } from './money'
import { checkCopyApplicant, COPY_KIND_LABEL, COPY_MAX_ITEMS, copyFee, copyPagesOf, type CopyApplicantInput } from './copy-rules'
import { find, nameOf } from './views'

const feeProc = (k: 'base' | 'page') => db.procedures.find((p) => p.recordCopy === k && p.active)

/** 今天的單價（主檔「病歷影本基本費」「病歷影本（每頁）」的自費價，依生效日） */
function feeToday(date = today()): { base: number; perPage: number } {
  const b = feeProc('base')
  const pg = feeProc('page')
  return { base: b ? procPriceOn(b, date).selfPrice : 0, perPage: pg ? procPriceOn(pg, date).selfPrice : 0 }
}

export interface CopySource {
  kind: CopyItemKind
  kindLabel: string
  refId: string
  date: string
  label: string
  pages: number
}

/** 這位病人可以申請影本的紀錄：完成的門診、醫師已簽的出院病摘、發出的檢驗與影像報告（新的在前） */
function sourcesOf(patientId: string): CopySource[] {
  const out: CopySource[] = []
  const put = (kind: CopyItemKind, refId: string, date: string, label: string) => out.push({ kind, kindLabel: COPY_KIND_LABEL[kind], refId, date, label, pages: copyPagesOf(kind) })
  for (const e of db.encounters.filter((x) => x.patientId === patientId && x.status === 'completed'))
    put('opd', e.id, e.date, `${nameOf.dept(e.deptId)} ${nameOf.doctor(e.doctorId)}・${e.diagnoses.find((d) => d.primary)?.name ?? e.diagnoses[0]?.name ?? '—'}`)
  for (const a of db.admissions.filter((x) => x.patientId === patientId && x.dischargeSummary?.signedAt))
    put('discharge', a.id, (a.dischargedAt ?? a.dischargeSummary!.signedAt!).slice(0, 10), `${nameOf.dept(a.deptId)} 住院 ${(a.admittedAt ?? '').slice(0, 10)}～${a.dischargedAt?.slice(0, 10) ?? '（准出院）'}・${a.dischargeSummary!.diagnosis}`)
  for (const r of db.labReports.filter((x) => x.patientId === patientId))
    put('lab', r.id, r.reportedAt.slice(0, 10), `${find.procedure(r.procId)?.name ?? r.procId}（${r.no}）`)
  for (const r of db.imagingReports.filter((x) => x.patientId === patientId))
    put('imaging', r.id, r.reportedAt.slice(0, 10), `${find.procedure(r.procId)?.name ?? r.procId}（${r.no}）`)
  return out.sort((x, y) => y.date.localeCompare(x.date) || x.kind.localeCompare(y.kind))
}

export interface CopySources {
  patientId: string
  patientName: string
  chartNo: string
  sources: CopySource[]
  fee: { base: number; perPage: number }
}

export function copySources(patientId: string): Promise<CopySources> {
  return query(() => {
    requirePermission('record.copy')
    const p = must(find.patient(patientId), '病人')
    return { patientId: p.id, patientName: p.name, chartNo: p.chartNo, sources: sourcesOf(p.id), fee: feeToday() }
  })
}

export interface RecordCopyView extends Omit<RecordCopyRequest, 'applicant'> {
  applicant: RecordCopyRequest['applicant']
  /** 「本人」「代理人 王大明（配偶）」 */
  applicantText: string
  receiptNo: string
  amount: number
  payMethod: PayMethod
  createdByName: string
  /** 可以作廢（當天、還沒作廢）；不能的原因 */
  canVoid: boolean
  voidedByName?: string
}

function view(r: RecordCopyRequest): RecordCopyView {
  const c = db.charges.find((x) => x.id === r.chargeId)
  return {
    ...r,
    applicantText: r.applicant.kind === 'self' ? `本人 ${r.applicant.name}` : `代理人 ${r.applicant.name}（${r.applicant.relation}）`,
    receiptNo: c?.receiptNo ?? '', amount: c?.patientTotal ?? 0, payMethod: c?.payMethod ?? 'cash', createdByName: nameOf.user(r.createdBy),
    canVoid: !r.voided && r.createdAt.slice(0, 10) === today(),
    ...(r.voided ? { voidedByName: nameOf.user(r.voided.by) } : {}),
  }
}

export function listRecordCopies(patientId: string): Promise<RecordCopyView[]> {
  return query(() => {
    requirePermission('record.copy')
    return db.recordCopies.filter((r) => r.patientId === patientId).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map(view)
  })
}

export interface RecordCopyInput {
  patientId: string
  applicant: CopyApplicantInput
  purpose: string
  items: { kind: CopyItemKind; refId: string }[]
  payMethod: PayMethod
  /** 現金實收 */
  received?: number
}

/** 受理並收費：申請人核對、項目要是這位病人的、收據（自費：基本費＋每頁）算在今天 */
export function createRecordCopy(input: RecordCopyInput): Promise<RecordCopyView & { change: number }> {
  return mutate(() => {
    const u = requirePermission('record.copy')
    const p = must(find.patient(input.patientId), '病人')
    const e = checkCopyApplicant(input.applicant ?? {}, p)
    if (!input.purpose?.trim()) e.purpose = '請選擇用途'
    const all = sourcesOf(p.id)
    const keys = [...new Set((input.items ?? []).map((x) => `${x.kind}|${x.refId}`))]
    const picked = keys.map((k) => all.find((s) => `${s.kind}|${s.refId}` === k))
    if (!keys.length) e.items = '請選擇要影印的紀錄'
    else if (picked.some((x) => !x)) e.items = '選的紀錄不是這位病人的（或還沒完成）'
    else if (keys.length > COPY_MAX_ITEMS) e.items = `一次最多 ${COPY_MAX_ITEMS} 項，請分次申請`
    if (!['cash', 'card', 'mobile'].includes(input.payMethod)) e.payMethod = '請選擇付款方式'
    failFields(e)
    const items = picked.map((s) => ({ kind: s!.kind, refId: s!.refId, label: `${s!.date} ${s!.kindLabel}：${s!.label}`, pages: s!.pages }))
    const pages = items.reduce((n, x) => n + x.pages, 0)
    const t = now()
    const d = t.slice(0, 10)
    const fee = feeToday(d)
    const amount = copyFee(fee.base, fee.perPage, pages)
    const received = input.payMethod === 'cash' ? Number(input.received) : amount
    if (input.payMethod === 'cash') {
      const problem = checkCash(amount, received)
      if (problem) failField('received', problem)
    }
    const lines: ChargeLine[] = [
      { kind: 'self' as const, name: feeProc('base')?.name ?? '病歷影本基本費', qty: 1, unitPrice: fee.base, amount: fee.base, patientPay: true },
      { kind: 'self' as const, name: feeProc('page')?.name ?? '病歷影本（每頁）', qty: pages, unitPrice: fee.perPage, amount: fee.perPage * pages, patientPay: true },
    ].filter((l) => l.amount > 0)
    const id = newId('MRC')
    const charge: Charge = {
      id: newId('C'), visitId: '', copyRequestId: id, patientId: p.id, lines, nhiPoints: 0, patientTotal: amount,
      payMethod: input.payMethod, received, change: received - amount, receiptNo: nextReceiptNo(d), cashierId: u.id, paidAt: t, voided: false,
    }
    db.charges.push(charge)
    const a = input.applicant
    const r: RecordCopyRequest = {
      id, no: `MR${d.replace(/-/g, '')}${String(nextCounter(`copy:${d}`)).padStart(3, '0')}`, patientId: p.id,
      applicant: a.kind === 'self'
        ? { kind: 'self', name: a.name!.trim(), idNo: a.idNo!.trim().toUpperCase() }
        : { kind: 'agent', name: a.name!.trim(), idNo: a.idNo!.trim().toUpperCase(), relation: a.relation!.trim(), authorizationChecked: true },
      purpose: input.purpose.trim(), items, pages, chargeId: charge.id, createdAt: t, createdBy: u.id, printed: [],
    }
    db.recordCopies.push(r)
    audit('病歷影本申請', `${r.no} ${p.name}（${p.chartNo}）：${view(r).applicantText}、${r.purpose}、${items.length} 項 ${pages} 頁；收據 ${charge.receiptNo} ${amount} 元`)
    return { ...view(r), change: charge.change }
  })
}

/** 作廢：只限當天（收據一起作廢、算不進日結）；隔天以後影本已交付，不能作廢 */
export function voidRecordCopy(id: string, reason: string): Promise<RecordCopyView> {
  return mutate(() => {
    const u = requirePermission('record.copy')
    const r = must(db.recordCopies.find((x) => x.id === id), '病歷影本申請')
    if (r.voided) fail('已經作廢了', 'CONFLICT')
    if (r.createdAt.slice(0, 10) !== today()) fail(`這張是 ${r.createdAt.slice(0, 10)} 申請的，已算進那天的日結、影本也交付了，不能作廢`, 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫作廢原因')
    const c = must(db.charges.find((x) => x.id === r.chargeId), '收據')
    c.voided = true
    r.voided = { at: now(), by: u.id, reason: reason.trim() }
    audit('作廢病歷影本申請', `${r.no} ${nameOf.patient(r.patientId)}（收據 ${c.receiptNo} 一併作廢）：${reason.trim()}`)
    return view(r)
  })
}

// ---------- 列印 ----------

export interface CopyPage {
  kind: CopyItemKind
  title: string
  /** 日期、科別、醫師、單號… */
  meta: string
  sections: { heading: string; text: string }[]
  table?: { head: string[]; rows: string[][] }
}

export interface CopyPrint {
  no: string
  patient: { name: string; chartNo: string; gender: string; birthDate: string }
  applicantText: string
  purpose: string
  printedAt: string
  /** 第幾次列印（1＝第一次） */
  times: number
  pages: CopyPage[]
}

function pageOf(kind: CopyItemKind, refId: string): CopyPage {
  if (kind === 'opd') {
    const e = must(db.encounters.find((x) => x.id === refId), '門診病歷')
    const meds = e.medications.map((m) => {
      const d = find.drug(m.drugId)
      return [d?.name ?? m.drugId, `${m.dose} ${d?.unit ?? ''}`, find.freq(m.freq)?.label ?? m.freq, m.route, `${m.days} 天`, `${m.qty}`]
    })
    return {
      kind, title: '門診病歷', meta: `${e.date}・${nameOf.dept(e.deptId)}・醫師 ${nameOf.doctor(e.doctorId)}`,
      sections: [
        { heading: '診斷', text: e.diagnoses.map((x) => `${x.icd} ${x.name}${x.primary ? '（主）' : ''}`).join('\n') || '—' },
        { heading: 'S 主訴', text: e.subjective || '—' },
        { heading: 'O 理學檢查', text: [e.objective, vitalsText(e.vitals)].filter(Boolean).join('\n') || '—' },
        { heading: 'A 評估', text: e.assessment || '—' },
        { heading: 'P 計畫', text: e.plan || '—' },
        ...(e.procedures.length ? [{ heading: '檢驗、處置', text: e.procedures.map((x) => `${find.procedure(x.procId)?.name ?? x.procId} × ${x.qty}`).join('\n') }] : []),
      ],
      ...(meds.length ? { table: { head: ['藥品', '每次', '頻率', '途徑', '天數', '總量'], rows: meds } } : {}),
    }
  }
  if (kind === 'discharge') {
    const a = must(find.admission(refId), '住院紀錄')
    const s = must(a.dischargeSummary, '出院病摘')
    return {
      kind, title: '出院病歷摘要', meta: `住院號 ${a.admitNo}・${nameOf.dept(a.deptId)}・入院 ${(a.admittedAt ?? '').slice(0, 10)}・出院 ${a.dischargedAt?.slice(0, 10) ?? '—'}・醫師 ${nameOf.doctor(s.doctorId)}`,
      sections: [
        { heading: '入院診斷', text: a.diagnosis },
        { heading: '出院診斷', text: s.diagnosis },
        { heading: '住院經過', text: s.course || '—' },
        { heading: '出院時狀況', text: s.condition || '—' },
        { heading: '出院後追蹤', text: s.followUp || '—' },
        { heading: '出院轉歸', text: s.dischargeType },
      ],
      ...(s.meds?.length ? { table: { head: ['出院帶藥', '每次', '頻率', '天數', '總量'], rows: s.meds.map((m) => [find.drug(m.drugId)?.name ?? m.drugId, `${m.dose}`, find.freq(m.freq)?.label ?? m.freq, `${m.days} 天`, `${m.qty}`]) } } : {}),
    }
  }
  if (kind === 'lab') {
    const r = must(db.labReports.find((x) => x.id === refId), '檢驗報告')
    return {
      kind, title: `檢驗報告：${find.procedure(r.procId)?.name ?? r.procId}`, meta: `報告單號 ${r.no}・開立醫師 ${nameOf.doctor(r.doctorId)}・報告 ${r.reportedAt}・醫檢師 ${nameOf.user(r.reportedBy)}`,
      sections: r.corrections?.length ? [{ heading: '更正紀錄', text: r.corrections.map((c) => `${c.at} ${c.reason}`).join('\n') }] : [],
      table: { head: ['項目', '結果', '單位', '參考範圍', '判讀'], rows: r.values.map((v) => [v.name, v.value, v.unit ?? '', v.ref, v.critical ? '危急' : v.flag === 'H' ? '偏高' : v.flag === 'L' ? '偏低' : v.flag ? '異常' : '']) },
    }
  }
  const r = must(db.imagingReports.find((x) => x.id === refId), '影像報告')
  return {
    kind, title: `影像報告：${find.procedure(r.procId)?.name ?? r.procId}`, meta: `報告單號 ${r.no}・開立醫師 ${nameOf.doctor(r.doctorId)}・判讀 ${nameOf.doctor(r.readerId)} ${r.reportedAt}`,
    sections: [
      { heading: '所見', text: r.findings },
      { heading: '結論', text: r.impression },
      ...(r.addenda ?? []).map((x) => ({ heading: `補充報告（${x.at}）`, text: x.text })),
    ],
  }
}

const VITAL_LABEL: [keyof VitalSigns, string, string][] = [['height', '身高', 'cm'], ['weight', '體重', 'kg'], ['temp', '體溫', '°C'], ['pulse', '脈搏', '次/分'], ['resp', '呼吸', '次/分'], ['spo2', '血氧', '%']]
function vitalsText(v: VitalSigns | undefined): string {
  if (!v) return ''
  const parts = VITAL_LABEL.filter(([k]) => v[k] !== undefined && v[k] !== null).map(([k, l, u]) => `${l} ${v[k]} ${u}`)
  if (v.sbp && v.dbp) parts.push(`血壓 ${v.sbp}/${v.dbp} mmHg`)
  return parts.length ? `生命徵象：${parts.join('、')}` : ''
}

/** 列印（第一次或補印）：作廢的不能印；每次都記下、寫稽核 */
export function printRecordCopy(id: string): Promise<CopyPrint> {
  return mutate(() => {
    const u = requirePermission('record.copy')
    const r = must(db.recordCopies.find((x) => x.id === id), '病歷影本申請')
    if (r.voided) fail('這張申請已作廢，不能列印', 'CONFLICT')
    const p = must(find.patient(r.patientId), '病人')
    const t = now()
    r.printed.push({ at: t, by: u.id })
    audit('列印病歷影本', `${r.no} ${p.name}：${r.pages} 頁${r.printed.length > 1 ? `（補印，第 ${r.printed.length} 次）` : ''}`)
    return {
      no: r.no, patient: { name: p.name, chartNo: p.chartNo, gender: p.gender === 'M' ? '男' : '女', birthDate: p.birthDate },
      applicantText: view(r).applicantText, purpose: r.purpose, printedAt: t, times: r.printed.length,
      pages: r.items.map((x) => pageOf(x.kind, x.refId)),
    }
  })
}
