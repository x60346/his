// 負壓隔離室（純函式）：壓差的輸入檢查、異常判斷、這一班的狀態（沒記、異常、正常）。
// 負壓室頁、排床把關、首頁待辦、測試都用這一份
/** 壓差要比 −2.5 Pa 更負（−2.5 以上＝負壓不足，空氣可能外洩） */
export const PRESSURE_LIMIT = -2.5
/** 可輸入範圍（打錯字擋下） */
export const PRESSURE_RANGE: [number, number] = [-50, 10]

export function checkPressure(x: { pa?: number; note?: string }): Record<string, string> {
  if (typeof x.pa !== 'number' || Number.isNaN(x.pa)) return { pa: '請輸入壓差（Pa，負值）' }
  if (x.pa < PRESSURE_RANGE[0] || x.pa > PRESSURE_RANGE[1]) return { pa: `壓差數值不合理（可輸入 ${PRESSURE_RANGE[0]}–${PRESSURE_RANGE[1]} Pa）` }
  if (x.pa > PRESSURE_LIMIT && !x.note?.trim()) return { note: `壓差 ${x.pa} Pa 高於 ${PRESSURE_LIMIT}（負壓不足）：請寫處理（例：已通知工務，關緊前室門）` }
  return {}
}
export const pressureAbnormal = (pa: number) => pa > PRESSURE_LIMIT

export type PressureState = 'ok' | 'abnormal' | 'missing'
export const PRESSURE_STATE_LABEL: Record<PressureState, string> = { ok: '正常', abnormal: '負壓不足', missing: '本班未記錄' }
/** 這一班的狀態：看這班最後一筆（沒有＝未記錄） */
export function pressureState(logsThisShift: { at: string; pa: number }[]): { state: PressureState; last?: { at: string; pa: number } } {
  const last = [...logsThisShift].sort((x, y) => x.at.localeCompare(y.at)).pop()
  if (!last) return { state: 'missing' }
  return { state: pressureAbnormal(last.pa) ? 'abnormal' : 'ok', last }
}
/** 新收空氣隔離病人：這一班要有記錄且正常 */
export const negativeAdmitProblem = (bedNo: string, s: PressureState) =>
  s === 'ok' ? undefined : `負壓隔離室 ${bedNo} 這一班${s === 'missing' ? '還沒記錄壓差' : '負壓不足'}：先確認負壓正常才能收空氣隔離病人`
