// 影像檢查排程與檢查室：影像醫令（門診批價後、住院開立後）進「待排程」；櫃台（或放射科醫師）排檢查室與時間（同一間撞期擋、
// 開放時段 08:00–17:00）→ 檢查室清單依序「報到」→「完成」（住院的臨時醫囑一起完成），完成後才進判讀清單。
// 住院排好的檢查，護理站看得到幾點去做、和給藥時間衝突的標出來。
// 取消（寫原因）回到待排程；過了排程 30 分鐘沒報到標「未到」（可以改時間；門診的開立醫師首頁看得到）。
// 檢查前準備（主檔：腹部超音波禁食 6 小時、含顯影劑 CT 要同意書與腎功能）報到時逐項確認，沒完成不能做；
// 顯影劑看 CrCl：< 30 擋、30–45 提醒水化（住院醫師可一鍵開水化醫囑，ipd.orderContrastHydration）、算不出提醒先確認；
// 顯影劑過敏：開立醫師（住院另含主治、放射科）確認已開前置用藥並寫原因才放行報到；
// 有在用 Metformin 且 CrCl < 45（或算不出）：排程、報到時提醒，住院做完後主治首頁「暫停 Metformin 48 小時」要按已處理。規則在 exam-rules
import type { AdrReport, ContrastClearance, ExamClosure, ExamRoomHours, ImagingExam, RoomDowntime } from '@/types'
import { db, newId } from '@/mock/db'
import { examConsentOk } from './consent-rules'
import { addMinutes, now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser, sessionRole, sessionUser } from './http'
import { checkExamSlot, contrastAllergy, contrastCheck, hydrationRate, HYDRATION, metforminAtRisk, metforminText, METFORMIN_HOLD_HOURS, examClash, examNoShow, examRoomName, examStage, EXAM_ROOMS, EXAM_STAGE_LABEL, marConflicts, examPrepMissing, type ExamStage, checkContrastDone, CONTRAST_AGENT, CONTRAST_REACTION_LABEL, contrastReactionReportable, type ContrastReactionSeverity, checkDowntime, downtimeClash, downtimeEnd, downtimeHours, downtimeNow, downtimeText, nextFreeSlot, DOWNTIME_REASON_LABEL, type DowntimeReason, examDayOf, examDayText, outOfHours, checkExamHours, WEEKDAY_LABEL, EXAM_DAY } from './exam-rules'
import { ADR_SEVERITY_LABEL } from './adr-rules'
import { latestWeight, renalOfPatient } from './renal-work'
import { addDays } from '@/utils/date'
import { examOfKey, imagingOf, isRadiologist, noShowOf, pendingImagingWork, type ImagingWorkItem } from './imaging-work'
import { find, nameOf } from './views'
import { mriRiskOf } from './implant-work'

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
  /** 還沒報到、排在停機時段裡：要改期（停機的說明） */
  downtimeClash?: string
}
/** 有效的停機（提早結束成零長度的不算） */
const liveDowntimes = () => db.roomDowntimes.filter((d) => downtimeEnd(d) > d.from)
/** 某間某天的開放時段（設定＋休診日） */
const dayOf = (room: ImagingExam['room'], date: string) => examDayOf(db.examHours, db.examClosures, room, date)
/** 已排、還沒報到的為什麼要改期：碰到停機，或不在開放時段（時段改了、休診） */
function rescheduleWhy(e: ImagingExam): string | undefined {
  const d = downtimeClash(liveDowntimes(), e)
  if (d) return downtimeText(d)
  const why = outOfHours(e.start, e.minutes, dayOf(e.room, e.start.slice(0, 10)))
  return why ? `${why}` : undefined
}
/** 開放時段由管理員或放射科醫師設定 */
const canEditHours = () => sessionRole() === 'admin' || (sessionRole() === 'doctor' && isRadiologist(sessionUser()?.doctorId))
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
    ...(!e.arrivedAt && !e.cancelled ? ((why) => (why ? { downtimeClash: `${examRoomName(e.room)}${why}，請改期` } : {}))(rescheduleWhy(e)) : {}),
    ...(e.metforminAlert ? { metforminAlertText: `暫停 Metformin 到 ${e.metforminAlert.until.slice(5)}（${METFORMIN_HOLD_HOURS} 小時），複查腎功能再恢復${e.metforminAlert.ackAt ? `；${nameOf.user(e.metforminAlert.ackBy!)} 已處理` : ''}` } : {}),
  }
}
/** 還有效的檢查（取消的不算） */
const liveExams = () => db.imagingExams.filter((e) => !e.cancelled)

