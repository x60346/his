// 影像檢查排程與檢查室：影像醫令（門診批價後、住院開立後）進「待排程」；櫃台（或放射科醫師）排檢查室與時間（同一間撞期擋、
// 開放時段 08:00–17:00）→ 檢查室清單依序「報到」→「完成」（住院的臨時醫囑一起完成），完成後才進判讀清單。
// 住院排好的檢查，護理站看得到幾點去做、和給藥時間衝突的標出來。
// 取消（寫原因）回到待排程；過了排程 30 分鐘沒報到標「未到」（可以改時間；門診的開立醫師首頁看得到）。
// 檢查前準備（主檔：腹部超音波禁食 6 小時、含顯影劑 CT 要同意書與腎功能）報到時逐項確認，沒完成不能做；
// 顯影劑看 CrCl：< 30 擋、30–45 提醒水化（住院醫師可一鍵開水化醫囑，ipd.orderContrastHydration）、算不出提醒先確認；
// 顯影劑過敏：開立醫師（住院另含主治、放射科）確認已開前置用藥並寫原因才放行報到；
// 有在用 Metformin 且 CrCl < 45（或算不出）：排程、報到時提醒，住院做完後主治首頁「暫停 Metformin 48 小時」要按已處理。規則在 exam-rules
import type { ContrastClearance, ImagingExam } from '@/types'
import { db, newId } from '@/mock/db'
import { addMinutes, now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser, sessionRole, sessionUser } from './http'
import { checkExamSlot, contrastAllergy, contrastCheck, hydrationRate, HYDRATION, metforminAtRisk, metforminText, METFORMIN_HOLD_HOURS, examClash, examNoShow, examRoomName, examStage, EXAM_ROOMS, EXAM_STAGE_LABEL, marConflicts, examPrepMissing, type ExamStage } from './exam-rules'
import { latestWeight, renalOfPatient } from './renal-work'
import { addDays } from '@/utils/date'
import { examOfKey, imagingOf, isRadiologist, noShowOf, pendingImagingWork, type ImagingWorkItem } from './imaging-work'
import { find, nameOf } from './views'

export interface ExamView extends ImagingExam {
  stage: ExamStage
  stageLabel: string
  roomName: string
  procName: string
  patientName: string
  chartNo: string
  where: string
  end: string
  doneByName?: string
  /** 過了排程 30 分鐘還沒報到 */
  noShow: boolean
  /** 檢查前準備（主檔）與確認狀態：ok 沒有＝還沒確認 */
  prepItems: { id: string; label: string; ok?: boolean; note?: string }[]
  /** 含顯影劑：腎功能判斷（還沒做完的才算） */
  contrast?: ReturnType<typeof contrastCheck> & { renal: string }
  safety: ContrastSafety
  metforminAlertText?: string
}
/** 這筆檢查的顯影劑腎功能判斷 */
const contrastOf = (e: Pick<ImagingExam, 'procId' | 'patientId' | 'admissionId'>) => {
  if (!imagingOf(e.procId)?.contrast) return undefined
  const r = renalOfPatient(e.patientId, e.admissionId)
  return { ...contrastCheck(r.crcl), renal: r.text }
}
const prepDefs = (procId: string) => imagingOf(procId)?.prep ?? []

