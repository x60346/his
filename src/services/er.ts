// 急診：護理師檢傷（主訴＋生命徵象 → 建議級數；可調升、要原因；不能比建議輕）並掛急診 → 醫師在「門診看診」的急診診次看（依檢傷級數排）
// → 完成看診後決定去向：離院（批價、領藥照門診流程）、收住院（建住院預約，住院中心報到；沒床在看板標待床）、轉院。
// 費用：急診診察費、急診部分負擔依檢傷級數、觀察床費依時數（billing.calcChargeLines）。規則在 er-rules
import type { Admission, TriageLevel, TriageVitals, Visit } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { checkTriageInput, ER_DISPOSITION_LABEL, suggestLevel, TRIAGE_LABEL } from './er-rules'
import { erItem, erSessionFor, erVisits, isErDoctor, type ErBoardItem } from './er-work'
import { admissionView, find, nameOf, visitView, type AdmissionView, type VisitView } from './views'
import { admitInto, bedStatusLabel, closeOrders, isObsBed, obsOpen, releaseBed, takeBed } from './bed-work'
import { transfusionOpen } from './blood-work'
import { surgeryOpen } from './surgery-work'
import { closeLines } from './line-work'
import { closeRestraints } from './delirium-work'
import { openPca } from './pca-work'

export interface ObsBedView {
  id: string
  bedNo: string
  status: string
  statusLabel: string
  patientName?: string
  admissionId?: string
}

export interface ErBoard {
  items: ErBoardItem[]
  /** 急診留觀區的床（OB1–OB6） */
  obsBeds: ObsBedView[]
  /** 目前的人：可以檢傷掛號（護理師）、可以決定去向（急診醫師） */
  canTriage: boolean
  canDispose: boolean
}

const STAGE_ORDER: Record<string, number> = { waiting: 0, seeing: 1, deciding: 2, 'obs-bed': 3, obs: 4, bed: 5, billing: 6, admitted: 7, left: 8 }

const obsBedsView = (): ObsBedView[] => db.beds.filter(isObsBed).map((b) => {
  const a = b.admissionId ? find.admission(b.admissionId) : undefined
  return { id: b.id, bedNo: b.bedNo, status: b.status, statusLabel: bedStatusLabel[b.status], ...(a ? { patientName: nameOf.patient(a.patientId), admissionId: a.id } : {}) }
})

/** 急診看板：待看診依級數、再依檢傷時間；其他依階段 */
export function erBoard(): Promise<ErBoard> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'clerk', 'admin')
    const t = now()
    const items = erVisits(t).map((v) => erItem(v, t))
      .sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || (a.stage === 'waiting' ? a.level - b.level || a.triagedAt.localeCompare(b.triagedAt) : b.arrivedAt.localeCompare(a.arrivedAt)))
    return { items, obsBeds: obsBedsView(), canTriage: u.role === 'nurse', canDispose: u.role === 'doctor' && isErDoctor(u.doctorId) }
  })
}

export interface TriageInput {
  patientId: string
  complaint: string
  vitals: TriageVitals
  level: TriageLevel
  /** 比建議嚴重（調升）的原因 */
  reason?: string
  identityCode?: string
}

