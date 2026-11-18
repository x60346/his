// 影像檢查排程與檢查室：影像醫令（門診批價後、住院開立後）進「待排程」；櫃台（或放射科醫師）排檢查室與時間（同一間撞期擋、
// 開放時段 08:00–17:00）→ 檢查室清單依序「報到」→「完成」（住院的臨時醫囑一起完成），完成後才進判讀清單。
// 住院排好的檢查，護理站看得到幾點去做、和給藥時間衝突的標出來。規則在 exam-rules
import type { ImagingExam } from '@/types'
import { db, newId } from '@/mock/db'
import { addMinutes, now } from '@/utils/date'
import { audit, fail, failFields, must, mutate, query, requireUser, sessionRole, sessionUser } from './http'
import { checkExamSlot, examClash, examRoomName, examStage, EXAM_ROOMS, EXAM_STAGE_LABEL, marConflicts, type ExamStage } from './exam-rules'
import { examOfKey, imagingOf, isRadiologist, pendingImagingWork, type ImagingWorkItem } from './imaging-work'
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
  }
}

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
  toSchedule: (ImagingWorkItem & { room: string; roomName: string; minutes: number })[]
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
        return { ...w, room, roomName: examRoomName(room), minutes: im?.minutes ?? 10 }
      })
    return {
      date,
      canSchedule: sessionRole() === 'clerk' || (sessionRole() === 'doctor' && isRadiologist(u?.doctorId)),
      toSchedule,
      rooms: EXAM_ROOMS.map((r) => ({ room: r.id, name: r.name, exams: db.imagingExams.filter((e) => e.room === r.id && e.start.slice(0, 10) === date).sort((x, y) => x.start.localeCompare(y.start)).map(view) })),
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
    if (old && old.arrivedAt) fail(`已經${old.doneAt ? '做完' : '報到'}，不能改時間`, 'CONFLICT')
    failFields(checkExamSlot(start, minutes, t))
    const clash = examClash(db.imagingExams.filter((e) => !e.doneAt || e.start >= t.slice(0, 10)), { id: old?.id, room, start, minutes })
    if (clash) fail(`${examRoomName(room)}這個時段已排 ${nameOf.patient(clash.patientId)} ${clash.start.slice(11)}–${addMinutes(clash.start, clash.minutes).slice(11)}`, 'CONFLICT', 'start')
    const [kind, a] = key.split(':')
    const o = kind === 'O' ? db.ipdOrders.find((x) => x.id === a) : undefined
    const e: ImagingExam = old ?? { id: newId('EX'), key, patientId: w!.patientId, procId: w!.procId, ...(o ? { orderId: o.id, admissionId: o.admissionId } : {}), room, start, minutes, scheduledBy: u.id, scheduledAt: t }
    Object.assign(e, { start, scheduledBy: u.id, scheduledAt: t })
    if (!old) db.imagingExams.push(e)
    audit(old ? '影像檢查改時間' : '影像檢查排程', `${w!.patientName} ${w!.procName}：${examRoomName(room)} ${start}`)
    return view(e)
  })
}

const examById = (id: string) => must(db.imagingExams.find((x) => x.id === id), '影像檢查')

/** 報到（病人到檢查室） */
export function arriveExam(id: string): Promise<ExamView> {
  return mutate(() => {
    const u = requireExamStaff()
    const e = examById(id)
    if (e.arrivedAt) fail('已經報到了', 'CONFLICT')
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
    const t = now()
    Object.assign(e, { doneAt: t, doneBy: u.id })
    const o = e.orderId ? db.ipdOrders.find((x) => x.id === e.orderId) : undefined
    if (o && o.status === 'active') Object.assign(o, { status: 'done', stopAt: t })
    audit('影像檢查完成', `${nameOf.patient(e.patientId)} ${find.procedure(e.procId)?.name}（${examRoomName(e.room)}）`)
    return view(e)
  })
}

/** 護理站：這位住院病人排了哪些檢查（還沒做完的）、和給藥時間的衝突 */
export function admissionExams(admissionId: string): Promise<{ admissionId: string; exams: (ExamView & { marConflicts: string[] })[]; unscheduled: string[] }> {
  return query(() => {
    requireUser('nurse', 'doctor')
    const pending = db.mar.filter((m) => m.admissionId === admissionId && m.status === 'pending').map((m) => m.scheduledAt)
    const exams = db.imagingExams.filter((e) => e.admissionId === admissionId && !e.doneAt).sort((a, b) => a.start.localeCompare(b.start)).map((e) => ({ ...view(e), marConflicts: marConflicts(e, pending) }))
    const unscheduled = pendingImagingWork().filter((w) => w.key.startsWith('O:') && w.awaitingExam && !examOfKey(w.key) && db.ipdOrders.find((o) => o.id === w.key.slice(2))?.admissionId === admissionId).map((w) => w.procName)
    return { admissionId, exams, unscheduled }
  })
}