/**
 * 檢查室的分工：排程＝櫃台（放射科醫師支援）；報到、取消＝櫃台或放射師（放射科醫師支援）；
 * 確認檢查前準備、完成檢查＝放射師（放射科醫師支援）。其他科醫師、護理師只能看
 */
const isRadDoctor = (u: { doctorId?: string }) => sessionRole() === 'doctor' && isRadiologist(u.doctorId)
function requireScheduler() {
  const u = requireUser('clerk', 'doctor')
  if (sessionRole() === 'doctor' && !isRadDoctor(u)) fail('影像檢查排程由櫃台或放射科處理', 'FORBIDDEN')
  return u
}
function requireFrontDesk() {
  const u = requireUser('clerk', 'radtech', 'doctor')
  if (sessionRole() === 'doctor' && !isRadDoctor(u)) fail('影像檢查報到、取消由櫃台或放射科處理', 'FORBIDDEN')
  return u
}
function requireTech() {
  const u = requireUser('radtech', 'doctor')
  if (sessionRole() === 'doctor' && !isRadDoctor(u)) fail('檢查前準備與完成檢查由放射師處理（放射科醫師可支援）', 'FORBIDDEN')
  return u
}

export interface ExamBoard {
  date: string
  canSchedule: boolean
  /** 報到、取消（櫃台、放射師、放射科醫師） */
  canArrive: boolean
  /** 確認準備、完成（放射師、放射科醫師）；也能登記停機 */
  canPerform: boolean
  /** 開放時段：管理員、放射科醫師可以改 */
  canEditHours: boolean
  /** 停機：各檢查室這天碰到的（含現在停機中）、近 30 天停機時數、需改期的筆數 */
  downtimes: DowntimeView[]
  downtimeStats: ReturnType<typeof downtimeHours>
  needsReschedule: number
  /** 待排程：還沒做、也還沒排的影像（舊的在前） */
  toSchedule: (ImagingWorkItem & { room: string; roomName: string; minutes: number; prep: string[]; contrast?: ExamView['contrast']; safety: ContrastSafety; cancelledReason?: string })[]
  /** 放射科醫師可以放行顯影劑過敏 */
  canClear: boolean
  rooms: { room: string; name: string; hoursText: string; exams: ExamView[] }[]
}

export function examBoard(date: string): Promise<ExamBoard> {
  return query(() => {
    requireUser('clerk', 'radtech', 'doctor', 'nurse')
    const u = sessionUser()
    const radDoc = sessionRole() === 'doctor' && isRadiologist(u?.doctorId)
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
      canSchedule: sessionRole() === 'clerk' || radDoc,
      canArrive: sessionRole() === 'clerk' || sessionRole() === 'radtech' || radDoc,
      canPerform: sessionRole() === 'radtech' || radDoc,
      canClear: sessionRole() === 'doctor' && isRadiologist(u?.doctorId),
      toSchedule,
      canEditHours: canEditHours(),
      rooms: EXAM_ROOMS.map((r) => ({ room: r.id, name: r.name, hoursText: examDayText(dayOf(r.id, date)), exams: liveExams().filter((e) => e.room === r.id && e.start.slice(0, 10) === date).sort((x, y) => x.start.localeCompare(y.start)).map(view) })),
      downtimes: liveDowntimes().filter((d) => d.from.slice(0, 10) <= date && downtimeEnd(d).slice(0, 10) >= date).sort((a, b) => a.from.localeCompare(b.from)).map((d) => dtView(d)),
      downtimeStats: downtimeHours(db.roomDowntimes, `${addDays(now().slice(0, 10), -30)} 00:00`, now()),
      needsReschedule: needsReschedule().length,
    }
  })
}

