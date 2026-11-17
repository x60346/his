// 呼吸器與鎮靜（加護病房）：
//   - 呼吸器醫囑（醫師）：模式、FiO2、PEEP、潮氣量／吸氣壓力、呼吸次數、壓力支持；要先插氣管內管（管路「氣管內管」）、
//     DNR 不施行人工呼吸的不能開。改設定＝停掉舊的、開新的（寫原因），護理師在醫囑清單核對；停止時可以一起拔管
//   - 實測與 RASS（護理師）：記在重症流程表（每 4 小時），這裡只看
//   - 鎮靜目標（醫師設 RASS 範圍）：最近一次超出範圍列主治首頁
//   - 每日脫離評估（醫師）：插管接呼吸器的病人每天做 SAT（停鎮靜）→ 通過才做 SBT（自發呼吸），沒做列主治首頁
// 規則在 vent-rules
import type { IpdOrder, VentSetting, WeanResult, WeanTrial } from '@/types'
import { db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'
import { requireCare } from './care-team'
import { checkRassTarget, checkVentSetting, cleanVentSetting, checkWean, rassLabel, ventDnrProblem, ventText, WEAN_LABEL } from './vent-rules'
import { activeVent, intubation, rassStateOf, ventCheckState, ventOrders, weanDue, weanToday } from './vent-work'
import { inIcu } from './icu-work'
import { activeDnr } from './flag-work'
import { lineDayAt } from './infection-rules'
import { stopOrderRecord } from './order-ops'

const admittedOf = (id: string) => {
  const a = must(find.admission(id), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return a
}

export interface VentOrderView { id: string; text: string; setting: VentSetting; startAt: string; stopAt?: string; doctorName: string; acked: boolean; changeReason?: string }
const orderOf = (o: IpdOrder): VentOrderView => ({
  id: o.id, text: ventText(o.vent!), setting: o.vent!, startAt: o.startAt, ...(o.stopAt ? { stopAt: o.stopAt } : {}), doctorName: nameOf.doctor(o.doctorId), acked: !!o.ackAt,
  ...(o.vent!.changeReason ? { changeReason: o.vent!.changeReason } : {}),
})
const weanOf = (w: WeanTrial) => ({ ...w, byName: nameOf.user(w.by), text: `SAT ${WEAN_LABEL[w.sat]}・SBT ${WEAN_LABEL[w.sbt]}` })

export interface PatientVent {
  admissionId: string
  inIcu: boolean
  intubation?: { text: string; insertedAt: string; day: number }
  order?: VentOrderView
  history: VentOrderView[]
  check?: { lastAt?: string; last?: { ppeak: number; vt: number; rr: number }; dueAt: string; status: 'ok' | 'due' | 'overdue' }
  rass?: { last?: { score: number; label: string; at: string; byName: string }; target?: { min: number; max: number; byName: string; at: string }; vs?: 'in' | 'deep' | 'light'; dueAt: string; status: 'ok' | 'due' | 'overdue'; recent: { at: string; score: number }[] }
  wean: { due: boolean; today?: ReturnType<typeof weanOf>; recent: ReturnType<typeof weanOf>[] }
  /** DNR 不施行人工呼吸（開呼吸器會被擋，先講） */
  dnrProblem?: string
  canDoctor: boolean
  canNurse: boolean
}

export function patientVent(admissionId: string): Promise<PatientVent> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'admin')
    const a = must(find.admission(admissionId), '住院紀錄')
    const t = now()
    const ett = intubation(a.id)
    const o = activeVent(a.id)
    const vc = ventCheckState(a, t)
    const rs = rassStateOf(a, t)
    const dnr = ventDnrProblem(activeDnr(a.patientId)?.withhold)
    const open = a.status === 'admitted'
    return {
      admissionId: a.id, inIcu: inIcu(a),
      ...(ett ? { intubation: { text: `${ett.site} ${ett.size}`, insertedAt: ett.insertedAt, day: lineDayAt(ett.insertedAt, t) } } : {}),
      ...(o ? { order: orderOf(o) } : {}),
      history: ventOrders(a.id).filter((x) => x.id !== o?.id).map(orderOf),
      ...(vc ? { check: { ...(vc.last ? { lastAt: vc.last.at, last: vc.last.vent! } : {}), dueAt: vc.dueAt, status: vc.status } } : {}),
      ...(rs
        ? {
            rass: {
              ...(rs.last ? { last: { score: rs.last.rass!, label: rassLabel(rs.last.rass!), at: rs.last.at, byName: nameOf.user(rs.last.nurseId) } } : {}),
              ...(rs.target ? { target: { min: rs.target.min, max: rs.target.max, byName: nameOf.user(rs.target.by), at: rs.target.at } } : {}),
              ...(rs.vs ? { vs: rs.vs } : {}), dueAt: rs.dueAt, status: rs.status,
              recent: db.vitals.filter((v) => v.admissionId === a.id && v.rass !== undefined && v.at >= rs.since).sort((x, y) => x.at.localeCompare(y.at)).slice(-12).map((v) => ({ at: v.at, score: v.rass! })),
            },
          }
        : {}),
      wean: { due: weanDue(a, t), ...(weanToday(a.id, t) ? { today: weanOf(weanToday(a.id, t)!) } : {}), recent: db.weanTrials.filter((w) => w.admissionId === a.id).sort((x, y) => y.at.localeCompare(x.at)).slice(0, 7).map(weanOf) },
      ...(dnr ? { dnrProblem: dnr } : {}),
      canDoctor: u.role === 'doctor' && open, canNurse: u.role === 'nurse' && open,
    }
  })
}