/** 這筆影像（key）最近一次的顯影劑過敏放行 */
const clearanceOf = (key: string) => db.contrastClearances.filter((c) => c.key === key).at(-1)
const isMetformin = (drugId?: string) => /metformin/i.test(find.drug(drugId ?? '')?.name ?? '')
/** 有沒有在用 Metformin：住院＝執行中的醫囑；門診＝處方還在服藥期間 */
function onMetformin(patientId: string, admissionId?: string, t: string = now()): boolean {
  if (admissionId) return db.ipdOrders.some((o) => o.admissionId === admissionId && o.status === 'active' && o.category === 'medication' && isMetformin(o.drugId))
  return db.encounters.some((e) => e.patientId === patientId && e.status === 'completed' && e.medications.some((m) => isMetformin(m.drugId) && addDays(e.date, m.days) >= t.slice(0, 10)))
}
export interface ContrastSafety {
  /** 顯影劑過敏（過敏紀錄那一筆）與放行紀錄 */
  allergy?: { text: string; cleared?: { byName: string; at: string; reason: string } }
  /** Metformin 提醒文字 */
  metformin?: string
  /** 住院、要水化、有體重：建議的水化醫囑 */
  hydration?: { rateMlH: number; volumeMl: number; text: string }
}
/** 含顯影劑的這一筆：過敏、Metformin、水化建議 */
function safetyOf(x: { key: string; procId: string; patientId: string; admissionId?: string }): ContrastSafety {
  if (!imagingOf(x.procId)?.contrast) return {}
  const out: ContrastSafety = {}
  const al = contrastAllergy(find.patient(x.patientId)?.allergies)
  if (al) {
    const c = clearanceOf(x.key)
    out.allergy = { text: al, ...(c ? { cleared: { byName: nameOf.user(c.by), at: c.at, reason: c.reason } } : {}) }
  }
  const r = renalOfPatient(x.patientId, x.admissionId)
  if (onMetformin(x.patientId, x.admissionId) && metforminAtRisk(r.crcl)) out.metformin = metforminText(r.crcl)
  const w = x.admissionId ? latestWeight(x.admissionId) : undefined
  if (x.admissionId && w && contrastCheck(r.crcl).level === 'hydrate') {
    const rate = hydrationRate(w.kg)
    out.hydration = { rateMlH: rate, volumeMl: HYDRATION.volumeMl, text: `生理食鹽水 ${HYDRATION.volumeMl} mL，${rate} mL/hr（${HYDRATION.mlPerKgH} mL/kg/hr，${w.kg} kg），檢查前後` }
  }
  return out
}
function view(e: ImagingExam): ExamView {
  const st = examStage(e)
  const a = e.admissionId ? find.admission(e.admissionId) : undefined
  const bed = a?.bedId ? find.bed(a.bedId) : undefined
  const p = find.patient(e.patientId)
  return {
    ...e, stage: st, stageLabel: EXAM_STAGE_LABEL[st], roomName: examRoomName(e.room), procName: find.procedure(e.procId)?.name ?? e.procId,
    patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', where: bed ? `${bed.ward} ${bed.bedNo}` : '門診', end: addMinutes(e.start, e.minutes),
    ...(e.doneBy ? { doneByName: nameOf.user(e.doneBy) } : {}),
    noShow: examNoShow(e, now()), ...(examNoShow(e, now()) ? { stageLabel: '未到' } : {}),
    prepItems: prepDefs(e.procId).map((d) => ({ ...d, ...(e.prep?.[d.id] ? { ok: e.prep[d.id].ok, ...(e.prep[d.id].note ? { note: e.prep[d.id].note } : {}) } : {}) })),
    ...(!e.doneAt && contrastOf(e) ? { contrast: contrastOf(e) } : {}),
    safety: e.doneAt ? {} : safetyOf(e),
    ...(e.metforminAlert ? { metforminAlertText: `暫停 Metformin 到 ${e.metforminAlert.until.slice(5)}（${METFORMIN_HOLD_HOURS} 小時），複查腎功能再恢復${e.metforminAlert.ackAt ? `；${nameOf.user(e.metforminAlert.ackBy!)} 已處理` : ''}` } : {}),
  }
}
/** 還有效的檢查（取消的不算） */
const liveExams = () => db.imagingExams.filter((e) => !e.cancelled)

/** 排程與檢查室操作：掛號批價（櫃台）或放射科醫師 */
function requireExamStaff() {
  const u = requireUser('clerk', 'doctor')
  if (sessionRole() === 'doctor' && !isRadiologist(u.doctorId)) fail('影像檢查排程由櫃台或放射科處理', 'FORBIDDEN')
  return u
}

export interface ExamBoard {
  date: string
  canSchedule: boolean
  /** 待排程：還沒做、也還沒排的影像（舊的在前） */
  toSchedule: (ImagingWorkItem & { room: string; roomName: string; minutes: number; prep: string[]; contrast?: ExamView['contrast']; safety: ContrastSafety; cancelledReason?: string })[]
  /** 放射科醫師可以放行顯影劑過敏 */
  canClear: boolean
  rooms: { room: string; name: string; exams: ExamView[] }[]
}