/** 排程（或改時間：還沒報到的）：檢查室依醫令決定，同一間撞期擋、開放時段內、不能排過去 */
export function scheduleExam(key: string, start: string, opts: { mriReason?: string } = {}): Promise<ExamView> {
  return mutate(() => {
    const u = requireScheduler()
    const w = pendingImagingWork().find((x) => x.key === key)
    if (!w) fail('找不到這筆影像（可能已判讀、已停止），請重新整理', 'CONFLICT')
    const im = imagingOf(w!.procId)
    const room = im?.room ?? 'XR'
    const minutes = im?.minutes ?? 10
    const t = now()
    const old = examOfKey(key)
    const wasNoShow = !!old && examNoShow(old, t)
    if (old && old.arrivedAt) fail(`已經${old.doneAt ? '做完' : '報到'}，不能改時間`, 'CONFLICT')
    failFields(checkExamSlot(start, minutes, t, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(start ?? '') ? dayOf(room, start.slice(0, 10)) : undefined))
    const clash = examClash(liveExams().filter((e) => !e.doneAt || e.start >= t.slice(0, 10)), { id: old?.id, room, start, minutes })
    const dc = downtimeClash(liveDowntimes(), { room, start, minutes })
    if (dc) fail(`${examRoomName(room)}這段時間停機（${downtimeText(dc)}）`, 'CONFLICT', 'start')
    if (clash) fail(`${examRoomName(room)}這個時段已排 ${nameOf.patient(clash.patientId)} ${clash.start.slice(11)}–${addMinutes(clash.start, clash.minutes).slice(11)}`, 'CONFLICT', 'start')
    // 磁振造影：病人身上有 MRI 不安全的植入物 → 要放射科醫師寫理由才能排；有條件的記在檢查上（報到、做的時候看得到）
    const risk = room === 'MR' ? mriRiskOf(w!.patientId) : undefined
    let mri: ImagingExam['mri']
    if (risk?.level === 'unsafe') {
      if (old?.mri?.clearedBy) mri = old.mri
      else {
        if (!isRadDoctor(u)) fail(`病人身上有 MRI 不安全的植入物：${risk.items.join('、')}。請放射科醫師確認後排程`, 'CONFLICT', 'mriReason')
        if (!opts.mriReason?.trim()) failField('mriReason', `病人身上有 MRI 不安全的植入物（${risk.items.join('、')}）：請寫確認結果（例：已確認為 MRI 相容型號）`)
        mri = { level: 'unsafe', items: risk.items, clearedBy: u.id, reason: opts.mriReason!.trim() }
      }
    } else if (risk?.level === 'conditional') mri = { level: 'conditional', items: risk.items }
    const [kind, a] = key.split(':')
    const o = kind === 'O' ? db.ipdOrders.find((x) => x.id === a) : undefined
    const e: ImagingExam = old ?? { id: newId('EX'), key, patientId: w!.patientId, procId: w!.procId, ...(o ? { orderId: o.id, admissionId: o.admissionId } : {}), room, start, minutes, scheduledBy: u.id, scheduledAt: t }
    Object.assign(e, { start, scheduledBy: u.id, scheduledAt: t, ...(mri ? { mri } : {}) })
    if (!old) db.imagingExams.push(e)
    audit(old ? '影像檢查改時間' : '影像檢查排程', `${w!.patientName} ${w!.procName}：${examRoomName(room)} ${start}${wasNoShow ? '（未到改期）' : ''}${mri ? `；${mri.level === 'unsafe' ? `MRI 不安全植入物，放射科確認：${mri.reason}` : `MRI 有條件植入物：${mri.items.join('、')}`}` : ''}`)
    return view(e)
  })
}

const examById = (id: string) => must(db.imagingExams.find((x) => x.id === id), '影像檢查')

export interface DowntimeView extends RoomDowntime {
  roomName: string
  text: string
  /** 現在停機中 */
  active: boolean
  byName: string
  /** 排在這段、還沒報到的檢查 */
  clashes: number
}
function dtView(d: RoomDowntime, t: string = now()): DowntimeView {
  return {
    ...d, roomName: examRoomName(d.room), text: downtimeText(d), active: d.from <= t && t < downtimeEnd(d), byName: nameOf.user(d.by),
    clashes: liveExams().filter((e) => !e.arrivedAt && downtimeClash([d], e)).length,
  }
}
/** 排在停機時段、還沒報到的（需改期） */
const needsReschedule = () => liveExams().filter((e) => !e.arrivedAt && !!rescheduleWhy(e))

/** 登記停機（放射師、放射科醫師）：檢查室、起訖、原因（故障、保養）；之後這段排不進去、不能報到，已排的列「需改期」 */
export function addDowntime(input: { room: ImagingExam['room']; from: string; to: string; reason: DowntimeReason; note?: string }): Promise<DowntimeView> {
  return mutate(() => {
    const u = requireTech()
    const t = now()
    failFields(checkDowntime(input ?? {}, t))
    const d: RoomDowntime = { id: newId('DT'), room: input.room, from: input.from, to: input.to, reason: input.reason, ...(input.note?.trim() ? { note: input.note.trim() } : {}), by: u.id, at: t }
    db.roomDowntimes.push(d)
    const v = dtView(d, t)
    audit('檢查室停機', `${v.roomName} ${v.text}${d.note ? `（${d.note}）` : ''}${v.clashes ? `；${v.clashes} 筆檢查需改期` : ''}`)
    return v
  })
}