/** 開呼吸器醫囑；已經有的話是「改設定」：停掉舊的、開新的，要寫原因 */
export function orderVent(admissionId: string, input: VentSetting): Promise<VentOrderView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = admittedOf(admissionId)
    requireCare(u.doctorId, a, '開呼吸器醫囑', { consult: false })
    if (!inIcu(a)) fail('呼吸器醫囑限加護病房的病人（請先轉入加護病房）', 'CONFLICT')
    const dnr = ventDnrProblem(activeDnr(a.patientId)?.withhold)
    if (dnr) fail(dnr, 'CONFLICT')
    if (!intubation(a.id)) fail('沒有氣管內管：請先在「管路」登錄插管（經口、經鼻或氣切）', 'CONFLICT')
    failFields(checkVentSetting(input))
    const old = activeVent(a.id)
    const setting = cleanVentSetting({ ...input, changeReason: undefined } as VentSetting)
    const reason = input.changeReason?.trim()
    if (old) {
      if (ventText(old.vent) === ventText(setting)) fail('設定和目前的一樣，沒有要改的', 'CONFLICT')
      if (!reason) failField('changeReason', '改設定：請寫原因')
    }
    const t = now()
    if (old) stopOrderRecord(old, u.id, t)
    const o: IpdOrder = {
      id: newId('IO'), admissionId: a.id, type: 'long', category: 'nursing', content: `呼吸器 ${ventText(setting)}`,
      vent: { ...setting, ...(old && reason ? { changeReason: reason } : {}) }, startAt: t, status: 'active', doctorId: u.doctorId!, createdAt: t,
    }
    db.ipdOrders.push(o)
    audit(old ? '呼吸器改設定' : '呼吸器醫囑', `${a.admitNo} ${nameOf.patient(a.patientId)}：${old ? `${ventText(old.vent)} → ` : ''}${ventText(setting)}${old ? `（${reason}）` : ''}`)
    return orderOf(o)
  })
}

/** 停止呼吸器（可一起拔管：氣管內管記移除） */
export function stopVent(admissionId: string, input: { reason: string; extubate: boolean }): Promise<PatientVent> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = admittedOf(admissionId)
    requireCare(u.doctorId, a, '停止呼吸器', { consult: false })
    const o = activeVent(a.id)
    if (!o) fail('沒有使用中的呼吸器醫囑', 'CONFLICT')
    if (!input.reason?.trim()) failField('reason', '請寫原因（例：SBT 通過，拔管改鼻導管）')
    const t = now()
    stopOrderRecord(o!, u.id, t)
    const ett = intubation(a.id)
    if (input.extubate && ett) Object.assign(ett, { removedAt: t, removedBy: u.id, removeReason: `不需要了（拔管：${input.reason.trim()}）` })
    audit('停止呼吸器', `${a.admitNo} ${nameOf.patient(a.patientId)}：${input.reason.trim()}${input.extubate && ett ? '，拔管' : ''}`)
  }).then(() => patientVent(admissionId))
}

/** 鎮靜目標（RASS 範圍） */
export function setRassTarget(admissionId: string, min: number, max: number): Promise<PatientVent> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = admittedOf(admissionId)
    requireCare(u.doctorId, a, '設鎮靜目標', { consult: false })
    if (!inIcu(a)) fail('鎮靜目標限加護病房的病人', 'CONFLICT')
    failFields(checkRassTarget(min, max))
    const old = a.rassTarget
    a.rassTarget = { min, max, by: u.id, at: now() }
    audit('鎮靜目標', `${a.admitNo} ${nameOf.patient(a.patientId)}：RASS ${old ? `${old.min}～${old.max} → ` : ''}${min}～${max}`)
  }).then(() => patientVent(admissionId))
}

/** 每日脫離評估（SAT → SBT） */
export function recordWean(admissionId: string, input: { sat: WeanResult; sbt: WeanResult; note?: string }): Promise<PatientVent> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = admittedOf(admissionId)
    requireCare(u.doctorId, a, '記脫離評估', { consult: false })
    if (!activeVent(a.id) || !intubation(a.id)) fail('病人沒有插管接呼吸器，不用做脫離評估', 'CONFLICT')
    failFields(checkWean(input))
    const t = now()
    db.weanTrials.push({ id: newId('WN'), admissionId: a.id, date: today(), at: t, by: u.id, sat: input.sat, sbt: input.sbt, ...(input.note?.trim() ? { note: input.note.trim() } : {}) })
    audit('脫離評估', `${a.admitNo} ${nameOf.patient(a.patientId)}：SAT ${WEAN_LABEL[input.sat]}、SBT ${WEAN_LABEL[input.sbt]}${input.note?.trim() ? `（${input.note.trim()}）` : ''}`)
  }).then(() => patientVent(admissionId))
}
