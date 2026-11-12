// 門診看診：叫號、病歷草稿、完成醫囑、歷史病歷。
// 狀態推進：registered → in-consult → consulted；已批價後病歷鎖定不可再改。
import type { Admission, Encounter, VisitStatus } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now } from '@/utils/date'
import { autoQty, doseUnitOf } from './billing'
import { checkDays, doseLevel, doseNote } from './dose-rules'
import { checkAllergies, type AllergyWarning } from './allergy'
import { audit, fail, must, mutate, query, requireUser } from './http'
import { find, nameOf, pickUsable, usable, visitView, type VisitView } from './views'
import type { ExpandedOrders } from './orderset'

export interface QueueItem extends VisitView {
  encounterStatus?: Encounter['status']
}

/** 醫師的候診清單（含已看完的，方便回頭查看） */
export function listQueue(q: { date: string; doctorId: string; period?: string }): Promise<QueueItem[]> {
  return query(() =>
    db.visits
      // 慢箋領藥（refillOf）掛在原處方醫師名下申報，但不看診，不列在候診清單
      .filter((v) => v.date === q.date && v.doctorId === q.doctorId && v.status !== 'cancelled' && !v.refillOf)
      .map((v) => ({ ...visitView(v), encounterStatus: find.encounterOfVisit(v.id)?.status }))
      .filter((v) => !q.period || v.period === q.period)
      // 先依診別（上午→下午→夜診）再依看診號，不同診別的號碼才不會交錯
      .sort((a, b) => periodOrder[a.period] - periodOrder[b.period] || a.seqNo - b.seqNo),
  )
}

const periodOrder = { AM: 0, PM: 1, NIGHT: 2 } as const

const LOCKED: VisitStatus[] = ['charged', 'dispensed']

function editableEncounter(encounterId: string): Encounter {
  const e = must(db.encounters.find((x) => x.id === encounterId), '病歷')
  const v = must(find.visit(e.visitId), '掛號紀錄')
  if (v.refillOf) fail('慢箋領藥照原處方調劑，不能修改；要改藥請掛號看診', 'CONFLICT')
  if (LOCKED.includes(v.status)) fail('此次就醫已批價，病歷已鎖定；如需修改請先由批價作廢', 'CONFLICT')
  return e
}

/**
 * 叫號／開始看診：沒有病歷就建立草稿；已完成未批價的可重新開啟修改。
 * 同一位醫師今天還有別的「看診中」病人時先擋下（CONFLICT，field = 'parallel'），畫面確認後帶 allowParallel 重送：
 * 病人去照 X 光、等報告時先看下一位是正常的，所以不硬擋；要防的是「忘了按完成」——前一位的病歷停在草稿，批價永遠等不到他。
 */
export function startConsult(visitId: string, opts: { allowParallel?: boolean } = {}): Promise<Encounter> {
  return mutate(() => {
    const user = requireUser('doctor')
    const v = must(find.visit(visitId), '掛號紀錄')
    if (v.status === 'cancelled') fail('此掛號已退掛')
    if (v.refillOf) fail('慢箋領藥不需看診', 'CONFLICT')
    if (LOCKED.includes(v.status)) fail('此次就醫已批價，只能檢視', 'CONFLICT')
    if (user.role === 'doctor' && user.doctorId !== v.doctorId) fail('這不是您的病人', 'FORBIDDEN')

    const others = db.visits.filter((x) => x.id !== v.id && x.doctorId === v.doctorId && x.date === v.date && x.status === 'in-consult')
    const othersText = others.map((x) => `第 ${x.seqNo} 號 ${find.patient(x.patientId)?.name}（${x.calledAt?.slice(11) ?? '—'} 叫號）`).join('、')
    if (others.length && !opts.allowParallel) fail(`${othersText}還在看診中，病歷未完成`, 'CONFLICT', 'parallel')

    let e = find.encounterOfVisit(v.id)
    if (!e) {
      e = {
        id: newId('E'), visitId: v.id, patientId: v.patientId, doctorId: v.doctorId, deptId: v.deptId, date: v.date,
        subjective: '', objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [], medications: [], procedures: [],
        refillTimes: 0, admissionRequested: false, status: 'draft',
      }
      db.encounters.push(e)
    } else if (e.status === 'completed') {
      e.status = 'draft'
    }
    v.status = 'in-consult'
    v.calledAt ??= now()
    delete v.skippedAt // 過號的人回來、重新叫號，就不再是過號
    audit('開始看診', `${find.patient(v.patientId)?.name} #${v.seqNo}${others.length ? `（同時看診：${othersText} 仍在看診中）` : ''}`)
    return e
  })
}

