// 檢驗品管（QC，純函式＋靜態主檔）：每個品管項目兩個濃度的品管液（平均值、標準差）、Westgard 簡化規則
// （1-3s 拒絕、2-2s 拒絕、1-2s 警告）、今天這個項目能不能發報告、Levey-Jennings 圖的 z 值。
// 檢驗科品管頁、發報告的把關、首頁、測試都用這一份
import type { QcRun } from '@/types'

/** 品管項目：檢驗值代碼（LabItemDef.code）、名稱、兩個濃度品管液的平均值與標準差（展示用數值） */
export const QC_ANALYTES: { code: string; name: string; unit: string; levels: [{ mean: number; sd: number }, { mean: number; sd: number }] }[] = [
  { code: 'WBC', name: '白血球（CBC）', unit: '10³/µL', levels: [{ mean: 4.5, sd: 0.25 }, { mean: 15, sd: 0.6 }] },
  { code: 'GLU-AC', name: '血糖', unit: 'mg/dL', levels: [{ mean: 85, sd: 3 }, { mean: 280, sd: 8 }] },
  { code: 'CRE', name: '肌酸酐', unit: 'mg/dL', levels: [{ mean: 0.9, sd: 0.05 }, { mean: 5.5, sd: 0.18 }] },
  { code: 'NA', name: '鈉', unit: 'mmol/L', levels: [{ mean: 125, sd: 1.5 }, { mean: 155, sd: 1.8 }] },
  { code: 'K', name: '鉀', unit: 'mmol/L', levels: [{ mean: 3, sd: 0.08 }, { mean: 6, sd: 0.12 }] },
]
export const qcAnalyte = (code: string) => QC_ANALYTES.find((a) => a.code === code)

/** z 值（離平均幾個標準差），一位小數 */
export const qcZ = (code: string, level: 0 | 1, value: number) => {
  const a = qcAnalyte(code)!
  return Math.round(((value - a.levels[level].mean) / a.levels[level].sd) * 100) / 100
}

export type QcResult = QcRun['result']
export const QC_RESULT_LABEL: Record<QcResult, string> = { accept: '通過', warn: '通過（1-2s 警告）', reject: '拒絕' }

/**
 * Westgard 簡化：
 *  - 1-3s：任一濃度超過 ±3SD → 拒絕（隨機誤差）
 *  - 2-2s：兩個濃度同一邊都超過 2SD，或同一濃度連續兩次（前一次＋這次）同一邊超過 2SD → 拒絕（系統誤差）
 *  - 1-2s：任一濃度超過 ±2SD → 警告（可以發報告，要留意）
 */
export function westgard(z: [number, number], prev?: [number, number]): { result: QcResult; rules: string[] } {
  const rules: string[] = []
  if (z.some((x) => Math.abs(x) > 3)) rules.push('1-3s')
  const same22 = (a: number, b: number) => (a > 2 && b > 2) || (a < -2 && b < -2)
  if (same22(z[0], z[1]) || (prev && (same22(prev[0], z[0]) || same22(prev[1], z[1])))) rules.push('2-2s')
  if (rules.length) return { result: 'reject', rules }
  if (z.some((x) => Math.abs(x) > 2)) return { result: 'warn', rules: ['1-2s'] }
  return { result: 'accept', rules: [] }
}

/** 今天這個項目的品管狀態：最後一次（通過、警告＝可發報告；拒絕＝不能發）；沒做＝不能發 */
export function qcStatusToday(runs: Pick<QcRun, 'analyte' | 'date' | 'at' | 'result'>[], code: string, date: string): 'ok' | 'warn' | 'reject' | 'missing' {
  const last = runs.filter((r) => r.analyte === code && r.date === date).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
  return !last ? 'missing' : last.result === 'reject' ? 'reject' : last.result === 'warn' ? 'warn' : 'ok'
}

/** 發報告前：這份檢驗裡有品管項目的，今天都要通過（回傳擋下的原因，空＝可以發） */
export function qcBlockers(itemCodes: string[], runs: Pick<QcRun, 'analyte' | 'date' | 'at' | 'result'>[], date: string): string[] {
  return itemCodes
    .filter((c) => qcAnalyte(c))
    .flatMap((c) => {
      const st = qcStatusToday(runs, c, date)
      return st === 'missing' ? [`${qcAnalyte(c)!.name}今天還沒做品管`] : st === 'reject' ? [`${qcAnalyte(c)!.name}今天品管被拒絕（要矯正後重做）`] : []
    })
}

/** 登打檢查：兩個濃度都要填數字；同一天上一次被拒絕的，重做要寫矯正措施 */
export function checkQcInput(x: { analyte?: string; values?: (number | string | undefined)[]; correction?: string }, lastToday?: QcResult): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x.analyte || !qcAnalyte(x.analyte)) e.analyte = '請選品管項目'
  ;[0, 1].forEach((i) => {
    const v = Number(x.values?.[i])
    if (x.values?.[i] === undefined || x.values?.[i] === '' || !Number.isFinite(v) || v <= 0) e[`level${i + 1}`] = `請填濃度 ${i + 1} 的品管值`
  })
  if (lastToday === 'reject' && !x.correction?.trim()) e.correction = '上一次品管被拒絕：重做要寫矯正措施（例：重新校正、換新試劑）'
  return e
}
