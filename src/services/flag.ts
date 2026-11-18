// 病人重要標記：隔離（醫師、護理師開；醫師解除要原因；檢討＝確認延續）與 DNR／預立醫療決定（醫師登錄、撤回要原因）。
// 規則在 flag-rules（純函式）；排床把關在 admission.takeBed（flag-work.placementFor）；差額免收在 ipd-bill
import type { Admission, DnrDoc, DnrItem, DnrRecord, Isolation, IsolationKind } from '@/types'
import { db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { checkDnrInput, DNR_DOC_LABEL, dnrText, ISOLATION_KIND_LABEL, isolationReviewDue, isoText, normalizeOrganism, type IsolationReview } from './flag-rules'
import { activeDnr, activeIsolations, placementFor } from './flag-work'
import { find, nameOf } from './views'
import { requireCare } from './care-team'
import { ISO_BUNDLES, ISO_PPE, releaseCheck, type IsoBundleItem } from './iso-rules'
import { pendingNotifiable } from './ipc-work'

export interface IsolationView extends Isolation {
  startedByName: string
  reviewedByName?: string
  endedByName?: string
  /** 隔離了幾天（開始那天算第 1 天） */
  days: number
  /** 要檢討：前次就醫開的（這次住院要確認）、滿 14 天 */
  review?: IsolationReview
  /** 隔離中：解除條件達到了沒（依隔離後的檢驗） */
  release?: { met: boolean; text: string }
  /** 隔離中：建議醫囑（ordered＝這筆隔離已經開過） */
  bundle?: (IsoBundleItem & { ordered: boolean })[]
  /** 防護用品 */
  ppe: string[]
}
export interface DnrView extends DnrRecord {
  docLabel: string
  label: string
  title: string
  recordedByName: string
  doctorNames: string[]
  revokedByName?: string
}
export interface PatientFlagsDetail {
  patientId: string
  patientName: string
  /** 隔離中（舊的在前）與已解除（新的在前） */
  isolations: IsolationView[]
  ended: IsolationView[]
  dnr?: DnrView
  /** 以前的 DNR 文件（被取代或撤回的） */
  dnrHistory: DnrView[]
  /** 住院中：目前這張床依隔離其實不該住（隔離是住進來之後才開的）——請安排轉床 */
  placementWarning?: string
}

const currentAdmission = (patientId: string): Admission | undefined => db.admissions.find((a) => a.patientId === patientId && a.status === 'admitted')

function isoView(i: Isolation, t: string): IsolationView {
  const days = Math.max(1, Math.floor((Date.parse((i.ended?.at ?? t).replace(' ', 'T')) - Date.parse(`${i.startedAt.slice(0, 10)}T00:00`)) / 86400000) + 1)
  const review = i.ended ? undefined : isolationReviewDue(i, currentAdmission(i.patientId)?.admittedAt, t)
  const ordered = new Set(db.ipdOrders.filter((o) => o.isolationId === i.id).map((o) => o.isoKey))
  return {
    ...i, days, startedByName: nameOf.user(i.startedBy), ppe: ISO_PPE[i.kind],
    ...(i.ended ? {} : { release: releaseOf(i), bundle: ISO_BUNDLES[i.kind].map((b) => ({ ...b, ordered: ordered.has(b.key) })) }),
    ...(i.reviewedBy ? { reviewedByName: nameOf.user(i.reviewedBy) } : {}),
    ...(i.ended ? { endedByName: nameOf.user(i.ended.by) } : {}),
    ...(review ? { review } : {}),
  }
}
/** 隔離後的檢驗結果（抗酸菌塗片、快篩、培養） */
function labsSince(patientId: string, since: string) {
  const pick = (procs: string[], code: string[]) => db.labReports.filter((r) => r.patientId === patientId && procs.includes(r.procId) && r.reportedAt >= since).flatMap((r) => r.values.filter((v) => code.includes(v.code)).map((v) => ({ at: r.reportedAt, value: v.value })))
  const rapidRaw = db.labReports.filter((r) => r.patientId === patientId && ['P012', 'P058'].includes(r.procId) && r.reportedAt >= since)
  // 流感快篩 A、B 都陰性才算陰性
  const rapid = rapidRaw.map((r) => ({ at: r.reportedAt, value: r.values.every((v) => v.value === '陰性') ? '陰性' : '陽性' }))
  return { afb: pick(['P057'], ['AFB']), rapid, culture: pick(['P059'], ['CULT']) }
}
const releaseOf = (i: Isolation, symptomFree24h = false) => releaseCheck(i.kind, i.organism, { ...labsSince(i.patientId, i.startedAt), symptomFree24h })

function dnrView(d: DnrRecord): DnrView {
  return {
    ...d, docLabel: DNR_DOC_LABEL[d.doc], ...dnrText(d.withhold), recordedByName: nameOf.user(d.recordedBy),
    doctorNames: (d.doctorIds ?? []).map((x) => nameOf.doctor(x)),
    ...(d.revoked ? { revokedByName: nameOf.user(d.revoked.by) } : {}),
  }
}

/** 住院中的病人現在這張床，依隔離是不是不該住（隔離是住進來之後才開的） */
function placementWarningOf(patientId: string): string | undefined {
  const a = currentAdmission(patientId)
  const bed = a?.bedId ? find.bed(a.bedId) : undefined
  return bed ? placementFor(patientId, bed) : undefined
}

export function getPatientFlags(patientId: string): Promise<PatientFlagsDetail> {
  return query(() => {
    requireUser()
    const p = must(find.patient(patientId), '病人')
    const t = now()
    const all = db.isolations.filter((i) => i.patientId === p.id)
    const dnrs = db.dnrRecords.filter((d) => d.patientId === p.id).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    const cur = activeDnr(p.id)
    const warn = placementWarningOf(p.id)
    return {
      patientId: p.id, patientName: p.name,
      isolations: all.filter((i) => !i.ended).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map((i) => isoView(i, t)),
      ended: all.filter((i) => i.ended).sort((a, b) => b.ended!.at.localeCompare(a.ended!.at)).map((i) => isoView(i, t)),
      ...(cur ? { dnr: dnrView(cur) } : {}),
      dnrHistory: dnrs.filter((d) => d !== cur).map(dnrView),
      ...(warn ? { placementWarning: warn } : {}),
    }
  })
}

// ---------- 隔離 ----------

export interface IsolationInput {
  patientId: string
  kind: IsolationKind
  organism: string
  note?: string
}

/** 開隔離（醫師、護理師）：同類同原因不重複開。住院中開的、目前這床其實不該住，回傳時帶提醒（請安排轉床） */
export function startIsolation(input: IsolationInput): Promise<{ isolation: IsolationView; placementWarning?: string; notifiable?: { label: string; dueAt: string } }> {
  return mutate(() => {
    const u = requireUser('doctor', 'nurse')
    const p = must(find.patient(input.patientId), '病人')
    const e: Record<string, string> = {}
    if (!ISOLATION_KIND_LABEL[input.kind]) e.kind = '請選擇隔離類別'
    if (!input.organism?.trim()) e.organism = '請填原因或菌種（例：MRSA、流感、開放性肺結核）'
    failFields(e)
    const org = input.organism.trim()
    if (activeIsolations(p.id).some((i) => i.kind === input.kind && normalizeOrganism(i.organism) === normalizeOrganism(org))) {
      fail(`${p.name} 已經在${ISOLATION_KIND_LABEL[input.kind]}（${org}）中`, 'CONFLICT')
    }
    const t = now()
    const a = currentAdmission(p.id)
    const iso: Isolation = {
      id: newId('ISO'), patientId: p.id, kind: input.kind, organism: org, startedAt: t, startedBy: u.id,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}), ...(a ? { admissionId: a.id } : {}),
    }
    db.isolations.push(iso)
    audit('開始隔離', `${p.name}：${isoText([iso])}`)
    const warn = placementWarningOf(p.id)
    const nf = a ? pendingNotifiable(a).find((x) => x.basis === `隔離：${org}`) : undefined
    return { isolation: isoView(iso, t), ...(warn ? { placementWarning: warn } : {}), ...(nf ? { notifiable: { label: nf.label, dueAt: nf.dueAt } } : {}) }
  })
}