/** 提早結束停機（修好了）：還沒開始的＝取消 */
export function endDowntime(id: string): Promise<DowntimeView> {
  return mutate(() => {
    const u = requireTech()
    const d = must(db.roomDowntimes.find((x) => x.id === id), '停機紀錄')
    const t = now()
    if (downtimeEnd(d) <= t) fail('這段停機已經結束了', 'CONFLICT')
    Object.assign(d, { endedAt: t < d.from ? d.from : t, endedBy: u.id })
    audit('檢查室停機結束', `${examRoomName(d.room)} ${DOWNTIME_REASON_LABEL[d.reason]}${t < d.from ? '（取消）' : `（提早到 ${t.slice(11)} 結束）`}`)
    return dtView(d, t)
  })
}

/** 一鍵排到下一個空檔（櫃台、放射科醫師）：停機結束（或現在）之後，同一間沒撞期、沒停機的第一個時段 */
export function rescheduleNext(id: string): Promise<ExamView> {
  return mutate(() => {
    requireScheduler()
    const e = examById(id)
    if (e.cancelled) fail('這筆檢查已取消', 'CONFLICT')
    if (e.arrivedAt) fail('已經報到，不能改時間', 'CONFLICT')
    const t = now()
    const d = downtimeClash(liveDowntimes(), e)
    const after = [t, d ? downtimeEnd(d) : t].sort().at(-1)!
    const slot = nextFreeSlot(e.room, e.minutes, after, liveExams().filter((x) => !x.doneAt || x.start >= t.slice(0, 10)), liveDowntimes(), e.id, (date) => dayOf(e.room, date))
    if (!slot) fail('兩週內找不到空檔，請手動排', 'CONFLICT')
    const old = e.start
    Object.assign(e, { start: slot!, scheduledAt: t })
    audit('影像檢查改時間', `${nameOf.patient(e.patientId)} ${find.procedure(e.procId)?.name}：${old} → ${slot}（${d ? `${examRoomName(e.room)}${DOWNTIME_REASON_LABEL[d.reason]}` : '排到下一個空檔'}）`)
    return view(e)
  })
}

/** 報到（病人到檢查室） */
export function arriveExam(id: string): Promise<ExamView> {
  return mutate(() => {
    const u = requireFrontDesk()
    const e = examById(id)
    if (e.cancelled) fail('這筆檢查已取消', 'CONFLICT')
    if (e.arrivedAt) fail('已經報到了', 'CONFLICT')
    const down = downtimeNow(liveDowntimes(), e.room, now())
    if (down) fail(`${examRoomName(e.room)}停機中（${downtimeText(down)}），請改期`, 'CONFLICT')
    const al = imagingOf(e.procId)?.contrast ? contrastAllergy(find.patient(e.patientId)?.allergies) : undefined
    if (al && !clearanceOf(e.key)) fail(`病人對顯影劑過敏（${al}）：要開立醫師（或主治、放射科）確認已開前置用藥並放行後才能報到`, 'CONFLICT')
    Object.assign(e, { arrivedAt: now(), arrivedBy: u.id })
    audit('影像檢查報到', `${nameOf.patient(e.patientId)} ${find.procedure(e.procId)?.name}`)
    return view(e)
  })
}

export interface ExamDoneInput {
  /** 含顯影劑的要寫用量（mL） */
  contrastMl?: number
  /** 顯影劑不良反應（沒有就不填） */
  reaction?: { severity: ContrastReactionSeverity; symptoms: string; action: string }
}
/**
 * 檢查完成（放射師）：要先報到；住院的臨時醫囑一起完成。完成後進判讀清單。
 * 含顯影劑的記用量；有不良反應記嚴重度、症狀、處置——中度以上自動產生不良反應通報（懷疑物＝碘化顯影劑），送藥師評估
 */
