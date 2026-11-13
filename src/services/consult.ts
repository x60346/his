// 住院會診單：主治請別科「來看看」。多數只要建議、不一定轉科；回覆可以「建議轉本科」，原科一鍵帶入轉科申請。
// 會診醫師不是主治，看的是會診單附上的病人摘要（診斷、執行中醫囑、最新生命徵象、最近的病程紀錄），不是整份病歷——
// 範圍清楚，也不必改「住院醫囑只看我的病人」的設計。
// 申請與回覆都寫進病程紀錄（addChartNote）：病歷時間軸上看得到會診的經過。
// 門診會診（visitId）：看診中請別科書面會診，病人不必另外掛號；回覆留在這次就醫（就診紀錄看得到），要當面看診的勾「建議掛本科門診」。不收費。
import type { Admission, Consult } from '@/types'
import { db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failFields, fieldErrors, must, mutate, query, requireUser } from './http'
import { addChartNote } from './order-ops'
import { orderView, type OrderView } from './ipd'
import { admissionView, find, nameOf, type AdmissionView } from './views'
import { consultOpenFor } from './care-team'

function me() {
  const u = requireUser('doctor')
  const d = u.doctorId ? find.doctor(u.doctorId) : undefined
  if (!d) fail('此帳號沒有對應的醫師資料', 'FORBIDDEN')
  return { u, d: d! }
}

function admitted(admissionId: string): Admission {
  const a = must(find.admission(admissionId), '住院紀錄')
  if (a.status !== 'admitted') fail('只有住院中的病人可以會診', 'CONFLICT')
  return a
}

/** 會診單的檢視：雙方名稱、等了多久 */
export interface ConsultView extends Consult {
  fromDeptName: string
  fromDoctorName: string
  toDeptName: string
  toDoctorName?: string
  answeredByName?: string
  /** 還沒回覆的：等了幾小時 */
  waitingHours?: number
}

const consultPatientName = (c: Consult) => nameOf.patient(c.admissionId ? find.admission(c.admissionId)?.patientId : find.visit(c.visitId ?? '')?.patientId)

const consultView = (c: Consult): ConsultView => ({
  ...c,
  fromDeptName: nameOf.dept(c.fromDeptId),
  fromDoctorName: nameOf.doctor(c.fromDoctorId),
  toDeptName: nameOf.dept(c.toDeptId),
  ...(c.toDoctorId ? { toDoctorName: nameOf.doctor(c.toDoctorId) } : {}),
  ...(c.answeredBy ? { answeredByName: nameOf.doctor(c.answeredBy) } : {}),
  ...(c.status === 'pending' ? { waitingHours: Math.max(0, Math.floor((Date.parse(now().replace(' ', 'T')) - Date.parse(c.requestedAt.replace(' ', 'T'))) / 3_600_000)) } : {}),
})

/** 會診醫師看的病人摘要 */
export interface ConsultPatientSummary {
  admission: AdmissionView
  allergies: string[]
  orders: OrderView[]
  latestVital?: { at: string; text: string }
  latestNote?: { at: string; doctorName: string; assessment: string; plan: string }
}

function summaryOf(a: Admission): ConsultPatientSummary {
  const v = db.vitals.filter((x) => x.admissionId === a.id).sort((p, q) => q.at.localeCompare(p.at))[0]
  const n = db.progressNotes.filter((x) => x.admissionId === a.id && !x.kind).sort((p, q) => q.at.localeCompare(p.at))[0]
  const vt = v ? [v.temp && `T ${v.temp}`, v.pulse && `P ${v.pulse}`, v.resp && `R ${v.resp}`, v.sbp && `BP ${v.sbp}/${v.dbp}`, v.spo2 && `SpO2 ${v.spo2}`].filter(Boolean).join('・') : ''
  return {
    admission: admissionView(a),
    allergies: find.patient(a.patientId)?.allergies ?? [],
    orders: db.ipdOrders.filter((o) => o.admissionId === a.id && o.status === 'active' && o.type === 'long').map(orderView),
    ...(v ? { latestVital: { at: v.at, text: vt } } : {}),
    ...(n ? { latestNote: { at: n.at, doctorName: nameOf.doctor(n.doctorId), assessment: n.assessment, plan: n.plan } } : {}),
  }
}

export interface ConsultInput {
  toDeptId: string
  toDoctorId?: string
  question: string
  urgent?: boolean
}

