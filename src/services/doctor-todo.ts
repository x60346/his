// 醫師首頁的住院待辦「帶到哪位病人、哪個分頁」：首頁卡片只給數字，點進住院醫囑以前只到首頁，醫師要一位一位點病人、在二十幾個分頁裡找。
// 這裡依卡片（key）列出有這件事的病人與該開的分頁；條件和首頁數字用同一組判斷（*-work 的同一個函式），不另外寫一套。
// 病人已出院的（病理報告常在出院後才出來）也列出，標 discharged，畫面帶到手術室那一天。
import type { Admission } from '@/types'
import { db } from '@/mock/db'
import { now } from '@/utils/date'
import { query, requireUser } from './http'
import { find } from './views'
import { openQuery } from './nursing-rules'
import { careRoleOf } from './care-team'
import { reactionsToAck } from './blood-work'
import { drgAlertsOf } from './drg-work'
import { pathAckDueOf, postopDueOf, recordDueOf } from './surgery-work'
import { lineTodosOf } from './line-work'
import { mdroAlertsOf } from './flag-work'
import { pendingNotifiable } from './ipc-work'
import { pcaOpenAlert, runningPca } from './pca-work'
import { newsStateOf } from './news-work'
import { rassStateOf, weanDue } from './vent-work'
import { escalateTo, readingAlertPending, readingEscalated } from './bedside-work'
import { callsWithoutNote } from './doctor-call-work'
import { openWounds } from './wound-work'
import { stalled } from './wound-rules'
import { latestDelirium, restraintTodosOf } from './delirium-work'
import { abxAttendingTodo } from './abx-work'
import { openAdvice } from './abx-steward-work'
import { pharmQueried } from './pharm-work'
import { prophylaxisOverdue } from './prophylaxis-work'
import { tdmAlerts } from './renal-work'

/** 首頁住院待辦卡片的代號（HomePage 的 query.todo） */
export const DOCTOR_TODO_KEYS = [
  'bloodReactions', 'drg', 'postopDue', 'pathAckDue', 'opRecordsDue', 'lineAttending', 'mdroAlerts', 'notifiablePending', 'pcaAlerts',
  'newsAlerts', 'rassOut', 'weanDue', 'bedsideAlerts', 'bedsideAlertsEscalated', 'callsWithoutNote', 'dutyNotesUnread', 'woundStall',
  'deliriumPositive', 'restraintOrder', 'nutritionUnseen', 'metforminAlerts', 'abxRejected', 'abxAdvice', 'medRecToDecide',
  'pharmCareToReply', 'pharmQueries', 'prophylaxisDue', 'tdmAlerts', 'abxExtend', 'consultOrdersUnseen', 'orderQueries',
] as const
export type DoctorTodoKey = (typeof DOCTOR_TODO_KEYS)[number]

export interface DoctorTodoTarget {
  admissionId: string
  bedNo: string
  patientName: string
  /** 住院醫囑要開的分頁 */
  tab: string
  /** 病人已出院：住院醫囑清單沒有，畫面改帶到手術室那一天（surgeryDate） */
  discharged?: boolean
  surgeryDate?: string
}

type Hit = { admissionId: string; tab: string; surgeryDate?: string }

