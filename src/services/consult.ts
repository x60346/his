// 住院會診單：主治請別科「來看看」。多數只要建議、不一定轉科；回覆可以「建議轉本科」，原科一鍵帶入轉科申請。
// 會診醫師不是主治，看的是會診單附上的病人摘要（診斷、執行中醫囑、最新生命徵象、最近的病程紀錄），不是整份病歷——
// 範圍清楚，也不必改「住院醫囑只看我的病人」的設計。
// 申請與回覆都寫進病程紀錄（addChartNote）：病歷時間軸上看得到會診的經過。
import type { Admission, Consult } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failFields, fieldErrors, must, mutate, query, requireUser } from './http'
import { addChartNote } from './order-ops'
import { orderView, type OrderView } from './ipd'
import { admissionView, find, nameOf, type AdmissionView } from './views'

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
    const a = must(find.admission(c.admissionId), '住院紀錄')
    if (d.deptId !== a.deptId) fail('只有病人目前科別的醫師可以撤回', 'FORBIDDEN')
    if (c.status !== 'pending') fail(c.status === 'answered' ? '已經回覆了，不能撤回' : '已經撤回了', 'CONFLICT')
    if (!reason?.trim()) failFields({ reason: '請寫撤回原因' })
    Object.assign(c, { status: 'cancelled', cancelledAt: now(), cancelReason: reason.trim() })
    audit('撤回會診', `${a.admitNo} ${nameOf.patient(a.patientId)} → ${nameOf.dept(c.toDeptId)}：${reason.trim()}`)
    return consultView(c)
  })
}

export interface IncomingConsult {
  consult: ConsultView
  summary: ConsultPatientSummary
}

/** 待我（我這科）回覆的會診：急會診在前，再依申請時間 */
export function listIncomingConsults(): Promise<IncomingConsult[]> {
  return query(() => {
    const { d } = me()
    return db.consults
      .filter((c) => c.status === 'pending' && c.toDeptId === d.deptId && (!c.toDoctorId || c.toDoctorId === d.id))
      .filter((c) => find.admission(c.admissionId)?.status === 'admitted')
      .sort((p, q) => Number(q.urgent) - Number(p.urgent) || p.requestedAt.localeCompare(q.requestedAt))
      .map((c) => ({ consult: consultView(c), summary: summaryOf(find.admission(c.admissionId)!) }))
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
export function answerConsult(id: string, input: { findings: string; recommendation: string; suggestTransfer?: boolean }): Promise<ConsultView> {
  return mutate(() => {
    const { d } = me()
    const c = must(db.consults.find((x) => x.id === id), '會診單')
    if (c.toDeptId !== d.deptId) fail(`這是給${nameOf.dept(c.toDeptId)}的會診`, 'FORBIDDEN')
    if (c.toDoctorId && c.toDoctorId !== d.id) fail(`這張會診指定由 ${nameOf.doctor(c.toDoctorId)} 回覆`, 'FORBIDDEN')
    if (c.status !== 'pending') fail(c.status === 'answered' ? `已由 ${nameOf.doctor(c.answeredBy)} 回覆` : '這張會診已撤回', 'CONFLICT')
    const a = admitted(c.admissionId)
    const v = fieldErrors()
    if (!input.findings?.trim()) v.add('findings', '請寫評估（看診所見）')
    if (!input.recommendation?.trim()) v.add('recommendation', '請寫建議')
    v.done()
    const t = now()
    Object.assign(c, { status: 'answered', answeredBy: d.id, answeredAt: t, findings: input.findings.trim(), recommendation: input.recommendation.trim(), ...(input.suggestTransfer ? { suggestTransfer: true } : {}) })
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