/** 開會診單（病人目前科別的醫師）：選科別、可指定醫師、會診目的、急會診 */
export function requestConsult(admissionId: string, input: ConsultInput): Promise<ConsultView> {
  return mutate(() => {
    const { d } = me()
    const a = admitted(admissionId)
    if (d.deptId !== a.deptId) fail(`只有${nameOf.dept(a.deptId)}的醫師可以為這位病人開會診單`, 'FORBIDDEN')
    const v = fieldErrors()
    const dept = find.dept(input.toDeptId ?? '')
    if (!dept || !dept.active) v.add('toDeptId', '請選擇會診科別')
    else if (dept.id === a.deptId) v.add('toDeptId', '與病人目前的科別相同')
    else if (!db.doctors.some((x) => x.active && x.deptId === dept.id)) v.add('toDeptId', `${dept.name}目前沒有在職醫師`)
    if (input.toDoctorId) {
      const doc = find.doctor(input.toDoctorId)
      if (!doc || !doc.active || doc.deptId !== input.toDeptId) v.add('toDoctorId', '指定的醫師不是該科在職醫師')
    }
    if (!input.question?.trim()) v.add('question', '請寫會診目的（想請對方評估什麼）')
    v.done()
    if (db.consults.some((c) => c.admissionId === a.id && c.toDeptId === dept!.id && c.status === 'pending')) fail(`已有一張會診${dept!.name}的單還沒回覆`, 'CONFLICT')
    const t = now()
    const c: Consult = {
      id: newId('CS'), admissionId: a.id, fromDeptId: a.deptId, fromDoctorId: d.id, toDeptId: dept!.id,
      ...(input.toDoctorId ? { toDoctorId: input.toDoctorId } : {}),
      question: input.question.trim(), urgent: !!input.urgent, requestedAt: t, status: 'pending',
    }
    db.consults.push(c)
    addChartNote(a.id, d.id, 'consult', [
      { label: '會診', text: `${dept!.name}${c.toDoctorId ? `（指定 ${nameOf.doctor(c.toDoctorId)}）` : ''}${c.urgent ? '・急會診' : ''}` },
      { label: '目的', text: c.question },
    ], t)
    audit('會診申請', `${a.admitNo} ${nameOf.patient(a.patientId)} → ${dept!.name}${c.urgent ? '（急）' : ''}：${c.question}`)
    return consultView(c)
  })
}

/** 撤回還沒回覆的會診單（病人目前科別的醫師，寫原因） */
export function cancelConsult(id: string, reason: string): Promise<ConsultView> {
  return mutate(() => {
    const { d } = me()
    const c = must(db.consults.find((x) => x.id === id), '會診單')
    const ownerDept = c.admissionId ? must(find.admission(c.admissionId), '住院紀錄').deptId : must(find.visit(c.visitId ?? ''), '掛號紀錄').deptId
    if (d.deptId !== ownerDept) fail('只有病人目前科別的醫師可以撤回', 'FORBIDDEN')
    if (c.status !== 'pending') fail(c.status === 'answered' ? '已經回覆了，不能撤回' : '已經撤回了', 'CONFLICT')
    if (!reason?.trim()) failFields({ reason: '請寫撤回原因' })
    Object.assign(c, { status: 'cancelled', cancelledAt: now(), cancelReason: reason.trim() })
    audit('撤回會診', `${consultPatientName(c)} → ${nameOf.dept(c.toDeptId)}：${reason.trim()}`)
    return consultView(c)
  })
}

export interface IncomingConsult {
  consult: ConsultView
  summary: ConsultPatientSummary
  /** 會診範圍內：可以開醫囑（待回覆，或我回覆後 72 小時內） */
  canOrder: boolean
}

/**
 * 待我（我這科）回覆的會診：急會診在前，再依申請時間。後面接著我已回覆、還在開醫囑範圍內的（回覆後 72 小時）：
 * 會診醫師可能要追蹤、調整自己開的醫囑
 */
export function listIncomingConsults(): Promise<IncomingConsult[]> {
  return query(() => {
    const { d } = me()
    return db.consults
      .filter((c) => !!c.admissionId && ((c.status === 'pending' && c.toDeptId === d.deptId && (!c.toDoctorId || c.toDoctorId === d.id)) || (c.status === 'answered' && consultOpenFor(c, d.id))))
      .filter((c) => find.admission(c.admissionId!)?.status === 'admitted')
      .sort((p, q) => Number(p.status === 'answered') - Number(q.status === 'answered') || Number(q.urgent) - Number(p.urgent) || p.requestedAt.localeCompare(q.requestedAt))
      .map((c) => ({ consult: consultView(c), summary: summaryOf(find.admission(c.admissionId!)!), canOrder: consultOpenFor(c, d.id) }))
  })
}

/** 這位病人的會診單（新到舊）：主治看回覆、會診建議轉科 */
export function listConsults(admissionId: string): Promise<ConsultView[]> {
  return query(() => {
    requireUser('doctor')
    return db.consults.filter((c) => c.admissionId === admissionId).sort((p, q) => q.requestedAt.localeCompare(p.requestedAt)).map(consultView)
  })
}

