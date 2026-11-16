// 門診看診：叫號、病歷草稿、完成醫囑、歷史病歷。
// 狀態推進：registered → in-consult → consulted；已批價後病歷鎖定不可再改。
import type { Admission, Encounter, VisitStatus } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now } from '@/utils/date'
import { autoQty, doseUnitOf } from './billing'
import { checkDays, doseLevel, doseNote } from './dose-rules'
import { CONTROLLED_LEVEL_LABEL, ID_NO_PATTERN, licenseProblem, needsSpecialRx } from './controlled-rules'
import { checkAllergies, type AllergyWarning } from './allergy'
import { checkRxAlerts, type RxAlert } from './interaction-rules'
import { drugRefs, opdInUse, settleRxAlerts } from './rx-alert-work'
import { audit, fail, must, mutate, query, requireUser, requirePermission } from './http'
import { cleanRxTimings, find, nameOf, pickUsable, usable, visitView, type VisitView } from './views'
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
export function startConsult(visitId: string, opts: { allowParallel?: boolean; allowNotCheckedIn?: boolean } = {}): Promise<Encounter> {
  return mutate(() => {
    const user = requireUser('doctor')
    const v = must(find.visit(visitId), '掛號紀錄')
    if (v.status === 'cancelled') fail('此掛號已退掛')
    if (v.refillOf) fail('慢箋領藥不需看診', 'CONFLICT')
    if (LOCKED.includes(v.status)) fail('此次就醫已批價，只能檢視', 'CONFLICT')
    if (user.role === 'doctor' && user.doctorId !== v.doctorId) fail('這不是您的病人', 'FORBIDDEN')

    // 還沒報到：病人可能根本還沒到。不硬擋（櫃台忘了按、病人直接走進診間都有），確認後才叫，稽核留紀錄
    const notCheckedIn = v.status === 'registered' && !v.checkedInAt
    if (notCheckedIn && !opts.allowNotCheckedIn) fail(`第 ${v.seqNo} 號 ${find.patient(v.patientId)?.name} 尚未報到`, 'CONFLICT', 'checkIn')

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
    audit('開始看診', `${find.patient(v.patientId)?.name} #${v.seqNo}${notCheckedIn ? '（未報到，醫師確認後叫號）' : ''}${others.length ? `（同時看診：${othersText} 仍在看診中）` : ''}`)
    return e
  })
}

/** 檢視用（任何狀態皆可讀） */
export const getEncounterByVisit = (visitId: string): Promise<Encounter | undefined> => query(() => find.encounterOfVisit(visitId))

export type EncounterDraft = Pick<
  Encounter,
  'subjective' | 'objective' | 'assessment' | 'plan' | 'vitals' | 'diagnoses' | 'medications' | 'procedures' | 'refillTimes' | 'admissionRequested'
>

/** 病歷草稿：「未執行」只能由批價標（charge.markProcedureNotDone），醫師送來的一律拿掉（例：「同前次」帶入舊的醫令） */
const cleanDraft = (d: EncounterDraft): EncounterDraft => {
  const c = structuredClone(d)
  if (c.procedures) c.procedures = c.procedures.map(({ notDone: _, ...p }) => p)
  // 用藥提醒的確認只在完成看診時由服務層算好存，畫面送來的不收
  delete (c as Partial<Encounter>).rxAlerts
  return c
}