export function examBoard(date: string): Promise<ExamBoard> {
  return query(() => {
    requireUser('clerk', 'doctor', 'nurse')
    const u = sessionUser()
    const toSchedule = pendingImagingWork()
      .filter((w) => w.awaitingExam && !examOfKey(w.key))
      .map((w) => {
        const im = imagingOf(w.procId)
        const room = im?.room ?? 'XR'
        const admissionId = w.source === 'ipd' ? db.ipdOrders.find((o) => `O:${o.id}` === w.key)?.admissionId : undefined
        const c = contrastOf({ procId: w.procId, patientId: w.patientId, admissionId })
        const lastCancel = db.imagingExams.filter((e) => e.key === w.key && e.cancelled).sort((a, b) => a.cancelled!.at.localeCompare(b.cancelled!.at)).at(-1)
        return { ...w, room, roomName: examRoomName(room), minutes: im?.minutes ?? 10, prep: (im?.prep ?? []).map((p) => p.label), ...(c ? { contrast: c } : {}), safety: safetyOf({ key: w.key, procId: w.procId, patientId: w.patientId, admissionId }), ...(lastCancel ? { cancelledReason: lastCancel.cancelled!.reason } : {}) }
      })
    return {
      date,
      canSchedule: sessionRole() === 'clerk' || (sessionRole() === 'doctor' && isRadiologist(u?.doctorId)),
      canClear: sessionRole() === 'doctor' && isRadiologist(u?.doctorId),
      toSchedule,
      rooms: EXAM_ROOMS.map((r) => ({ room: r.id, name: r.name, exams: liveExams().filter((e) => e.room === r.id && e.start.slice(0, 10) === date).sort((x, y) => x.start.localeCompare(y.start)).map(view) })),
    }
  })
}

/** 排程（或改時間：還沒報到的）：檢查室依醫令決定，同一間撞期擋、開放時段內、不能排過去 */
export function scheduleExam(key: string, start: string): Promise<ExamView> {
  return mutate(() => {
    const u = requireExamStaff()
    const w = pendingImagingWork().find((x) => x.key === key)
    if (!w) fail('找不到這筆影像（可能已判讀、已停止），請重新整理', 'CONFLICT')
    const im = imagingOf(w!.procId)
    const room = im?.room ?? 'XR'
    const minutes = im?.minutes ?? 10
    const t = now()
    const old = examOfKey(key)
    const wasNoShow = !!old && examNoShow(old, t)
    if (old && old.arrivedAt) fail(`已經${old.doneAt ? '做完' : '報到'}，不能改時間`, 'CONFLICT')
    failFields(checkExamSlot(start, minutes, t))
    const clash = examClash(liveExams().filter((e) => !e.doneAt || e.start >= t.slice(0, 10)), { id: old?.id, room, start, minutes })
    if (clash) fail(`${examRoomName(room)}這個時段已排 ${nameOf.patient(clash.patientId)} ${clash.start.slice(11)}–${addMinutes(clash.start, clash.minutes).slice(11)}`, 'CONFLICT', 'start')
    const [kind, a] = key.split(':')
    const o = kind === 'O' ? db.ipdOrders.find((x) => x.id === a) : undefined
    const e: ImagingExam = old ?? { id: newId('EX'), key, patientId: w!.patientId, procId: w!.procId, ...(o ? { orderId: o.id, admissionId: o.admissionId } : {}), room, start, minutes, scheduledBy: u.id, scheduledAt: t }
    Object.assign(e, { start, scheduledBy: u.id, scheduledAt: t })
    if (!old) db.imagingExams.push(e)
    audit(old ? '影像檢查改時間' : '影像檢查排程', `${w!.patientName} ${w!.procName}：${examRoomName(room)} ${start}${wasNoShow ? '（未到改期）' : ''}`)
    return view(e)
  })
}

const examById = (id: string) => must(db.imagingExams.find((x) => x.id === id), '影像檢查')

/** 報到（病人到檢查室） */
export function arriveExam(id: string): Promise<ExamView> {
  return mutate(() => {
    const u = requireExamStaff()
    const e = examById(id)
    if (e.cancelled) fail('這筆檢查已取消', 'CONFLICT')
    if (e.arrivedAt) fail('已經報到了', 'CONFLICT')
    const al = imagingOf(e.procId)?.contrast ? contrastAllergy(find.patient(e.patientId)?.allergies) : undefined
    if (al && !clearanceOf(e.key)) fail(`病人對顯影劑過敏（${al}）：要開立醫師（或主治、放射科）確認已開前置用藥並放行後才能報到`, 'CONFLICT')
    Object.assign(e, { arrivedAt: now(), arrivedBy: u.id })
    audit('影像檢查報到', `${nameOf.patient(e.patientId)} ${find.procedure(e.procId)?.name}`)
    return view(e)
  })
}

