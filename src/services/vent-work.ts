// 呼吸器與鎮靜的內部工具（index 不匯出、不會被包成 API）：使用中的呼吸器醫囑、插管、最近一次實測與 RASS、
// 每 4 小時到期、今天的脫離評估、護理站待辦、主治首頁計數。規則在 vent-rules
import type { Admission, IpdOrder, LineDevice, VitalRecord, WeanTrial } from '@/types'
import { db } from '@/mock/db'
import { everyHours, RASS_HOURS, rassVsTarget, VENT_CHECK_HOURS } from './vent-rules'
import { icuSince } from './icu-work'
import { careRoleOf } from './care-team'

export const activeVent = (admissionId: string): (IpdOrder & { vent: NonNullable<IpdOrder['vent']> }) | undefined =>
  db.ipdOrders.find((o) => o.admissionId === admissionId && !!o.vent && o.status === 'active') as (IpdOrder & { vent: NonNullable<IpdOrder['vent']> }) | undefined
export const ventOrders = (admissionId: string): IpdOrder[] => db.ipdOrders.filter((o) => o.admissionId === admissionId && !!o.vent).sort((x, y) => y.startAt.localeCompare(x.startAt))
/** 插著氣管內管 */
export const intubation = (admissionId: string): LineDevice | undefined => db.lines.find((l) => l.admissionId === admissionId && l.kind === 'ett' && !l.removedAt)

const lastWith = (admissionId: string, key: 'vent' | 'rass', from = ''): VitalRecord | undefined =>
  db.vitals.filter((v) => v.admissionId === admissionId && v[key] !== undefined && v.at >= from).reduce<VitalRecord | undefined>((b, v) => (!b || v.at >= b.at ? v : b), undefined)
export const lastVentCheck = (admissionId: string, from = '') => lastWith(admissionId, 'vent', from)
export const lastRass = (admissionId: string, from = '') => lastWith(admissionId, 'rass', from)

/** 呼吸器實測：從開醫囑（或上一次實測）起每 4 小時 */
export function ventCheckState(a: Admission, t: string) {
  const o = activeVent(a.id)
  if (!o) return undefined
  const last = lastVentCheck(a.id, o.startAt)
  return { order: o, last, ...everyHours(last?.at, o.startAt, VENT_CHECK_HOURS, t) }
}

/** RASS：加護病房的病人從轉入（或上一次評估）起每 4 小時；有目標的話比目標 */
export function rassStateOf(a: Admission, t: string) {
  const since = icuSince(a)
  if (!since) return undefined
  const last = lastRass(a.id, since)
  const target = a.rassTarget
  const vs = last && target ? rassVsTarget(last.rass!, target) : undefined
  return { since, last, target, vs, ...everyHours(last?.at, since, RASS_HOURS, t) }
}

/** 今天的脫離評估（同一天可以再做，取最後一次） */
export const weanToday = (admissionId: string, t: string): WeanTrial | undefined =>
  db.weanTrials.filter((w) => w.admissionId === admissionId && w.date === t.slice(0, 10)).sort((x, y) => x.at.localeCompare(y.at)).pop()
/** 插管又接呼吸器、今天還沒做脫離評估 */
export const weanDue = (a: Admission, t: string) => a.status === 'admitted' && !!activeVent(a.id) && !!intubation(a.id) && !weanToday(a.id, t)

export interface VentTodo { kind: 'vent' | 'rass'; urgency: 'due' | 'overdue'; at: string; text: string }
/** 護理站待辦：呼吸器實測、RASS 每 4 小時（到期前 30 分鐘「現在」、過了「逾時」） */
export function ventTodosOf(a: Admission, t: string): VentTodo[] {
  const out: VentTodo[] = []
  const v = ventCheckState(a, t)
  if (v && v.status !== 'ok') out.push({ kind: 'vent', urgency: v.status, at: v.dueAt, text: '呼吸器實測（每 4 小時：尖峰壓、潮氣量、呼吸次數）' })
  const r = rassStateOf(a, t)
  if (r && r.status !== 'ok') out.push({ kind: 'rass', urgency: r.status, at: r.dueAt, text: `鎮靜評估 RASS（每 4 小時${r.target ? `；目標 ${r.target.min}～${r.target.max}` : ''}）` })
  return out
}

/** 主治首頁：本科加護病房病人最近一次 RASS 超出目標、今天還沒做脫離評估 */
const mine = (doctorId: string) => db.admissions.filter((a) => a.status === 'admitted' && (careRoleOf(doctorId, a)?.kind ?? 'consult') !== 'consult')
export const rassOutCount = (doctorId: string, t: string) => mine(doctorId).filter((a) => { const r = rassStateOf(a, t); return !!r?.vs && r.vs !== 'in' }).length
export const weanDueCount = (doctorId: string, t: string) => mine(doctorId).filter((a) => weanDue(a, t)).length