/** 檢討（醫師、護理師）：確認延續——帶菌者再住院、或滿 14 天時；重新起算 14 天 */
export function reviewIsolation(id: string, note = ''): Promise<IsolationView> {
  return mutate(() => {
    const u = requireUser('doctor', 'nurse')
    const i = must(db.isolations.find((x) => x.id === id), '隔離紀錄')
    if (i.ended) fail('這筆隔離已經解除了', 'CONFLICT')
    const t = now()
    i.reviewedAt = t
    i.reviewedBy = u.id
    if (note.trim()) i.note = [i.note, `${t.slice(5)} 檢討：${note.trim()}`].filter(Boolean).join('；')
    audit('隔離檢討（延續）', `${nameOf.patient(i.patientId)}：${isoText([i])}${note.trim() ? `；${note.trim()}` : ''}`)
    return isoView(i, t)
  })
}

/**
 * 解除隔離（只限醫師，要原因）：紀錄留著。要達到解除條件（空氣：抗酸菌連續三套陰性；飛沫：快篩陰性或症狀緩解 24 小時；
 * MRSA、CRE、VRE：培養連續兩套無菌生長）；沒達到要勾「例外解除」並寫原因
 */
export function endIsolation(id: string, reason: string, opts: { exception?: boolean; symptomFree24h?: boolean } = {}): Promise<IsolationView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const i = must(db.isolations.find((x) => x.id === id), '隔離紀錄')
    if (i.ended) fail('這筆隔離已經解除了', 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫解除原因（例：培養三套陰性、治療滿 14 天）')
    const r = releaseOf(i, !!opts.symptomFree24h)
    if (!r.met && !opts.exception) fail(`還沒達到解除條件：${r.text}（確定要解除請勾「例外解除」並寫原因）`, 'CONFLICT')
    const t = now()
    i.ended = { at: t, by: u.id, reason: reason.trim(), ...(!r.met ? { exception: true } : {}) }
    audit(!r.met ? '例外解除隔離' : '解除隔離', `${nameOf.patient(i.patientId)}：${isoText([i])}；${reason.trim()}${r.met ? `（${r.text}）` : ''}`)
    return isoView(i, t)
  })
}

