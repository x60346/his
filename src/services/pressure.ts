// 負壓隔離室：
//   - 7C 綜合病房 705（單人房改負壓）、加護病房 ICU9（負壓床）
//   - 護理師每班至少記錄一次壓差（Pa，負值）；高於 −2.5 是負壓不足，要寫處理。這一班沒記錄或負壓不足的，不能新收空氣隔離病人
//   - 空氣隔離優先排負壓室：排床畫面列出「建議排負壓隔離室」（目前可收的負壓床）
// 規則在 pressure-rules；排床把關在 flag-work.negativeAdmitFor
import type { PressureLog } from '@/types'
import { db, newId } from '@/mock/db'
import { addMinutes, now } from '@/utils/date'
import { audit, failFields, must, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'
import { activeIsolations, negativeAdmitFor, negativeRoomState } from './flag-work'
import { isoText } from './flag-rules'
import { checkPressure, PRESSURE_STATE_LABEL, type PressureState } from './pressure-rules'

export interface NegativeRoom {
  bedId: string
  bedNo: string
  ward: string
  occupied: boolean
  patientName?: string
  isolation?: string
  state: PressureState
  stateLabel: string
  last?: { at: string; pa: number }
  /** 最近 24 小時的紀錄（新的在前） */
  logs: (PressureLog & { byName: string })[]
}
const roomOf = (bedId: string, t: string): NegativeRoom => {
  const b = must(find.bed(bedId), '病床')
  const a = b.status === 'occupied' && b.admissionId ? find.admission(b.admissionId) : undefined
  const s = negativeRoomState(b, t)
  const isos = a ? activeIsolations(a.patientId) : []
  const sinceStr = addMinutes(t, -24 * 60)
  return {
    bedId: b.id, bedNo: b.bedNo, ward: b.ward, occupied: !!a,
    ...(a ? { patientName: nameOf.patient(a.patientId), ...(isos.length ? { isolation: isoText(isos) } : {}) } : {}),
    state: s.state, stateLabel: PRESSURE_STATE_LABEL[s.state], ...(s.last ? { last: s.last } : {}),
    logs: db.pressureLogs.filter((l) => l.bedId === b.id && l.at >= sinceStr && l.at <= t).sort((x, y) => y.at.localeCompare(x.at)).map((l) => ({ ...l, byName: nameOf.user(l.by) })),
  }
}

/** 負壓隔離室（ward 不給＝全院） */
export function listNegativeRooms(ward?: string): Promise<NegativeRoom[]> {
  return query(() => {
    requireUser()
    const t = now()
    return db.beds.filter((b) => b.negativePressure && (!ward || b.ward === ward)).map((b) => roomOf(b.id, t))
  })
}

export function recordPressure(bedId: string, input: { pa: number; note?: string }): Promise<NegativeRoom> {
  return mutate(() => {
    const u = requireUser('nurse')
    const b = must(find.bed(bedId), '病床')
    if (!b.negativePressure) failFields({ bedId: '這張床不是負壓隔離室' })
    failFields(checkPressure(input))
    const t = now()
    db.pressureLogs.push({ id: newId('NP'), bedId: b.id, at: t, pa: input.pa, by: u.id, ...(input.note?.trim() ? { note: input.note.trim() } : {}) })
    audit('負壓壓差', `${b.bedNo}：${input.pa} Pa${input.note?.trim() ? `（${input.note.trim()}）` : ''}`)
    return roomOf(b.id, t)
  })
}

/** 排床建議：空氣隔離的病人，列出目前可以收的負壓床（空床、這班壓差正常）；不是空氣隔離＝沒有建議 */
export function bedHints(admissionId: string): Promise<{ airborne: boolean; recommend: { id: string; bedNo: string; ward: string }[] }> {
  return query(() => {
    requireUser()
    const a = must(find.admission(admissionId), '住院紀錄')
    const airborne = activeIsolations(a.patientId).some((i) => i.kind === 'airborne')
    const t = now()
    return {
      airborne,
      recommend: airborne ? db.beds.filter((b) => b.negativePressure && b.status === 'empty' && !negativeAdmitFor(a.patientId, b, t)).map((b) => ({ id: b.id, bedNo: b.bedNo, ward: b.ward })) : [],
    }
  })
}