/** 檢傷並掛急診（護理師）：同一位病人已在急診（還沒結束）或正在住院中不能再掛；到院時間＝現在，直接報到 */
export function triageAndRegister(input: TriageInput): Promise<VisitView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const p = must(find.patient(input.patientId), '病人')
    const e = checkTriageInput({ complaint: input.complaint, vitals: input.vitals, level: input.level, reason: input.reason })
    failFields(e)
    const t = now()
    if (erVisits(t).some((v) => v.patientId === p.id && ['registered', 'in-consult'].includes(v.status))) fail(`${p.name} 已經在急診候診或看診中`, 'CONFLICT')
    if (db.admissions.some((a) => a.patientId === p.id && a.status === 'admitted')) fail(`${p.name} 正在住院中`, 'CONFLICT')
    const identityCode = input.identityCode && find.identity(input.identityCode) ? input.identityCode : p.defaultIdentity
    const s = erSessionFor(t.slice(0, 10))
    const sug = suggestLevel(input.complaint, input.vitals)
    const vitals: TriageVitals = Object.fromEntries(Object.entries(input.vitals ?? {}).filter(([, x]) => x !== undefined && x !== null && !Number.isNaN(x)).map(([k, x]) => [k, Number(x)]))
    const v: Visit = {
      id: newId('V'), date: s.date, sessionId: s.id, deptId: s.deptId, doctorId: s.doctorId, patientId: p.id,
      seqNo: nextCounter(`seq:${s.id}`), identityCode, caseType: 'E1',
      cardSeq: String(nextCounter(`cardseq:${p.id}`)).padStart(4, '0'), status: 'registered',
      firstVisit: !db.visits.some((x) => x.patientId === p.id && x.status !== 'cancelled'), preventItems: [], createdAt: t, checkedInAt: t,
      er: {
        arrivedAt: t, complaint: input.complaint.trim(), vitals, suggested: sug.level, level: input.level,
        ...(input.level < sug.level ? { reason: input.reason!.trim() } : {}), triagedBy: u.id, triagedAt: t,
      },
    }
    db.visits.push(v)
    audit('急診檢傷掛號', `${p.chartNo} ${p.name}：${input.complaint.trim()}，檢傷 ${input.level} 級（${TRIAGE_LABEL[input.level]}）${input.level < sug.level ? `，由建議 ${sug.level} 級調升：${input.reason!.trim()}` : ''}`)
    return visitView(v)
  })
}

/** 重新檢傷（候診中病情變化）：可以調升或調降（都要原因）；舊的級數留在紀錄裡 */
export function retriage(visitId: string, input: { level: TriageLevel; reason: string }): Promise<ErBoardItem> {
  return mutate(() => {
    const u = requireUser('nurse')
    const v = must(find.visit(visitId), '急診就醫')
    if (!v.er) fail('這不是急診就醫')
    if (v.status !== 'registered') fail('醫師已經看了，不能再重新檢傷', 'CONFLICT')
    if (![1, 2, 3, 4, 5].includes(input.level)) failField('level', '請選檢傷級數')
    if (input.level === v.er!.level) failField('level', '級數沒有變')
    if (!input.reason?.trim()) failField('reason', '請寫重新檢傷的原因（例：候診中血壓下降到 85/50）')
    const t = now()
    ;(v.er!.history ??= []).push({ level: v.er!.level, at: v.er!.triagedAt, by: v.er!.triagedBy, reason: v.er!.reason ?? '首次檢傷' })
    Object.assign(v.er!, { level: input.level, reason: input.reason.trim(), triagedBy: u.id, triagedAt: t })
    audit('急診重新檢傷', `${nameOf.patient(v.patientId)}：${v.er!.history!.at(-1)!.level} → ${input.level} 級，${input.reason.trim()}`)
    return erItem(v, t)
  })
}

export interface DispositionInput {
  kind: 'home' | 'admit' | 'transfer' | 'obs'
  note?: string
  hospital?: string
  /** 收住院：科別、主治、入院診斷 */
  deptId?: string
  doctorId?: string
  diagnosis?: string
}

/**
 * 決定去向（急診醫師）：看完診（完成病歷）後。收住院＝建住院預約（今天、標來自急診），住院中心有床就報到；
 * 已經住院預約或住院中的不能重複。去向只能決定一次（要改請取消住院預約後由櫃台處理）
 */