export function completeExam(id: string, input: ExamDoneInput = {}): Promise<ExamView> {
  return mutate(() => {
    const u = requireTech()
    const e = examById(id)
    if (!e.arrivedAt) fail('病人還沒報到', 'CONFLICT')
    if (e.doneAt) fail('已經完成了', 'CONFLICT')
    failFields(checkContrastDone(input, !!imagingOf(e.procId)?.contrast))
    const miss = examPrepMissing(prepDefs(e.procId), e.prep)
    if (miss.length) fail(`檢查前準備還沒完成：${miss.map((d) => d.label).join('、')}（沒辦法完成的請取消、改期）`, 'CONFLICT')
    const c = contrastOf(e)
    if (c?.level === 'block') fail(c.text, 'CONFLICT')
    const t = now()
    Object.assign(e, { doneAt: t, doneBy: u.id, ...(input.contrastMl !== undefined ? { contrastMl: Number(input.contrastMl) } : {}) })
    if (input.reaction) {
      const rx = { severity: input.reaction.severity, symptoms: input.reaction.symptoms.trim(), action: input.reaction.action.trim(), at: t, by: u.id }
      if (contrastReactionReportable(rx.severity)) {
        const r: AdrReport = {
          id: newId('ADR'), ...(e.admissionId ? { admissionId: e.admissionId } : {}), patientId: e.patientId, drugId: '', agent: CONTRAST_AGENT, examId: e.id, onsetAt: t,
          symptoms: rx.symptoms, severity: rx.severity, ...(rx.severity === 'severe' ? { serious: 'anaphylaxis' as const } : {}), action: rx.action, reportedBy: u.id, reportedAt: t,
        }
        db.adrReports.push(r)
        e.contrastReaction = { ...rx, adrId: r.id }
        audit('藥物不良反應通報', `${nameOf.patient(e.patientId)}：${CONTRAST_AGENT} ${rx.symptoms}（${ADR_SEVERITY_LABEL[rx.severity]}${rx.severity === 'severe' ? '・過敏性休克' : ''}；${find.procedure(e.procId)?.name}，放射師通報）`)
      } else e.contrastReaction = rx
    }
    const o = e.orderId ? db.ipdOrders.find((x) => x.id === e.orderId) : undefined
    if (o && o.status === 'active') Object.assign(o, { status: 'done', stopAt: t })
    // 含顯影劑＋Metformin＋腎功能不好：主治首頁提醒暫停 48 小時
    if (e.admissionId && c && onMetformin(e.patientId, e.admissionId, t) && metforminAtRisk(renalOfPatient(e.patientId, e.admissionId, t).crcl)) {
      e.metforminAlert = { doctorId: must(find.admission(e.admissionId), '住院').doctorId, until: addMinutes(t, METFORMIN_HOLD_HOURS * 60) }
    }
    audit('影像檢查完成', `${nameOf.patient(e.patientId)} ${find.procedure(e.procId)?.name}（${examRoomName(e.room)}）${e.contrastMl ? `；顯影劑 ${e.contrastMl} mL` : ''}${e.contrastReaction ? `；不良反應 ${CONTRAST_REACTION_LABEL[e.contrastReaction.severity].split('（')[0]}：${e.contrastReaction.symptoms}` : ''}`)
    return view(e)
  })
}