/** 檢視用（任何狀態皆可讀） */
export const getEncounterByVisit = (visitId: string): Promise<Encounter | undefined> => query(() => find.encounterOfVisit(visitId))

export type EncounterDraft = Pick<
  Encounter,
  'subjective' | 'objective' | 'assessment' | 'plan' | 'vitals' | 'diagnoses' | 'medications' | 'procedures' | 'refillTimes' | 'admissionRequested'
>

export function saveDraft(encounterId: string, draft: EncounterDraft): Promise<Encounter> {
  return mutate(() => {
    requireUser('doctor')
    const e = editableEncounter(encounterId)
    Object.assign(e, structuredClone(draft))
    return e
  })
}

/** 過號：病人不在，退回候診 */
export function skipPatient(visitId: string): Promise<VisitView> {
  return mutate(() => {
    requireUser('doctor')
    const v = must(find.visit(visitId), '掛號紀錄')
    if (v.status !== 'in-consult') fail('只有看診中的病人可以過號')
    v.status = 'registered'
    v.skippedAt = now() // 記下過號，「下一位」會先跳過他（nextInQueue）
    audit('過號', `${find.patient(v.patientId)?.name} #${v.seqNo}`)
    return visitView(v)
  })
}

export interface CompleteResult {
  encounter: Encounter
  admission?: Admission
}

/** 完成醫囑：驗證 → 病歷完成 → 掛號改為待批價 →（若建議住院）自動建立住院預約 */
/** confirmHighDose：處方中有劑量偏高的藥，醫師已確認無誤（放在選項而不是病歷草稿裡，避免被存進病歷） */
export function completeEncounter(encounterId: string, draft: EncounterDraft, opts: { confirmHighDose?: boolean } = {}): Promise<CompleteResult> {
  return mutate(() => {
    requireUser('doctor')
    const e = editableEncounter(encounterId)
    const v = must(find.visit(e.visitId), '掛號紀錄')
    Object.assign(e, structuredClone(draft))

    if (!e.diagnoses.length) fail('請至少輸入一個診斷')
    if (!e.diagnoses.some((d) => d.primary)) e.diagnoses[0].primary = true
    if (e.diagnoses.filter((d) => d.primary).length > 1) fail('主診斷只能有一個')
    for (const m of e.medications) {
      const d = usable.drug(m.drugId)
      if (m.dose <= 0) fail(`${d.name} 的劑量必須大於 0`)
      const dayProblem = checkDays(m.days)
      if (dayProblem) fail(`${d.name}：${dayProblem}`)
      const level = doseLevel(d, m.dose)
      if (level === 'absurd') fail(`${d.name}：${doseNote(d, m.dose)}，請確認是否打錯`)
      if (level === 'high' && !opts.confirmHighDose) fail(`${d.name} 劑量偏高：${doseNote(d, m.dose)}，如確定請確認`, 'CONFLICT')
      if (m.qty <= 0) {
        const q = autoQty(d, m.dose, find.freq(m.freq)?.timesPerDay ?? 1, m.days)
        if (q === null) fail(`${d.name} 的給藥單位（${doseUnitOf(d)}）與調劑單位（${d.unit}）不同，請填寫總量`)
        m.qty = q
      }
    }
    for (const p of e.procedures) usable.procedure(p.procId)
    for (const d of e.diagnoses) usable.icd(d.icd)
    if (e.refillTimes > 0 && v.caseType !== '04' && v.caseType !== '08') fail('連續處方箋需為慢性病案件（04）')

    e.status = 'completed'
    e.completedAt = now()
    v.status = 'consulted'

    let admission: Admission | undefined
    const already = db.admissions.some((a) => a.patientId === e.patientId && (a.status === 'reserved' || a.status === 'admitted'))
    if (e.admissionRequested && !already) {
      const primary = e.diagnoses.find((d) => d.primary)!
      admission = {
        id: newId('A'), admitNo: '', patientId: e.patientId, fromVisitId: v.id, deptId: e.deptId, doctorId: e.doctorId,
        preferBedClass: '健保床', reason: e.assessment || primary.name, diagnosis: `${primary.icd} ${primary.name}`,
        status: 'reserved', reservedAt: now(), expectedDate: addDays(e.date, 1),
      }
      db.admissions.push(admission)
    }
    audit('完成看診', `${find.patient(e.patientId)?.name} ${e.diagnoses.map((d) => d.icd).join(',')}${admission ? '（建議住院）' : ''}`)
    return { encounter: e, admission }
  })
}