export function setDisposition(visitId: string, input: DispositionInput): Promise<ErBoardItem> {
  return mutate(() => {
    const u = requireUser('doctor')
    if (!isErDoctor(u.doctorId)) fail('急診去向由急診醫師決定', 'FORBIDDEN')
    const v = must(find.visit(visitId), '急診就醫')
    if (!v.er) fail('這不是急診就醫')
    if (v.er.disposition) fail(`已經決定去向（${ER_DISPOSITION_LABEL[v.er.disposition.kind]}）`, 'CONFLICT')
    if (v.status === 'registered' || v.status === 'in-consult') fail('請先完成看診（病歷、處方），再決定去向', 'CONFLICT')
    const t = now()
    const note = input.note?.trim()
    if (input.kind === 'transfer') {
      if (!input.hospital?.trim()) failField('hospital', '請寫轉到哪一家醫院')
      if (!note) failField('note', '請寫轉院原因（例：需心導管，本院無設備）')
      v.er.disposition = { kind: 'transfer', at: t, by: u.id, hospital: input.hospital!.trim(), note }
    } else if (input.kind === 'admit') {
      const { dept, doc } = checkAdmitTarget(input)
      if (db.admissions.some((a) => a.patientId === v.patientId && (a.status === 'reserved' || a.status === 'admitted'))) fail(`${nameOf.patient(v.patientId)} 已有住院預約或正在住院中`, 'CONFLICT')
      const a = { id: newId('A'), admitNo: '', patientId: v.patientId, fromVisitId: v.id, deptId: dept.id, doctorId: doc.id, preferBedClass: '健保床' as const, reason: `急診收住院${note ? `：${note}` : ''}`, diagnosis: input.diagnosis!.trim(), status: 'reserved' as const, reservedAt: t, expectedDate: t.slice(0, 10) }
      db.admissions.push(a)
      v.er.disposition = { kind: 'admit', at: t, by: u.id, admissionId: a.id, ...(note ? { note } : {}) }
      mergedDispense(v, t)
    } else if (input.kind === 'obs') {
      // 留觀＝特別的住院：急診科、這位急診醫師負責，掛在急診留觀區；護理師排床後才開始（住院號、腕帶），住院醫囑、給藥、護理紀錄都沿用
      if (db.admissions.some((a) => a.patientId === v.patientId && (a.status === 'reserved' || a.status === 'admitted'))) fail(`${nameOf.patient(v.patientId)} 已有住院預約或正在住院中`, 'CONFLICT')
      const e = find.encounterOfVisit(v.id)
      const dx = input.diagnosis?.trim() || e?.diagnoses.find((x) => x.primary)?.name || e?.diagnoses[0]?.name || v.er.complaint
      const a: Admission = { id: newId('A'), admitNo: '', patientId: v.patientId, fromVisitId: v.id, deptId: v.deptId, doctorId: u.doctorId!, preferBedClass: '健保床', reason: `急診留觀${note ? `：${note}` : ''}`, diagnosis: dx, status: 'reserved', reservedAt: t, expectedDate: t.slice(0, 10), obs: { visitId: v.id } }
      db.admissions.push(a)
      v.er.disposition = { kind: 'obs', at: t, by: u.id, admissionId: a.id, ...(note ? { note } : {}) }
    } else if (input.kind === 'home') {
      v.er.disposition = { kind: 'home', at: t, by: u.id, ...(note ? { note } : {}) }
    } else fail('請選擇去向')
    audit('急診去向', `${nameOf.patient(v.patientId)}：${ER_DISPOSITION_LABEL[input.kind as keyof typeof ER_DISPOSITION_LABEL]}${input.kind === 'admit' ? ` ${nameOf.dept(input.deptId)} ${nameOf.doctor(input.doctorId)}，${input.diagnosis}` : input.kind === 'transfer' ? ` ${input.hospital}` : ''}${note ? `；${note}` : ''}`)
    return erItem(v, t)
  })
}

export type { ErBoardItem }

/** 收住院的科別、主治、入院診斷（直接收住院、留觀後收住院共用；欄位一次標出） */
function checkAdmitTarget(input: Pick<DispositionInput, 'deptId' | 'doctorId' | 'diagnosis'>) {
  const f: Record<string, string> = {}
  const dept = input.deptId ? db.departments.find((d) => d.id === input.deptId && d.active) : undefined
  const doc = input.doctorId ? db.doctors.find((d) => d.id === input.doctorId && d.active) : undefined
  if (!dept) f.deptId = '請選住院科別'
  else if (['ER', 'RAD', 'INF'].includes(dept.code)) f.deptId = `${dept.name}不收住院`
  if (!doc) f.doctorId = '請選主治醫師'
  else if (dept && doc.deptId !== dept.id) f.doctorId = `${doc.name} 不是${dept.name}的醫師`
  if (!input.diagnosis?.trim()) f.diagnosis = '請寫入院診斷'
  failFields(f)
  return { dept: dept!, doc: doc! }
}