export function saveDraft(encounterId: string, draft: EncounterDraft): Promise<Encounter> {
  return mutate(() => {
    requireUser('doctor')
    const e = editableEncounter(encounterId)
    Object.assign(e, cleanDraft(draft))
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
/**
 * confirmHighDose：處方中有劑量偏高的藥，醫師已確認無誤（放在選項而不是病歷草稿裡，避免被存進病歷）
 * rxAlertReasons：交互作用、重複用藥提醒的確認（key → 原因；嚴重的原因必填）。還沒確認的服務層擋下（CONFLICT，field rxAlerts）
 */
export function completeEncounter(encounterId: string, draft: EncounterDraft, opts: { confirmHighDose?: boolean; rxAlertReasons?: Record<string, string> } = {}): Promise<CompleteResult> {
  return mutate(() => {
    requirePermission('order.write')
    const e = editableEncounter(encounterId)
    const v = must(find.visit(e.visitId), '掛號紀錄')
    Object.assign(e, cleanDraft(draft))

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
    cleanRxTimings(e.medications)
    specialRxCheck(e)
    // 交互作用、重複用藥：這張處方彼此之間，以及病人還在吃的本院藥（別科、前幾天開的、出院帶藥）
    const rxAlerts = settleRxAlerts(drugRefs(e.medications.map((m) => m.drugId)), opdInUse(e.patientId, e.date, e.id), opts.rxAlertReasons)
    if (rxAlerts) e.rxAlerts = rxAlerts
    else delete e.rxAlerts
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
    const severe = (e.rxAlerts ?? []).filter((a) => a.level === 'severe')
    audit('完成看診', `${find.patient(e.patientId)?.name} ${e.diagnoses.map((d) => d.icd).join(',')}${admission ? '（建議住院）' : ''}${severe.length ? `；嚴重交互作用仍開立：${severe.map((a) => `${a.title}（${a.reason}）`).join('、')}` : ''}`)
    return { encounter: e, admission }
  })
}

/**
 * 第一～三級管制藥（要專用處方箋）：醫師要有有效的管制藥品使用執照；病人要有身分證號與地址（處方箋必填）；
 * 第一、二級以一次調劑為限，不能開成慢性病連續處方箋。規則見 controlled-rules
 */
function specialRxCheck(e: Encounter) {
  const special = e.medications.map((m) => find.drug(m.drugId)!).filter((d) => needsSpecialRx(d.controlled))
  if (!special.length) return
  const names = special.map((d) => `${d.name}（${CONTROLLED_LEVEL_LABEL[d.controlled!]}管制藥）`).join('、')
  const doc = find.doctor(e.doctorId)
  const why = licenseProblem(doc?.controlledLicense, e.date)
  if (why) fail(`${doc?.name ?? '醫師'}${why}，不能開立 ${names}`)
  const p = must(find.patient(e.patientId), '病患')
  const missing = [!ID_NO_PATTERN.test(p.idNo ?? '') && '身分證號', !p.address?.trim() && '地址'].filter(Boolean)
  if (missing.length) fail(`開立 ${names}要用專用處方箋，病人的${missing.join('、')}必填：請先到病人資料補齊`)
  if (e.refillTimes > 0 && special.some((d) => d.controlled! <= 2)) fail(`${names}以一次調劑為限，不能開成慢性病連續處方箋`)
}

/**
 * 開藥時的交互作用、重複用藥提醒（處方表即時顯示）：這張處方的藥彼此之間，以及病人還在吃的本院藥。
 * 判斷和完成看診同一份（rx-alert-work）
 */
export function rxAlerts(encounterId: string, drugIds: string[]): Promise<RxAlert[]> {
  return query(() => {
    const e = must(db.encounters.find((x) => x.id === encounterId), '病歷')
    return checkRxAlerts(drugRefs(drugIds), opdInUse(e.patientId, e.date, e.id))
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
  /** 這次看診開的診斷證明書（作廢的不列）：字號、份數 */
  certificates: string[]
  /** 這次開的轉診單（作廢的不列）：「台大醫院 心臟內科（進一步檢查）」 */
  referralsOut: string[]
  /** 這次是外院轉入：「○○診所 轉入」（同一療程的回診也標） */
  referralFrom?: string
  /** 這次看診的門診會診（含回覆） */
  consults: { id: string; toDeptName: string; question: string; status: string; findings?: string; recommendation?: string; answeredByName?: string; suggestVisit?: boolean }[]
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
        consults: db.consults.filter((c) => c.visitId === e.visitId && c.status !== 'cancelled').map((c) => ({
          id: c.id, toDeptName: nameOf.dept(c.toDeptId), question: c.question, status: c.status,
          ...(c.findings ? { findings: c.findings, recommendation: c.recommendation, answeredByName: nameOf.doctor(c.answeredBy) } : {}),
          ...(c.suggestVisit ? { suggestVisit: true } : {}),
        })),
        medicationNames: e.medications.map((m) => find.drug(m.drugId)?.name ?? m.drugId),
        certificates: db.certificates.filter((c) => c.encounterId === e.id && !c.voided).map((c) => `${c.no}（${c.copies} 份）`),
        referralsOut: db.referrals.filter((r) => r.encounterId === e.id && !r.voided).map((r) => `${r.toHospital} ${r.toDept}（${r.purpose}${r.urgent ? '，急' : ''}）`),
        ...(() => {
          const r = find.visit(e.visitId)?.referralIn
          return r ? { referralFrom: `${r.fromHospital} 轉入${r.inheritedFrom ? '（同一療程回診）' : ''}${r.reply ? '・已回覆' : ''}` } : {}
        })(),
        procedureNames: e.procedures.map((p) => `${find.procedure(p.procId)?.name ?? p.procId}${p.notDone ? `（未執行：${p.notDone.reason}）` : ''}`),
      })),
  )
}