/** 回覆會診（該科醫師；有指定時只有他）：評估、建議必填；可建議轉入本科 */
export function answerConsult(id: string, input: { findings: string; recommendation: string; suggestTransfer?: boolean; suggestVisit?: boolean }): Promise<ConsultView> {
  return mutate(() => {
    const { d } = me()
    const c = must(db.consults.find((x) => x.id === id), '會診單')
    if (c.toDeptId !== d.deptId) fail(`這是給${nameOf.dept(c.toDeptId)}的會診`, 'FORBIDDEN')
    if (c.toDoctorId && c.toDoctorId !== d.id) fail(`這張會診指定由 ${nameOf.doctor(c.toDoctorId)} 回覆`, 'FORBIDDEN')
    if (c.status !== 'pending') fail(c.status === 'answered' ? `已由 ${nameOf.doctor(c.answeredBy)} 回覆` : '這張會診已撤回', 'CONFLICT')
    const a = c.admissionId ? admitted(c.admissionId) : undefined
    const v = fieldErrors()
    if (!input.findings?.trim()) v.add('findings', '請寫評估（看診所見）')
    if (!input.recommendation?.trim()) v.add('recommendation', '請寫建議')
    v.done()
    const t = now()
    Object.assign(c, { status: 'answered', answeredBy: d.id, answeredAt: t, findings: input.findings.trim(), recommendation: input.recommendation.trim(), ...(input.suggestTransfer && a ? { suggestTransfer: true } : {}), ...(input.suggestVisit && !a ? { suggestVisit: true } : {}) })
    if (!a) {
      // 門診會診：回覆留在會診單上（就診紀錄、看診頁看得到），不寫住院病程
      audit('門診會診回覆', `${consultPatientName(c)}（${nameOf.dept(c.fromDeptId)} → ${nameOf.dept(c.toDeptId)}）${c.suggestVisit ? '：建議掛本科門診' : ''}`)
      return consultView(c)
    }
    addChartNote(a.id, d.id, 'consultReply', [
      { label: '會診回覆', text: `${nameOf.dept(d.deptId)}（申請：${c.requestedAt.slice(5)}，${c.question}）` },
      { label: '評估', text: c.findings! },
      { label: '建議', text: c.recommendation! },
      { label: '轉科', text: c.suggestTransfer ? `建議轉入${nameOf.dept(d.deptId)}` : '' },
    ], t)
    audit('會診回覆', `${a.admitNo} ${nameOf.patient(a.patientId)}（${nameOf.dept(c.fromDeptId)} → ${nameOf.dept(c.toDeptId)}）${c.suggestTransfer ? '：建議轉本科' : ''}`)
    return consultView(c)
  })
}


// ---------- 門診會診 ----------

/** 門診會診的病人摘要：這次看診的主訴、評估、診斷、處方、生命徵象、過敏（會診醫師看這份就夠） */
export interface OpdConsultSummary {
  visitId: string
  date: string
  patientName: string
  chartNo: string
  gender: string
  birthDate: string
  allergies: string[]
  deptName: string
  doctorName: string
  subjective?: string
  objective?: string
  assessment?: string
  diagnoses: string[]
  medications: string[]
  vitals: string
}

function opdSummaryOf(visitId: string): OpdConsultSummary {
  const v = must(find.visit(visitId), '掛號紀錄')
  const p = must(find.patient(v.patientId), '病人')
  const e = find.encounterOfVisit(visitId)
  const vt = e?.vitals ?? {}
  return {
    visitId, date: v.date, patientName: p.name, chartNo: p.chartNo, gender: p.gender, birthDate: p.birthDate, allergies: p.allergies,
    deptName: nameOf.dept(v.deptId), doctorName: nameOf.doctor(v.doctorId),
    ...(e?.subjective ? { subjective: e.subjective } : {}), ...(e?.objective ? { objective: e.objective } : {}), ...(e?.assessment ? { assessment: e.assessment } : {}),
    diagnoses: (e?.diagnoses ?? []).map((x) => `${x.icd} ${x.name}`),
    medications: (e?.medications ?? []).map((m) => `${find.drug(m.drugId)?.name ?? m.drugId} ${m.dose} ${m.freq} ${m.days} 天`),
    vitals: [
      vt.temp && `T ${vt.temp}`, vt.pulse && `P ${vt.pulse}`, vt.resp && `R ${vt.resp}`, vt.sbp && `BP ${vt.sbp}/${vt.dbp ?? '?'}`, vt.spo2 && `SpO2 ${vt.spo2}`,
      vt.height && `身高 ${vt.height}`, vt.weight && `體重 ${vt.weight}`,
    ].filter(Boolean).join('・'),
  }
}