/** 急診收住院：急診開的藥照樣由門診藥局調劑（費用併入住院帳單，不經批價）；批價時才建的領藥單在這裡建 */
function mergedDispense(v: Visit, t: string) {
  const e = find.encounterOfVisit(v.id)
  if (!e?.medications.length || db.dispenses.some((d) => d.visitId === v.id)) return
  db.dispenses.push({ id: newId('DP'), visitId: v.id, encounterId: e.id, patientId: v.patientId, pickupNo: nextCounter(`pickup:${t.slice(0, 10)}`), status: 'pending', createdAt: t })
}

const obsAdmissionOf = (admissionId: string) => {
  const a = must(find.admission(admissionId), '留觀紀錄')
  if (!a.obs) fail('這不是急診留觀')
  return a
}

/** 排留觀床（護理師）：留觀開始——產生住院號（腕帶條碼），之後護理站選「急診留觀區」照住院流程給藥、量生命徵象、寫紀錄 */
export function assignObsBed(admissionId: string, bedId: string): Promise<AdmissionView> {
  return mutate(() => {
    requireUser('nurse')
    const a = obsAdmissionOf(admissionId)
    if (a.status !== 'reserved') fail('已經排好留觀床了', 'CONFLICT')
    const bed = must(find.bed(bedId), '病床')
    if (!isObsBed(bed)) fail(`${bed.bedNo} 不是急診留觀床`, 'CONFLICT')
    admitInto(a, bed.id, now())
    audit('急診留觀排床', `${a.admitNo} ${nameOf.patient(a.patientId)} → ${bed.bedNo}`)
    return admissionView(a)
  })
}

/** 留觀床清潔完成（護理師；住院中心也能在病床圖做） */
export function cleanObsBed(bedId: string): Promise<ObsBedView> {
  return mutate(() => {
    requireUser('nurse')
    const bed = must(find.bed(bedId), '病床')
    if (!isObsBed(bed)) fail(`${bed.bedNo} 不是急診留觀床`)
    if (bed.status !== 'cleaning') fail(`${bed.bedNo} 不是清潔中`, 'CONFLICT')
    bed.status = 'empty'
    audit('留觀床清潔完成', bed.bedNo)
    return obsBedsView().find((b) => b.id === bed.id)!
  })
}

export interface ObsEndInput {
  kind: 'home' | 'admit' | 'transfer'
  note?: string
  hospital?: string
  /** 收住院：科別、主治、入院診斷；有空床可以一併轉床（沒選＝留在留觀床，住院中心看板「待床」再轉） */
  deptId?: string
  doctorId?: string
  diagnosis?: string
  bedId?: string
  /** 還有逾時沒給的藥、沒執行的臨時醫囑：確認後才能結束（和出院一樣） */
  confirmUnfinished?: boolean
}

/**
 * 結束留觀（急診醫師）：
 *   - 離院、轉院：醫囑停止、給藥排程收掉（逾時沒給的標暫停）、留觀床改清潔中；急診那次就醫到批價結（含留觀期間的藥與檢驗處置）
 *   - 收住院：同一筆住院直接轉成一般住院（不重新報到：住院號、腕帶不變；科別、主治、診斷改掉、醫囑延續由新主治決定），
 *     有空床可以一併轉床；費用整筆併入住院帳單（急診一段）
 * 在手術室、輸血中不能結束
 */
