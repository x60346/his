// 生命徵象的內部工具（index 不匯出、不會被包成 API）：一般病房的生命徵象（nursing.addVitals）和加護病房的重症流程表
// （icu.addFlowsheetEntry）共用同一套檢查——流程表的數值也是生命徵象，兩邊不能各擋各的
import type { VitalRecord } from '@/types'
import { newId } from '@/mock/db'
import { fail, failField, fieldErrors } from './http'
import { vitalInputProblem, vitalSpecs, type VitalKey } from './nursing-rules'
import { painActionProblem } from './line-rules'

export type VitalInput = Omit<VitalRecord, 'id' | 'nurseId' | 'at'>

/**
 * 依輸入建一筆生命徵象（不寫進 db）：只收已知欄位、逐項檢查合理範圍（輸入錯誤擋下；「異常但合理」照常記錄），
 * 所有錯誤一次標出；疼痛 ≥4 要寫處置。extra 是加護病房多記的欄位（GCS、瞳孔），由呼叫端檢查過再帶進來
 */
export function buildVital(input: VitalInput, nurseId: string, t: string, extra: Partial<Pick<VitalRecord, 'hourly' | 'gcs' | 'pupils'>> = {}, extraErrors: Record<string, string> = {}): VitalRecord {
  const v: VitalRecord = { admissionId: input.admissionId, id: newId('VS'), at: t, nurseId }
  const errs = fieldErrors()
  for (const [k, m] of Object.entries(extraErrors)) errs.add(k, m)
  for (const k of Object.keys(vitalSpecs) as VitalKey[]) {
    const val = input[k]
    if (val === undefined || val === null || Number.isNaN(val)) continue
    const problem = vitalInputProblem(k, val)
    if (problem) errs.add(k, problem)
    v[k] = val
  }
  if (v.sbp !== undefined && v.dbp !== undefined && !errs.has('sbp') && v.dbp >= v.sbp) errs.add('dbp', '舒張壓應小於收縮壓')
  errs.done()
  // 疼痛 ≥4 要寫處置（1 小時內重評：下一筆有疼痛分數的紀錄）
  const pp = painActionProblem(v.pain, input.painAction)
  if (pp) failField('painAction', pp)
  if (v.pain !== undefined && input.painAction?.trim()) v.painAction = input.painAction.trim()
  const hasNeuro = !!extra.gcs || !!extra.pupils
  if (Object.keys(v).length === 4 && !hasNeuro) fail('請至少輸入一項生命徵象')
  return { ...v, ...(extra.hourly ? { hourly: true } : {}), ...(extra.gcs ? { gcs: extra.gcs } : {}), ...(extra.pupils ? { pupils: extra.pupils } : {}) }
}