/** 檢查完成：要先報到；住院的臨時醫囑一起完成。完成後進判讀清單 */
export function completeExam(id: string): Promise<ExamView> {
  return mutate(() => {
    const u = requireExamStaff()
    const e = examById(id)
    if (!e.arrivedAt) fail('病人還沒報到', 'CONFLICT')
    if (e.doneAt) fail('已經完成了', 'CONFLICT')
    const miss = examPrepMissing(prepDefs(e.procId), e.prep)
    if (miss.length) fail(`檢查前準備還沒完成：${miss.map((d) => d.label).join('、')}（沒辦法完成的請取消、改期）`, 'CONFLICT')
    const c = contrastOf(e)
    if (c?.level === 'block') fail(c.text, 'CONFLICT')
    const t = now()
    Object.assign(e, { doneAt: t, doneBy: u.id })
    const o = e.orderId ? db.ipdOrders.find((x) => x.id === e.orderId) : undefined
    if (o && o.status === 'active') Object.assign(o, { status: 'done', stopAt: t })
    // 含顯影劑＋Metformin＋腎功能不好：主治首頁提醒暫停 48 小時
    if (e.admissionId && c && onMetformin(e.patientId, e.admissionId, t) && metforminAtRisk(renalOfPatient(e.patientId, e.admissionId, t).crcl)) {
      e.metforminAlert = { doctorId: must(find.admission(e.admissionId), '住院').doctorId, until: addMinutes(t, METFORMIN_HOLD_HOURS * 60) }
    }
    audit('影像檢查完成', `${nameOf.patient(e.patientId)} ${find.procedure(e.procId)?.name}（${examRoomName(e.room)}）`)
    return view(e)
  })
}

/** 取消（寫原因）：還沒做完的才能取消；影像回到待排程（住院醫囑照樣執行中） */
export function cancelExam(id: string, reason: string): Promise<ExamView> {
  return mutate(() => {
    const u = requireExamStaff()
    const e = examById(id)
    if (e.cancelled) fail('已經取消了', 'CONFLICT')
    if (e.doneAt) fail('已經做完，不能取消', 'CONFLICT')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫取消原因（例：病人未禁食、病人拒絕、改期）')
    e.cancelled = { at: now(), by: u.id, reason: why! }
    audit('影像檢查取消', `${nameOf.patient(e.patientId)} ${find.procedure(e.procId)?.name} ${e.start}（${why}）`)
    return view(e)
  })
}

/** 報到後確認檢查前準備（逐項）：沒完成要寫原因；腎功能那一項看 CrCl（< 30 不能確認） */
export function confirmExamPrep(id: string, item: string, ok: boolean, note?: string): Promise<ExamView> {
  return mutate(() => {
    const u = requireExamStaff()
    const e = examById(id)
    if (e.cancelled) fail('這筆檢查已取消', 'CONFLICT')
    if (!e.arrivedAt) fail('病人報到後才確認檢查前準備', 'CONFLICT')
    if (e.doneAt) fail('已經做完了', 'CONFLICT')
    const d = prepDefs(e.procId).find((x) => x.id === item)
    if (!d) fail('這項檢查沒有這個準備項目')
    let n = note?.trim()
    if (!ok && !n) failField('note', '沒完成請寫原因（例：早上 8 點吃過早餐）')
    if (ok && item === 'renal') {
      const c = contrastOf(e)!
      if (c.level === 'block') fail(c.text, 'CONFLICT')
      n = `${c.renal}${c.level === 'hydrate' ? '；已提醒水化' : c.level === 'unknown' ? '；腎功能已另行確認' : ''}`
    }
    ;(e.prep ??= {})[item] = { ok, at: now(), by: u.id, ...(n ? { note: n } : {}) }
    audit(ok ? '檢查前準備確認' : '檢查前準備未完成', `${nameOf.patient(e.patientId)} ${find.procedure(e.procId)?.name}：${d!.label}${n ? `（${n}）` : ''}`)
    return view(e)
  })
}