/** 開藥時的過敏檢查（不擋，交給醫師判斷；畫面顯示警示） */
export function allergyWarnings(patientId: string, drugIds: string[]): Promise<AllergyWarning[]> {
  return query(() => {
    const p = must(find.patient(patientId), '病患')
    const drugs = drugIds.map((id) => find.drug(id)).filter((d) => !!d)
    return checkAllergies(p.allergies, drugs)
  })
}

export interface ExpandedEncounter extends ExpandedOrders {
  /** 實際帶入的那次看診（慢箋調劑會換成原處方那次） */
  date: string
  doctorName: string
  /** 前次是慢箋調劑時，實際帶入的是 refillFrom 那天的原處方看診 */
  refillFrom?: string
}

/**
 * 「同前次」：把某次看診的內容展開成可以帶進本次的項目。
 * - 停用的藥、處置、診斷碼濾掉並列出（和套用組套同一個 pickUsable）
 * - 只帶 A 評估、P 計畫；S 主訴、O 客觀、生命徵象是本次的事實，不能沿用上次的
 * - 慢箋調劑那筆不是醫師看診（沒有評估、計畫），改帶它的原處方那次看診
 * - 只能帶同一位病人的病歷（forPatientId），避免帶錯人
 */
export function expandEncounter(encounterId: string, forPatientId: string): Promise<ExpandedEncounter> {
  return query(() => {
    requireUser('doctor')
    let e = must(db.encounters.find((x) => x.id === encounterId), '病歷')
    if (e.patientId !== forPatientId) fail('這不是本位病人的病歷', 'FORBIDDEN')
    const refillOf = find.visit(e.visitId)?.refillOf
    const refillFrom = refillOf ? e.date : undefined
    if (refillOf) e = must(db.encounters.find((x) => x.id === refillOf), '原處方病歷')
    return {
      ...pickUsable(e),
      assessment: e.assessment,
      plan: e.plan,
      date: e.date,
      doctorName: nameOf.doctor(e.doctorId),
      refillFrom,
    }
  })
}

export interface HistoryItem extends Encounter {
  /** 慢箋第幾次調劑（不是看診）；一般看診沒有 */
  refillSeq?: number
  doctorName: string
  deptName: string
  medicationNames: string[]
  procedureNames: string[]
}

/** 歷史病歷（已完成的），新的在前；看診畫面用來參考與複製前次處方 */
export function patientHistory(patientId: string, excludeVisitId?: string): Promise<HistoryItem[]> {
  return query(() =>
    db.encounters
      .filter((e) => e.patientId === patientId && e.status === 'completed' && e.visitId !== excludeVisitId)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((e) => ({
        ...e,
        refillSeq: find.visit(e.visitId)?.refillSeq,
        doctorName: nameOf.doctor(e.doctorId),
        deptName: nameOf.dept(e.deptId),
        medicationNames: e.medications.map((m) => find.drug(m.drugId)?.name ?? m.drugId),
        procedureNames: e.procedures.map((p) => find.procedure(p.procId)?.name ?? p.procId),
      })),
  )
}