export function doctorTodoTargets(key: string): Promise<DoctorTodoTarget[]> {
  return query(() => {
    const me = requireUser('doctor')
    const dr = me.doctorId ?? ''
    const t = now()
    const admitted = db.admissions.filter((a) => a.status === 'admitted')
    // 照顧（主治或照護團隊；會診不算）：和首頁「你的病人」同一個範圍
    const caring = admitted.filter((a) => (careRoleOf(dr, a)?.kind ?? 'consult') !== 'consult')
    const attending = admitted.filter((a) => a.doctorId === dr)
    const mine = new Set(attending.map((a) => a.id))
    const by = (xs: Admission[], tab: string): Hit[] => xs.map((a) => ({ admissionId: a.id, tab }))
    const hits: Record<DoctorTodoKey, () => Hit[]> = {
      bloodReactions: () => reactionsToAck(dr).map((r) => ({ admissionId: r.admissionId, tab: 'blood' })),
      drg: () => drgAlertsOf(dr).map((x) => ({ admissionId: x.a.id, tab: 'discharge' })),
      postopDue: () => postopDueOf(dr).map((s) => ({ admissionId: s.admissionId, tab: 'surgery' })),
      pathAckDue: () => pathAckDueOf(dr).map((s) => ({ admissionId: s.admissionId, tab: 'surgery', surgeryDate: (s.schedule?.start ?? s.requestedDate).slice(0, 10) })),
      opRecordsDue: () => recordDueOf(dr).map((s) => ({ admissionId: s.admissionId, tab: 'surgery', surgeryDate: (s.schedule?.start ?? s.requestedDate).slice(0, 10) })),
      lineAttending: () => by(attending.filter((a) => lineTodosOf(a.id, t).some((x) => x.kind === 'attending')), 'lines'),
      mdroAlerts: () => by(caring.filter((a) => mdroAlertsOf(a.patientId, t).length > 0), 'flags'),
      notifiablePending: () => by(caring.filter((a) => pendingNotifiable(a).length > 0), 'flags'),
      pcaAlerts: () => by(caring.filter((a) => { const p = runningPca(a.id); return !!p && !!pcaOpenAlert(p) }), 'pca'),
      newsAlerts: () => by(caring.filter((a) => { const s = newsStateOf(a, t); return !!s && s.last.news.level !== 'low' }), 'icu'),
      rassOut: () => by(caring.filter((a) => { const r = rassStateOf(a, t); return !!r?.vs && r.vs !== 'in' }), 'vent'),
      weanDue: () => by(caring.filter((a) => weanDue(a, t)), 'vent'),
      bedsideAlerts: () => db.bedsideProcedures.filter((p) => mine.has(p.admissionId) && readingAlertPending(p)).map((p) => ({ admissionId: p.admissionId, tab: 'bedside' })),
      bedsideAlertsEscalated: () =>
        db.bedsideProcedures
          .filter((p) => {
            const a = admitted.find((x) => x.id === p.admissionId)
            if (!a || a.doctorId === dr) return false
            const to = escalateTo(a.id, t)
            return (to.kind === 'oncall' ? to.userId === me.id : careRoleOf(dr, a)?.kind === 'team') && readingEscalated(p, t)
          })
          .map((p) => ({ admissionId: p.admissionId, tab: 'bedside' })),
      callsWithoutNote: () => callsWithoutNote(me.id, t).map((c) => ({ admissionId: c.admissionId, tab: 'notes' })),
      dutyNotesUnread: () => by(attending.filter((a) => db.progressNotes.some((n) => n.admissionId === a.id && n.kind === 'duty' && !n.dutyAck)), 'notes'),
      woundStall: () => by(caring.filter((a) => openWounds(a.id).some((w) => stalled(w.cares, t))), 'wounds'),
      deliriumPositive: () => by(caring.filter((a) => { const l = latestDelirium(a.id); return !!l?.positive && !l.ackAt }), 'safety'),
      restraintOrder: () => by(caring.filter((a) => restraintTodosOf(a.id, t).some((x) => x.kind === 'order')), 'safety'),
      nutritionUnseen: () => db.nutritionAssessments.filter((x) => !x.seenAt && mine.has(x.admissionId)).map((x) => ({ admissionId: x.admissionId, tab: 'nutrition' })),
      metforminAlerts: () =>
        db.imagingExams
          .filter((e) => e.metforminAlert && !e.metforminAlert.ackAt && e.metforminAlert.doctorId === dr)
          .map((e) => admitted.find((a) => (e.admissionId ? a.id === e.admissionId : a.patientId === e.patientId)))
          .filter((a): a is Admission => !!a)
          .map((a) => ({ admissionId: a.id, tab: 'exams' })),
      abxRejected: () => abxAttendingTodo(dr, t).rejected.map((o) => ({ admissionId: o.admissionId, tab: 'abx' })),
      abxExtend: () => abxAttendingTodo(dr, t).extend.map((o) => ({ admissionId: o.admissionId, tab: 'abx' })),
      abxAdvice: () => openAdvice(dr).map((x) => ({ admissionId: x.admissionId, tab: 'abx' })),
      medRecToDecide: () => by(attending.filter((a) => a.medRec && !a.medRec.completedAt), 'medrec'),
      pharmCareToReply: () => db.pharmCareNotes.filter((x) => x.status === 'sent' && mine.has(x.admissionId)).map((x) => ({ admissionId: x.admissionId, tab: 'pharmcare' })),
      pharmQueries: () => pharmQueried(dr).map((o) => ({ admissionId: o.admissionId, tab: 'orders' })),
      prophylaxisDue: () => prophylaxisOverdue(t, dr).map((x) => ({ admissionId: x.order.admissionId, tab: 'orders' })),
      tdmAlerts: () => tdmAlerts(dr).map((o) => ({ admissionId: o.admissionId, tab: 'orders' })),
      consultOrdersUnseen: () => db.ipdOrders.filter((o) => mine.has(o.admissionId) && o.consultId && !o.consultSeenAt).map((o) => ({ admissionId: o.admissionId, tab: 'orders' })),
      orderQueries: () => db.ipdOrders.filter((o) => mine.has(o.admissionId) && !!openQuery(o)).map((o) => ({ admissionId: o.admissionId, tab: 'orders' })),
    }
    const fn = hits[key as DoctorTodoKey]
    if (!fn) return []
    // 同一位病人只列一次（例：兩筆醫囑疑問）
    const seen = new Set<string>()
    const out: DoctorTodoTarget[] = []
    for (const h of fn()) {
      if (seen.has(h.admissionId)) continue
      seen.add(h.admissionId)
      const a = find.admission(h.admissionId)
      if (!a) continue
      const discharged = a.status !== 'admitted'
      out.push({
        admissionId: a.id,
        bedNo: discharged ? '' : (db.beds.find((b) => b.id === a.bedId)?.bedNo ?? ''),
        patientName: find.patient(a.patientId)?.name ?? '',
        tab: h.tab,
        ...(discharged ? { discharged: true, ...(h.surgeryDate ? { surgeryDate: h.surgeryDate } : {}) } : {}),
      })
    }
    return out.sort((x, y) => Number(!!x.discharged) - Number(!!y.discharged) || x.bedNo.localeCompare(y.bedNo))
  })
}

