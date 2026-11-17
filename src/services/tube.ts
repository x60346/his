// 管灌（護理站）：今天各餐（或各班）該灌多少、記灌入量與反抽量；反抽 >200 ml 提醒暫停並通知醫師（不擋）。
// 配方主檔查詢；管灌醫囑由醫師在「住院醫囑」開（飲食 → 管灌），或依營養師建議一鍵帶入（ipd.orderTubeFromAssessment）
import type { TubeFeedRecord, TubeFormula } from '@/types'
import { db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'
import { tubeNutrients, tubePlanText, TUBE_RESIDUAL_HOLD } from './nutrition-rules'
import { highResidual, tubeSlotsOf, type FeedSlot } from './tube-work'

export const listTubeFormulas = (): Promise<TubeFormula[]> => query(() => db.tubeFormulas.filter((f) => f.active))

export interface TubeFeedingView {
  admissionId: string
  /** 沒有管灌醫囑就沒有 */
  plan?: { orderId: string; text: string; kcal: number; protein: number; mode: 'bolus' | 'continuous' }
  slots: (FeedSlot & { byName?: string })[]
  /** 今天灌入合計 */
  todayMl: number
  /** 最近一次反抽過多 */
  highResidual?: { at: string; residualMl: number }
  canRecord: boolean
}

export function getTubeFeeding(admissionId: string): Promise<TubeFeedingView> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'diet', 'admin')
    const t = now()
    const { order, slots } = tubeSlotsOf(admissionId, t)
    const f = order ? find.tubeFormula(order.diet.tube.formulaId) : undefined
    const hr = highResidual(admissionId)
    return {
      admissionId,
      ...(order ? { plan: { orderId: order.id, text: tubePlanText(order.diet.tube, f), mode: order.diet.tube.mode, ...(f ? tubeNutrients(order.diet.tube, f) : { kcal: 0, protein: 0 }) } } : {}),
      slots: slots.map((s) => ({ ...s, ...(s.record ? { byName: nameOf.user(s.record.by) } : {}) })),
      todayMl: db.tubeFeeds.filter((r) => r.admissionId === admissionId && r.at.startsWith(today())).reduce((n, r) => n + r.givenMl, 0),
      ...(hr ? { highResidual: { at: hr.at, residualMl: hr.residualMl! } } : {}),
      canRecord: u.role === 'nurse',
    }
  })
}

export interface FeedInput {
  slot: string
  givenMl: number
  residualMl?: number
  /** 沒灌：原因（灌入量填 0） */
  heldReason?: string
  note?: string
}

/** 記一餐（或一班）管灌：反抽 >200 ml 回 warning（建議暫停、通知醫師），照樣存 */
export function recordTubeFeed(admissionId: string, input: FeedInput): Promise<{ record: TubeFeedRecord; warning?: string }> {
  return mutate(() => {
    const u = requireUser('nurse')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
    const t = now()
    const { order, slots } = tubeSlotsOf(a.id, t)
    if (!order) fail('沒有有效的管灌醫囑', 'CONFLICT')
    const s = slots.find((x) => x.slot === input.slot)
    if (!s) failField('slot', '這個時段不在今天的管灌排程裡')
    if (s!.record) fail('這一餐已經記過了', 'CONFLICT')
    if (s!.state === 'upcoming') fail('還沒到時間（前後 1 小時內才能記）', 'CONFLICT')
    const f: Record<string, string> = {}
    const held = !!input.heldReason?.trim()
    if (!Number.isInteger(input.givenMl) || input.givenMl < 0 || input.givenMl > 1500) f.givenMl = '灌入量 0–1500 ml（整數）'
    else if (!held && input.givenMl === 0) f.givenMl = '沒灌請寫原因'
    if (input.residualMl !== undefined && input.residualMl !== null && !(Number.isInteger(input.residualMl) && input.residualMl >= 0 && input.residualMl <= 1000)) f.residualMl = '反抽量 0–1000 ml'
    failFields(f)
    const r: TubeFeedRecord = {
      id: newId('TF'), admissionId: a.id, orderId: order!.id, slot: s!.slot, at: t, by: u.id, givenMl: held ? 0 : input.givenMl,
      ...(input.residualMl !== undefined && input.residualMl !== null ? { residualMl: input.residualMl } : {}),
      ...(held ? { heldReason: input.heldReason!.trim() } : {}), ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    }
    db.tubeFeeds.push(r)
    audit('管灌', `${a.admitNo} ${nameOf.patient(a.patientId)} ${s!.slot.slice(11)}：${held ? `未灌（${r.heldReason}）` : `${r.givenMl} ml`}${r.residualMl !== undefined ? `，反抽 ${r.residualMl} ml` : ''}`)
    const warning = (r.residualMl ?? 0) > TUBE_RESIDUAL_HOLD ? `反抽 ${r.residualMl} ml（>${TUBE_RESIDUAL_HOLD}）：建議暫停下一餐並通知醫師` : undefined
    return { record: r, ...(warning ? { warning } : {}) }
  })
}