/** 取消（寫原因）：還沒做完的才能取消；影像回到待排程（住院醫囑照樣執行中） */
export function cancelExam(id: string, reason: string): Promise<ExamView> {
  return mutate(() => {
    const u = requireFrontDesk()
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
    const u = requireTech()
    const e = examById(id)
    if (e.cancelled) fail('這筆檢查已取消', 'CONFLICT')
    if (!e.arrivedAt) fail('病人報到後才確認檢查前準備', 'CONFLICT')
    if (e.doneAt) fail('已經做完了', 'CONFLICT')
    const d = prepDefs(e.procId).find((x) => x.id === item)
    if (!d) fail('這項檢查沒有這個準備項目')
    let n = note?.trim()
    if (!ok && !n) failField('note', '沒完成請寫原因（例：早上 8 點吃過早餐）')
    // 同意書：要有這筆檢查、有效的檢查同意書紀錄（醫師說明後在病人「同意書」記錄）
    if (ok && item === 'consent' && !examConsentOk(db.consents, e.id)) fail('還沒有這筆檢查的同意書紀錄：請醫師說明後在病人資料「同意書」記錄簽署', 'CONFLICT')
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

export interface ExamHoursSettings {
  /** 每間、每週幾（0＝日）：開放時段；沒設定的是預設 */
  rows: { room: ImagingExam['room']; roomName: string; weekday: number; weekdayLabel: string; start?: string; end?: string; closed: boolean; isDefault: boolean }[]
  closures: (ExamClosure & { roomName: string; byName: string })[]
  canEdit: boolean
}
/** 開放時段設定（櫃台、放射師、醫師看；管理員、放射科醫師改） */
export function examHoursSettings(): Promise<ExamHoursSettings> {
  return query(() => {
    requireUser('clerk', 'radtech', 'doctor', 'nurse', 'admin')
    const t = now().slice(0, 10)
    return {
      rows: EXAM_ROOMS.flatMap((r) => [1, 2, 3, 4, 5, 6, 0].map((wd) => {
        const h = db.examHours.find((x) => x.room === r.id && x.weekday === wd)
        return { room: r.id, roomName: r.name, weekday: wd, weekdayLabel: WEEKDAY_LABEL[wd], ...(h && !h.closed ? { start: h.start, end: h.end } : !h ? { start: EXAM_DAY.start, end: EXAM_DAY.end } : {}), closed: !!h?.closed, isDefault: !h }
      })),
      closures: db.examClosures.filter((c) => c.date >= t).sort((a, b) => a.date.localeCompare(b.date)).map((c) => ({ ...c, roomName: c.room ? examRoomName(c.room) : '全部檢查室', byName: nameOf.user(c.by) })),
      canEdit: canEditHours(),
    }
  })
}
function requireHoursEditor() {
  const u = requireUser('admin', 'doctor')
  if (u.role === 'doctor' && !isRadiologist(u.doctorId)) fail('開放時段由放射科醫師或管理員設定', 'FORBIDDEN')
  return u
}
/** 改開放時段（整張表；和預設一樣的不存）：改了之後排在時段外的檢查列「需改期」 */
export function setExamHours(rows: ExamRoomHours[]): Promise<{ changed: number; needsReschedule: number }> {
  return mutate(() => {
    requireHoursEditor()
    failFields(checkExamHours(rows ?? []))
    const keep = rows.filter((r) => r.closed || r.start !== EXAM_DAY.start || r.end !== EXAM_DAY.end).map((r) => (r.closed ? { room: r.room, weekday: r.weekday, closed: true as const } : { room: r.room, weekday: r.weekday, start: r.start, end: r.end }))
    const before = JSON.stringify(db.examHours)
    db.examHours = keep
    const n = needsReschedule().length
    audit('檢查室開放時段', `${keep.map((r) => `${examRoomName(r.room)}週${WEEKDAY_LABEL[r.weekday]} ${r.closed ? '不開' : `${r.start}–${r.end}`}`).join('、') || '全部預設'}${n ? `；${n} 筆檢查需改期` : ''}`)
    return { changed: before === JSON.stringify(keep) ? 0 : 1, needsReschedule: n }
  })
}
/** 加休診日（某一間或全部）：那天排不進去，已排的列「需改期」 */
export function addExamClosure(input: { date: string; room?: ImagingExam['room']; reason: string }): Promise<{ needsReschedule: number }> {
  return mutate(() => {
    const u = requireHoursEditor()
    const e: Record<string, string> = {}
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input?.date ?? '')) e.date = '請選日期'
    else if (input.date < now().slice(0, 10)) e.date = '不能是過去的日期'
    if (input?.room && !EXAM_ROOMS.some((r) => r.id === input.room)) e.room = '請選檢查室'
    if (!input?.reason?.trim()) e.reason = '請寫原因（例：國定假日、消防演練）'
    failFields(e)
    if (db.examClosures.some((c) => c.date === input.date && (!c.room || !input.room || c.room === input.room))) fail('這天已經設過休診了', 'CONFLICT')
    db.examClosures.push({ id: newId('XC'), date: input.date, ...(input.room ? { room: input.room } : {}), reason: input.reason.trim(), by: u.id, at: now() })
    const n = needsReschedule().length
    audit('檢查室休診', `${input.date} ${input.room ? examRoomName(input.room) : '全部檢查室'}：${input.reason.trim()}${n ? `；${n} 筆檢查需改期` : ''}`)
    return { needsReschedule: n }
  })
}
export function removeExamClosure(id: string): Promise<{ ok: true }> {
  return mutate(() => {
    requireHoursEditor()
    const c = must(db.examClosures.find((x) => x.id === id), '休診日')
    db.examClosures = db.examClosures.filter((x) => x.id !== id)
    audit('檢查室休診取消', `${c.date} ${c.room ? examRoomName(c.room) : '全部檢查室'}（${c.reason}）`)
    return { ok: true as const }
  })
}