/** 開隔離的建議醫囑（醫師勾選後一次開）：檢驗開臨時醫囑（抗酸菌塗片三套）、防護開長期護理醫囑；同一筆隔離同一項不重複開 */
export function orderIsolationBundle(isolationId: string, keys: string[]): Promise<IsolationView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const i = must(db.isolations.find((x) => x.id === isolationId), '隔離紀錄')
    if (i.ended) fail('這筆隔離已經解除了', 'CONFLICT')
    const a = currentAdmission(i.patientId)
    if (!a) fail('病人沒有在住院中（門診開的隔離不帶醫囑）', 'CONFLICT')
    requireCare(u.doctorId, a!, '開隔離相關醫囑', { consult: false })
    const items = ISO_BUNDLES[i.kind].filter((b) => keys.includes(b.key))
    if (!items.length) failField('keys', '請勾選要開的醫囑')
    const done = new Set(db.ipdOrders.filter((o) => o.isolationId === i.id).map((o) => o.isoKey))
    const dup = items.find((b) => done.has(b.key))
    if (dup) fail(`「${dup.label}」已經開過了`, 'CONFLICT')
    const t = now()
    for (const b of items) {
      if (b.procId) {
        const proc = must(find.procedure(b.procId), '醫令')
        for (let k = 0; k < (b.count ?? 1); k++) db.ipdOrders.push({ id: newId('IO'), admissionId: a!.id, type: 'stat', category: 'procedure', procId: proc.id, content: `${proc.name}${(b.count ?? 1) > 1 ? `（第 ${k + 1} 套）` : ''}`, startAt: t, status: 'active', doctorId: u.doctorId!, createdAt: t, isolationId: i.id, isoKey: b.key })
      } else db.ipdOrders.push({ id: newId('IO'), admissionId: a!.id, type: 'long', category: 'nursing', content: b.nursing!, startAt: t, status: 'active', doctorId: u.doctorId!, createdAt: t, isolationId: i.id, isoKey: b.key })
    }
    audit('隔離連動醫囑', `${nameOf.patient(i.patientId)}：${items.map((b) => b.label).join('、')}`)
    return isoView(i, t)
  })
}