/** 門診會診：看診中（或今天看完）的醫師請別科書面會診；病人不必另外掛號、不收費 */
export function requestOpdConsult(visitId: string, input: ConsultInput): Promise<ConsultView> {
  return mutate(() => {
    const { d } = me()
    const v = must(find.visit(visitId), '掛號紀錄')
    if (v.date !== today()) fail('門診會診只能在看診當天提出', 'CONFLICT')
    if (!['in-consult', 'consulted', 'charged', 'dispensed'].includes(v.status)) fail('病人還沒看診，不能會診', 'CONFLICT')
    if (d.deptId !== v.deptId) fail(`只有${nameOf.dept(v.deptId)}的醫師可以為這位病人開會診單`, 'FORBIDDEN')
    const f = fieldErrors()
    const dept = find.dept(input.toDeptId ?? '')
    if (!dept || !dept.active) f.add('toDeptId', '請選擇會診科別')
    else if (dept.id === v.deptId) f.add('toDeptId', '與病人這次看診的科別相同')
    else if (!db.doctors.some((x) => x.active && x.deptId === dept.id)) f.add('toDeptId', `${dept.name}目前沒有在職醫師`)
    if (input.toDoctorId) {
      const doc = find.doctor(input.toDoctorId)
      if (!doc || !doc.active || doc.deptId !== input.toDeptId) f.add('toDoctorId', '指定的醫師不是該科在職醫師')
    }
    if (!input.question?.trim()) f.add('question', '請寫會診目的（想請對方評估什麼）')
    f.done()
    if (db.consults.some((c) => c.visitId === v.id && c.toDeptId === dept!.id && c.status === 'pending')) fail(`已有一張會診${dept!.name}的單還沒回覆`, 'CONFLICT')
    const c: Consult = {
      id: newId('CS'), visitId: v.id, fromDeptId: v.deptId, fromDoctorId: d.id, toDeptId: dept!.id,
      ...(input.toDoctorId ? { toDoctorId: input.toDoctorId } : {}),
      question: input.question.trim(), urgent: !!input.urgent, requestedAt: now(), status: 'pending',
    }
    db.consults.push(c)
    audit('門診會診申請', `${nameOf.patient(v.patientId)} ${nameOf.dept(v.deptId)} → ${dept!.name}${c.urgent ? '（急）' : ''}：${c.question}`)
    return consultView(c)
  })
}

export interface IncomingOpdConsult {
  consult: ConsultView
  summary: OpdConsultSummary
  /** 當天沒回覆：標逾期（不會自動消失） */
  overdue: boolean
}

/** 待我（我這科）回覆的門診會診：急的在前、再依申請時間；以前沒回的標逾期 */
export function listIncomingOpdConsults(): Promise<IncomingOpdConsult[]> {
  return query(() => {
    const { d } = me()
    return db.consults
      .filter((c) => !!c.visitId && c.status === 'pending' && c.toDeptId === d.deptId && (!c.toDoctorId || c.toDoctorId === d.id))
      .sort((p, q) => Number(q.urgent) - Number(p.urgent) || p.requestedAt.localeCompare(q.requestedAt))
      .map((c) => ({ consult: consultView(c), summary: opdSummaryOf(c.visitId!), overdue: c.requestedAt.slice(0, 10) < today() }))
  })
}

/** 這次掛號的會診單（看診頁、就診紀錄） */
export function listVisitConsults(visitId: string): Promise<ConsultView[]> {
  return query(() => {
    requireUser('doctor')
    return db.consults.filter((c) => c.visitId === visitId).sort((p, q) => p.requestedAt.localeCompare(q.requestedAt)).map(consultView)
  })
}

/** 我申請的、已回覆還沒看的門診會診（首頁待辦「會診已回覆」、看診頁上方） */
export function listOpdConsultReplies(): Promise<(ConsultView & { patientName: string; visitDate: string })[]> {
  return query(() => {
    const { d } = me()
    return db.consults
      .filter((c) => !!c.visitId && c.fromDoctorId === d.id && c.status === 'answered' && !c.replySeenAt)
      .sort((p, q) => (p.answeredAt ?? '').localeCompare(q.answeredAt ?? ''))
      .map((c) => ({ ...consultView(c), patientName: consultPatientName(c), visitDate: find.visit(c.visitId!)?.date ?? '' }))
  })
}

/** 申請的醫師看過回覆 */
export function ackConsultReply(id: string): Promise<ConsultView> {
  return mutate(() => {
    const { d } = me()
    const c = must(db.consults.find((x) => x.id === id), '會診單')
    if (c.fromDoctorId !== d.id) fail('只有申請的醫師可以標已閱', 'FORBIDDEN')
    if (c.status !== 'answered') fail('還沒回覆', 'CONFLICT')
    c.replySeenAt = now()
    return consultView(c)
  })
}