export function endObservation(admissionId: string, input: ObsEndInput): Promise<ErBoardItem> {
  return mutate(() => {
    const u = requireUser('doctor')
    if (!isErDoctor(u.doctorId)) fail('結束留觀由急診醫師決定', 'FORBIDDEN')
    const a = obsAdmissionOf(admissionId)
    if (!obsOpen(a)) fail('留觀已經結束了', 'CONFLICT')
    if (a.status !== 'admitted') fail('還沒排留觀床（病人還沒開始留觀）', 'CONFLICT')
    const v = must(find.visit(a.obs!.visitId), '急診就醫')
    if (surgeryOpen(a)) fail('病人在手術室，手術完成後才能結束留觀', 'CONFLICT')
    if (transfusionOpen(a)) fail('有血袋已發出或輸血中：輸完才能結束留觀', 'CONFLICT')
    if (input.kind !== 'admit' && openPca(a.id)) fail('PCA 還沒結束：請先結束 PCA 並雙人銷毀剩餘量', 'CONFLICT')
    if (!['home', 'admit', 'transfer'].includes(input.kind)) fail('請選擇去向')
    const t = now()
    const note = input.note?.trim()
    if (input.kind === 'transfer') {
      if (!input.hospital?.trim()) failField('hospital', '請寫轉到哪一家醫院')
      if (!note) failField('note', '請寫轉院原因')
    }
    const target = input.kind === 'admit' ? checkAdmitTarget(input) : undefined
    if (input.kind !== 'admit') {
      const overdue = db.mar.filter((m) => m.admissionId === a.id && m.status === 'pending' && m.scheduledAt < t).length
      const stat = db.ipdOrders.filter((o) => o.admissionId === a.id && o.type === 'stat' && o.status === 'active' && o.category !== 'medication').length
      if ((overdue || stat) && !input.confirmUnfinished) fail(`還有 ${overdue} 筆逾時未給藥、${stat} 筆未執行的臨時醫囑，請確認後再結束留觀`, 'CONFLICT', 'confirmUnfinished')
    }
    a.obs!.endAt = t
    a.obs!.outcome = input.kind
    v.er!.obsEnd = { kind: input.kind, at: t, by: u.id, ...(note ? { note } : {}), ...(input.kind === 'transfer' ? { hospital: input.hospital!.trim() } : {}) }
    if (target) {
      const from = a.doctorId
      a.attendingHistory = [...(a.attendingHistory ?? []), { from, to: target.doc.id, at: t, by: u.id, reason: '急診留觀收住院' }]
      Object.assign(a, { deptId: target.dept.id, doctorId: target.doc.id, diagnosis: input.diagnosis!.trim(), reason: `急診留觀後收住院${note ? `：${note}` : ''}` })
      if (input.bedId) {
        const fromBed = find.bed(a.bedId ?? '')?.bedNo
        releaseBed(a.bedId)
        const bed = takeBed(input.bedId, a.id)
        a.bedId = bed.id
        ;(a.bedHistory ??= []).push({ bedId: bed.id, from: t })
        audit('轉床', `${a.admitNo} ${fromBed} → ${bed.bedNo}（急診留觀收住院）`)
      }
      mergedDispense(v, t)
    } else {
      closeOrders(a, u.id, t, '結束留觀時未給藥')
      closeLines(a, u.id, t, input.kind === 'transfer' ? '出院（轉院）' : '出院（急診留觀離院）')
      closeRestraints(a, u.id, t)
      releaseBed(a.bedId)
      Object.assign(a, { status: 'discharged', dischargedAt: t, dischargeType: input.kind === 'transfer' ? '轉院' : '急診留觀離院' })
    }
    audit('結束留觀', `${a.admitNo} ${nameOf.patient(a.patientId)}：${ER_DISPOSITION_LABEL[input.kind]}${target ? ` ${target.dept.name} ${target.doc.name}，${input.diagnosis}${input.bedId ? `，轉 ${find.bed(a.bedId!)?.bedNo}` : '，留在留觀床待床'}` : ''}${input.kind === 'transfer' ? ` ${input.hospital}` : ''}${note ? `；${note}` : ''}`)
    return erItem(v, t)
  })
}
