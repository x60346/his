// 檢驗判讀規則（純函式）：檢驗頁即時標示、服務層發報告、種子、測試共用。
//   數值型：低於參考範圍 L、高於 H；超過危急值另標「危急」（要立刻通知醫師、醫師要確認）。
//   文字型：不在「正常」清單裡的標 A（異常）。
//   女性另有範圍的（血色素、肌酸酐）依病人性別。
import type { Gender, LabFlag, LabItemDef, LabReport, LabValue } from '@/types'

const fmt = (n: number) => String(n)

/** 這位病人適用的參考範圍 */
function rangeOf(def: LabItemDef, gender: Gender): { low?: number; high?: number } {
  if (gender === 'F' && (def.lowF !== undefined || def.highF !== undefined)) return { low: def.lowF, high: def.highF }
  return { low: def.low, high: def.high }
}

/** 參考範圍文字：4.0–10.0、≤ 199、≥ 70、陰性 */
export function labRefText(def: LabItemDef, gender: Gender): string {
  if (def.options) return (def.normal ?? []).join('、')
  const { low, high } = rangeOf(def, gender)
  if (low !== undefined && high !== undefined) return `${fmt(low)}–${fmt(high)}`
  if (high !== undefined) return `≤ ${fmt(high)}`
  if (low !== undefined) return `≥ ${fmt(low)}`
  return ''
}

/** 數值型的輸入：數字（可有小數），不能是負數 */
export const LAB_NUMBER = /^\d+(\.\d+)?$/

/**
 * 判讀一個值。回傳 error＝值不合格（空白、不是數字、不在選項裡）；否則回傳 flag 與是否危急
 */
export function judgeLab(def: LabItemDef, raw: string, gender: Gender): { error: string } | { flag: LabFlag; critical: boolean } {
  const value = (raw ?? '').trim()
  if (!value) return { error: `請輸入${def.name}` }
  if (def.options) {
    if (!def.options.includes(value)) return { error: `${def.name}只能是：${def.options.join('、')}` }
    return { flag: (def.normal ?? []).includes(value) ? '' : 'A', critical: false }
  }
  if (!LAB_NUMBER.test(value)) return { error: `${def.name}要填數字` }
  const n = Number(value)
  const { low, high } = rangeOf(def, gender)
  const flag: LabFlag = low !== undefined && n < low ? 'L' : high !== undefined && n > high ? 'H' : ''
  const critical = (def.critLow !== undefined && n < def.critLow) || (def.critHigh !== undefined && n > def.critHigh)
  return { flag, critical }
}

/** 整份報告的值：逐項判讀，回傳報告值或每一項的錯誤（一次標出全部） */
export function buildLabValues(defs: LabItemDef[], input: Record<string, string>, gender: Gender): { values: LabValue[]; errors: Record<string, string> } {
  const values: LabValue[] = []
  const errors: Record<string, string> = {}
  for (const def of defs) {
    const j = judgeLab(def, input[def.code] ?? '', gender)
    if ('error' in j) {
      errors[def.code] = j.error
      continue
    }
    values.push({ code: def.code, name: def.name, ...(def.unit ? { unit: def.unit } : {}), ref: labRefText(def, gender), value: (input[def.code] ?? '').trim(), flag: j.flag, ...(j.critical ? { critical: true } : {}) })
  }
  return { values, errors }
}

/** 醫師要確認的報告：有危急值、或更正過，而且還沒確認 */
export const labNeedsAck = (r: Pick<LabReport, 'values' | 'corrections' | 'ackAt'>) => !r.ackAt && (r.values.some((v) => v.critical) || !!r.corrections?.length)

/** 標示文字：H ↑、L ↓、A 異常 */
export const LAB_FLAG_TEXT: Record<LabFlag, string> = { '': '', H: '↑', L: '↓', A: '異常' }