/** 顯影劑過敏放行：開立醫師（住院另含主治）或放射科醫師確認已開前置用藥（類固醇＋抗組織胺）並寫原因 */
export function clearContrastAllergy(key: string, input: { reason: string; premed: boolean }): Promise<ContrastClearance> {
  return mutate(() => {
    const u = requireUser('doctor')
    const w = pendingImagingWork().find((x) => x.key === key)
    if (!w) fail('找不到這筆影像（可能已判讀、已停止），請重新整理', 'CONFLICT')
    if (!imagingOf(w!.procId)?.contrast) fail('這項檢查不打顯影劑', 'CONFLICT')
    const al = contrastAllergy(find.patient(w!.patientId)?.allergies)
    if (!al) fail('病人沒有顯影劑過敏紀錄', 'CONFLICT')
    const o = key.startsWith('O:') ? db.ipdOrders.find((x) => `O:${x.id}` === key) : undefined
    const attending = o ? find.admission(o.admissionId)?.doctorId : undefined
    if (w!.doctorId !== u.doctorId && attending !== u.doctorId && !isRadiologist(u.doctorId)) fail('只有開立醫師、主治醫師或放射科醫師能放行', 'FORBIDDEN')
    const why = input?.reason?.trim()
    failFields({ ...(why ? {} : { reason: '請寫放行原因（例：檢查必要、已開 Methylprednisolone＋Diphenhydramine）' }), ...(input?.premed ? {} : { premed: '要先開前置用藥（類固醇＋抗組織胺）' }) })
    const c: ContrastClearance = { id: newId('CC'), key, patientId: w!.patientId, by: u.id, at: now(), reason: why! }
    db.contrastClearances.push(c)
    audit('顯影劑過敏放行', `${w!.patientName} ${w!.procName}（過敏：${al}）：${why}`)
    return c
  })
}

/** 主治：做完含顯影劑檢查、要暫停 Metformin 的提醒（還沒處理的） */
export function myMetforminAlerts(): Promise<ExamView[]> {
  return query(() => {
    const u = requireUser('doctor')
    return db.imagingExams.filter((e) => e.metforminAlert && !e.metforminAlert.ackAt && e.metforminAlert.doctorId === u.doctorId).map(view)
  })
}

/** 主治按「已處理」（已暫停 Metformin、安排複查腎功能） */
export function ackMetforminAlert(id: string): Promise<ExamView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const e = examById(id)
    if (!e.metforminAlert) fail('這筆檢查沒有 Metformin 提醒', 'CONFLICT')
    if (e.metforminAlert!.ackAt) fail('已經處理過了', 'CONFLICT')
    if (e.metforminAlert!.doctorId !== u.doctorId) fail('由主治醫師處理', 'FORBIDDEN')
    Object.assign(e.metforminAlert!, { ackAt: now(), ackBy: u.id })
    audit('Metformin 暫停提醒已處理', `${nameOf.patient(e.patientId)} ${find.procedure(e.procId)?.name}`)
    return view(e)
  })
}

/** 門診開立醫師：我開的影像病人沒來（未到，還沒改期或取消） */
export function myNoShowExams(): Promise<ExamView[]> {
  return query(() => {
    const u = requireUser('doctor')
    return noShowOf(u.doctorId).map(view)
  })
}

/** 護理站：這位住院病人排了哪些檢查（還沒做完的）、和給藥時間的衝突 */
export function admissionExams(admissionId: string): Promise<{ admissionId: string; exams: (ExamView & { marConflicts: string[] })[]; unscheduled: string[]; metforminAlerts: ExamView[] }> {
  return query(() => {
    requireUser('nurse', 'doctor')
    const pending = db.mar.filter((m) => m.admissionId === admissionId && m.status === 'pending').map((m) => m.scheduledAt)
    const exams = liveExams().filter((e) => e.admissionId === admissionId && !e.doneAt).sort((a, b) => a.start.localeCompare(b.start)).map((e) => ({ ...view(e), marConflicts: marConflicts(e, pending) }))
    const unscheduled = pendingImagingWork().filter((w) => w.key.startsWith('O:') && w.awaitingExam && !examOfKey(w.key) && db.ipdOrders.find((o) => o.id === w.key.slice(2))?.admissionId === admissionId).map((w) => w.procName)
    const metforminAlerts = db.imagingExams.filter((e) => e.admissionId === admissionId && e.metforminAlert && !e.metforminAlert.ackAt).map(view)
    return { admissionId, exams, unscheduled, metforminAlerts }
  })
}