// ---------- DNR／預立醫療決定 ----------

export interface DnrInput {
  patientId: string
  doc: DnrDoc
  signedAt: string
  signerName?: string
  relation?: string
  witnesses?: string[]
  doctorIds?: string[]
  acpDate?: string
  withhold: DnrItem[]
  nhiCard?: boolean
}

/** 登錄 DNR（只限醫師）：文件要件齊才收；已有一份有效的，新的取代舊的（舊的記「新文件取代」） */
export function saveDnr(input: DnrInput): Promise<DnrView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const p = must(find.patient(input.patientId), '病人')
    const e = checkDnrInput(input, today())
    if (input.doc === 'family' && !e.doctorIds && (input.doctorIds ?? []).some((d) => !find.doctor(d)?.active)) e.doctorIds = '確認的醫師不正確'
    failFields(e)
    const t = now()
    const old = activeDnr(p.id)
    if (old) old.revoked = { at: t, by: u.id, reason: '新文件取代' }
    const withhold = [...new Set(input.withhold)]
    const d: DnrRecord = {
      id: newId('DNR'), patientId: p.id, doc: input.doc, signedAt: input.signedAt, withhold, nhiCard: !!input.nhiCard, recordedBy: u.id, recordedAt: t,
      ...(input.doc === 'family' ? { signerName: input.signerName!.trim(), relation: input.relation!.trim(), doctorIds: input.doctorIds!.slice(0, 2) } : { witnesses: input.witnesses!.map((w) => w.trim()).filter(Boolean) }),
      ...(input.doc === 'ad' ? { acpDate: input.acpDate } : {}),
    }
    db.dnrRecords.push(d)
    audit(old ? '更新 DNR' : '登錄 DNR', `${p.name}：${DNR_DOC_LABEL[d.doc]}；${dnrText(withhold).title}`)
    return dnrView(d)
  })
}

/** 撤回 DNR（只限醫師，要原因）：紀錄留著、劃線 */
export function revokeDnr(id: string, reason: string): Promise<DnrView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const d = must(db.dnrRecords.find((x) => x.id === id), 'DNR 紀錄')
    if (d.revoked) fail('這份文件已經撤回或被取代了', 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫撤回原因（例：病人本人撤回意願）')
    d.revoked = { at: now(), by: u.id, reason: reason.trim() }
    audit('撤回 DNR', `${nameOf.patient(d.patientId)}：${reason.trim()}`)
    return dnrView(d)
  })
}

// ---------- 病房總覽 ----------

export interface WardFlagRow {
  admissionId: string
  bedNo: string
  bedClass: string
  patientName: string
  isolations: IsolationView[]
  dnr?: { label: string; title: string }
  placementWarning?: string
}

/** 這個病房隔離中或有 DNR 的住院病人（依床號） */
export function wardFlags(ward: string): Promise<WardFlagRow[]> {
  return query(() => {
    requireUser()
    const t = now()
    return db.admissions
      .filter((a) => a.status === 'admitted' && a.bedId && find.bed(a.bedId)?.ward === ward)
      .flatMap((a) => {
        const isos = activeIsolations(a.patientId)
        const d = activeDnr(a.patientId)
        if (!isos.length && !d) return []
        const bed = find.bed(a.bedId!)!
        const warn = placementFor(a.patientId, bed)
        return [{
          admissionId: a.id, bedNo: bed.bedNo, bedClass: bed.bedClass, patientName: nameOf.patient(a.patientId), isolations: isos.map((i) => isoView(i, t)),
          ...(d ? { dnr: dnrText(d.withhold) } : {}), ...(warn ? { placementWarning: warn } : {}),
        }]
      })
      .sort((x, y) => x.bedNo.localeCompare(y.bedNo))
  })
}
